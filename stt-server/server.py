"""
🎙️ TBB-VaaniAI — STT Server
Streaming Speech-to-Text with Silero VAD + Faster-Whisper.

Accepts raw PCM audio over WebSocket, applies voice activity detection,
and streams back partial/final transcriptions in real-time.

Architecture:
  Browser → [PCM 16kHz 16-bit mono] → WebSocket → Silero VAD → Faster-Whisper → JSON
"""

import os
import io
import json
import time
import asyncio
import logging
import numpy as np
import torch
import soundfile as sf
from typing import Optional
from collections import deque

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
import uvicorn

# ─────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "large-v3-turbo")
WHISPER_LANGUAGE = os.getenv("WHISPER_LANGUAGE", "hi")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cuda" if torch.cuda.is_available() else "cpu")
WHISPER_COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "float16" if WHISPER_DEVICE == "cuda" else "int8")

VAD_THRESHOLD = float(os.getenv("VAD_THRESHOLD", "0.5"))
VAD_MIN_SILENCE_MS = int(os.getenv("VAD_MIN_SILENCE_MS", "300"))
VAD_SPEECH_PAD_MS = int(os.getenv("VAD_SPEECH_PAD_MS", "100"))

SAMPLE_RATE = 16000
CHUNK_SIZE_MS = 30  # 30ms per VAD chunk
CHUNK_SIZE_SAMPLES = int(SAMPLE_RATE * CHUNK_SIZE_MS / 1000)  # 480 samples

HOST = os.getenv("STT_SERVER_HOST", "0.0.0.0")
PORT = int(os.getenv("STT_SERVER_PORT", "8001"))

logging.basicConfig(
    level=getattr(logging, os.getenv("LOG_LEVEL", "INFO")),
    format="%(asctime)s [STT] %(levelname)s %(message)s",
)
logger = logging.getLogger("stt-server")

# ─────────────────────────────────────────────
# Model Loading
# ─────────────────────────────────────────────
logger.info(f"Loading Faster-Whisper model: {WHISPER_MODEL} on {WHISPER_DEVICE} ({WHISPER_COMPUTE_TYPE})")

from faster_whisper import WhisperModel

whisper_model = WhisperModel(
    WHISPER_MODEL,
    device=WHISPER_DEVICE,
    compute_type=WHISPER_COMPUTE_TYPE,
)
logger.info("Faster-Whisper model loaded successfully")

# Load Silero VAD
logger.info("Loading Silero VAD model...")
vad_model, vad_utils = torch.hub.load(
    repo_or_dir="snakers4/silero-vad",
    model="silero_vad",
    force_reload=False,
    onnx=True,
)
(get_speech_timestamps, _, read_audio, _, _) = vad_utils
logger.info("Silero VAD model loaded successfully")


# ─────────────────────────────────────────────
# VAD + Transcription Session
# ─────────────────────────────────────────────
class TranscriptionSession:
    """
    Manages a single WebSocket transcription session.

    Flow:
    1. Receives raw PCM audio chunks from the client
    2. Silero VAD processes each chunk (~30ms) to detect speech
    3. Speech audio is accumulated in a buffer
    4. When silence is detected (speech endpoint), the buffer is
       transcribed by Faster-Whisper
    5. Partial results are sent periodically during speech
    6. Final results are sent when an endpoint is detected
    """

    def __init__(self, session_id: str):
        self.session_id = session_id
        self.audio_buffer: list[np.ndarray] = []
        self.is_speaking = False
        self.silence_counter = 0
        self.speech_counter = 0
        self.partial_timer = 0.0
        self.total_audio_processed = 0.0

        # How many silence chunks before we consider speech ended
        self.min_silence_chunks = int(VAD_MIN_SILENCE_MS / CHUNK_SIZE_MS)
        # How many speech chunks to pad before/after speech
        self.speech_pad_chunks = int(VAD_SPEECH_PAD_MS / CHUNK_SIZE_MS)
        # Pre-speech buffer for capturing the start of speech
        self.pre_speech_buffer: deque[np.ndarray] = deque(maxlen=self.speech_pad_chunks)

        # Reset VAD state for this session
        vad_model.reset_states()

    def process_vad_chunk(self, audio_chunk: np.ndarray) -> Optional[str]:
        """
        Process a single audio chunk through VAD.
        Returns:
            "speech_start" - speech just started
            "speech_end"   - speech just ended (endpoint detected)
            "speaking"     - still in speech
            None           - silence
        """
        # Convert to torch tensor for VAD
        tensor = torch.from_numpy(audio_chunk).float()
        if tensor.dim() == 1:
            tensor = tensor.unsqueeze(0)

        # Get speech probability
        speech_prob = vad_model(tensor, SAMPLE_RATE).item()

        if speech_prob >= VAD_THRESHOLD:
            self.silence_counter = 0
            self.speech_counter += 1

            if not self.is_speaking:
                self.is_speaking = True
                # Include pre-speech buffer
                self.audio_buffer = list(self.pre_speech_buffer)
                self.audio_buffer.append(audio_chunk)
                return "speech_start"
            else:
                self.audio_buffer.append(audio_chunk)
                return "speaking"
        else:
            # Silence
            self.pre_speech_buffer.append(audio_chunk)

            if self.is_speaking:
                self.silence_counter += 1
                self.audio_buffer.append(audio_chunk)  # Include trailing silence

                if self.silence_counter >= self.min_silence_chunks:
                    # Speech endpoint detected
                    self.is_speaking = False
                    self.speech_counter = 0
                    self.silence_counter = 0
                    return "speech_end"
                return "speaking"

            return None

    def get_buffered_audio(self) -> Optional[np.ndarray]:
        """Get accumulated audio buffer and clear it."""
        if not self.audio_buffer:
            return None

        audio = np.concatenate(self.audio_buffer)
        self.audio_buffer = []
        return audio

    def transcribe(self, audio: np.ndarray) -> dict:
        """
        Transcribe audio using Faster-Whisper.
        Returns a dict with transcription results.
        """
        start_time = time.perf_counter()

        # Normalize audio to float32 [-1, 1]
        if audio.dtype == np.int16:
            audio = audio.astype(np.float32) / 32768.0
        elif audio.dtype != np.float32:
            audio = audio.astype(np.float32)

        segments, info = whisper_model.transcribe(
            audio,
            language=WHISPER_LANGUAGE,
            beam_size=1,  # Greedy for speed
            vad_filter=False,  # We handle VAD ourselves
            without_timestamps=True,
        )

        text_parts = []
        for segment in segments:
            text_parts.append(segment.text.strip())

        text = " ".join(text_parts).strip()
        elapsed_ms = (time.perf_counter() - start_time) * 1000

        duration_s = len(audio) / SAMPLE_RATE
        self.total_audio_processed += duration_s

        result = {
            "text": text,
            "language": info.language if info else WHISPER_LANGUAGE,
            "language_probability": round(info.language_probability, 3) if info else 0.0,
            "transcription_ms": round(elapsed_ms, 1),
            "audio_duration_ms": round(duration_s * 1000, 1),
        }

        logger.info(
            f"[{self.session_id}] Transcribed {duration_s:.1f}s audio "
            f"in {elapsed_ms:.0f}ms: \"{text[:80]}{'...' if len(text) > 80 else ''}\""
        )

        return result


# ─────────────────────────────────────────────
# FastAPI Application
# ─────────────────────────────────────────────
app = FastAPI(
    title="VaaniAI STT Server",
    description="Streaming Speech-to-Text with Silero VAD + Faster-Whisper",
    version="1.0.0",
)


@app.get("/health")
async def health_check():
    """Health check endpoint for Docker/orchestrator readiness probes."""
    return JSONResponse({
        "status": "healthy",
        "service": "stt-server",
        "model": WHISPER_MODEL,
        "device": WHISPER_DEVICE,
        "language": WHISPER_LANGUAGE,
        "vad_threshold": VAD_THRESHOLD,
    })


@app.get("/info")
async def model_info():
    """Return model configuration details."""
    return JSONResponse({
        "whisper_model": WHISPER_MODEL,
        "whisper_device": WHISPER_DEVICE,
        "whisper_compute_type": WHISPER_COMPUTE_TYPE,
        "whisper_language": WHISPER_LANGUAGE,
        "vad_threshold": VAD_THRESHOLD,
        "vad_min_silence_ms": VAD_MIN_SILENCE_MS,
        "vad_speech_pad_ms": VAD_SPEECH_PAD_MS,
        "sample_rate": SAMPLE_RATE,
        "chunk_size_ms": CHUNK_SIZE_MS,
    })


@app.websocket("/ws/transcribe")
async def websocket_transcribe(ws: WebSocket):
    """
    WebSocket endpoint for streaming transcription.

    Protocol:
    - Client sends: raw PCM audio bytes (16kHz, 16-bit mono, little-endian)
    - Server sends: JSON messages:
        {"type": "speech_start"}
        {"type": "partial", "text": "...", ...}
        {"type": "final", "text": "...", ...}
        {"type": "speech_end"}
        {"type": "error", "message": "..."}
    - Client can send: JSON control messages:
        {"type": "config", "language": "hi", "vad_threshold": 0.5}
        {"type": "reset"}
    """
    await ws.accept()

    session_id = f"sess_{id(ws) % 10000:04d}"
    session = TranscriptionSession(session_id)
    logger.info(f"[{session_id}] WebSocket connected")

    # Partial transcription interval (send partials every 500ms of speech)
    PARTIAL_INTERVAL_MS = 500
    last_partial_time = 0.0

    try:
        while True:
            data = await ws.receive()

            # Handle text messages (control commands)
            if "text" in data:
                try:
                    msg = json.loads(data["text"])
                    msg_type = msg.get("type", "")

                    if msg_type == "reset":
                        session = TranscriptionSession(session_id)
                        vad_model.reset_states()
                        await ws.send_json({"type": "reset_ack"})
                        logger.info(f"[{session_id}] Session reset")

                    elif msg_type == "config":
                        # Runtime configuration update
                        logger.info(f"[{session_id}] Config update: {msg}")
                        await ws.send_json({"type": "config_ack"})

                    elif msg_type == "ping":
                        await ws.send_json({"type": "pong", "timestamp": time.time()})

                except json.JSONDecodeError:
                    pass
                continue

            # Handle binary messages (audio data)
            if "bytes" not in data:
                continue

            raw_bytes = data["bytes"]
            if not raw_bytes:
                continue

            # Convert raw PCM bytes to numpy array (16-bit signed int)
            audio_data = np.frombuffer(raw_bytes, dtype=np.int16).astype(np.float32) / 32768.0

            # Process in VAD-sized chunks
            offset = 0
            while offset + CHUNK_SIZE_SAMPLES <= len(audio_data):
                chunk = audio_data[offset : offset + CHUNK_SIZE_SAMPLES]
                offset += CHUNK_SIZE_SAMPLES

                vad_result = session.process_vad_chunk(chunk)

                if vad_result == "speech_start":
                    await ws.send_json({
                        "type": "speech_start",
                        "timestamp": time.time(),
                    })
                    last_partial_time = time.time()
                    logger.debug(f"[{session_id}] Speech started")

                elif vad_result == "speech_end":
                    # Transcribe the full speech segment
                    audio = session.get_buffered_audio()
                    if audio is not None and len(audio) > CHUNK_SIZE_SAMPLES:
                        result = session.transcribe(audio)
                        if result["text"]:
                            await ws.send_json({
                                "type": "final",
                                **result,
                                "timestamp": time.time(),
                            })
                    await ws.send_json({
                        "type": "speech_end",
                        "timestamp": time.time(),
                    })
                    vad_model.reset_states()
                    logger.debug(f"[{session_id}] Speech ended")

                elif vad_result == "speaking":
                    # Send partial transcription periodically
                    now = time.time()
                    if (now - last_partial_time) * 1000 >= PARTIAL_INTERVAL_MS:
                        audio = session.get_buffered_audio()
                        if audio is not None and len(audio) > CHUNK_SIZE_SAMPLES * 3:
                            result = session.transcribe(audio)
                            if result["text"]:
                                await ws.send_json({
                                    "type": "partial",
                                    **result,
                                    "timestamp": time.time(),
                                })
                            # Put audio back for the final transcription
                            session.audio_buffer = [audio]
                        last_partial_time = now

    except WebSocketDisconnect:
        logger.info(f"[{session_id}] WebSocket disconnected")
    except Exception as e:
        logger.error(f"[{session_id}] Error: {e}", exc_info=True)
        try:
            await ws.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
    finally:
        logger.info(
            f"[{session_id}] Session ended. "
            f"Total audio processed: {session.total_audio_processed:.1f}s"
        )


# ─────────────────────────────────────────────
# Entry Point
# ─────────────────────────────────────────────
if __name__ == "__main__":
    logger.info(f"Starting STT server on {HOST}:{PORT}")
    uvicorn.run(
        app,
        host=HOST,
        port=PORT,
        log_level="info",
        ws_ping_interval=20,
        ws_ping_timeout=20,
    )
