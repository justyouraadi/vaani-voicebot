"""
🎙️ TBB-VaaniAI — Local Dev STT Server (Mac-friendly)
Lightweight version using openai-whisper (base model) on CPU.
Falls back to a mock if whisper isn't available.

For production, use the full stt-server/ with faster-whisper + Silero VAD.
"""

import os
import io
import json
import time
import asyncio
import logging
import subprocess
import tempfile
import wave
import struct
import numpy as np
from typing import Optional
from collections import deque

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
import uvicorn

# ─────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base")
WHISPER_LANGUAGE = os.getenv("WHISPER_LANGUAGE", "hi")
SAMPLE_RATE = 16000
HOST = os.getenv("STT_SERVER_HOST", "0.0.0.0")
PORT = int(os.getenv("STT_SERVER_PORT", "8001"))

# Energy-based VAD settings
VAD_ENERGY_THRESHOLD = float(os.getenv("VAD_ENERGY_THRESHOLD", "300"))
VAD_MIN_SILENCE_MS = int(os.getenv("VAD_MIN_SILENCE_MS", "500"))
VAD_SPEECH_PAD_MS = int(os.getenv("VAD_SPEECH_PAD_MS", "200"))

logging.basicConfig(
    level=getattr(logging, os.getenv("LOG_LEVEL", "INFO")),
    format="%(asctime)s [STT-Dev] %(levelname)s %(message)s",
)
logger = logging.getLogger("stt-dev")

# ─────────────────────────────────────────────
# Model Loading (with graceful fallback)
# ─────────────────────────────────────────────
whisper_model = None
USE_MOCK = False

try:
    import whisper
    logger.info(f"Loading OpenAI Whisper model: {WHISPER_MODEL} (CPU)")
    whisper_model = whisper.load_model(WHISPER_MODEL, device="cpu")
    logger.info("Whisper model loaded successfully")
except ImportError:
    logger.warning("openai-whisper not installed. Trying faster-whisper...")
    try:
        from faster_whisper import WhisperModel
        logger.info(f"Loading Faster-Whisper model: {WHISPER_MODEL} (CPU)")
        whisper_model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
        logger.info("Faster-Whisper model loaded")
    except ImportError:
        logger.warning("No whisper implementation found. Using MOCK mode.")
        logger.warning("Install: pip install openai-whisper  OR  pip install faster-whisper")
        USE_MOCK = True


def transcribe_audio(audio_np: np.ndarray) -> dict:
    """Transcribe audio using whichever whisper backend is available."""
    start_time = time.perf_counter()

    if USE_MOCK:
        # Mock transcription for testing the pipeline
        time.sleep(0.1)  # Simulate processing
        elapsed_ms = (time.perf_counter() - start_time) * 1000
        return {
            "text": "[Mock STT] Audio received — install openai-whisper for real transcription",
            "language": WHISPER_LANGUAGE,
            "language_probability": 0.0,
            "transcription_ms": round(elapsed_ms, 1),
            "audio_duration_ms": round(len(audio_np) / SAMPLE_RATE * 1000, 1),
        }

    # Normalize to float32 [-1, 1]
    if audio_np.dtype == np.int16:
        audio_float = audio_np.astype(np.float32) / 32768.0
    elif audio_np.dtype != np.float32:
        audio_float = audio_np.astype(np.float32)
    else:
        audio_float = audio_np

    text = ""
    lang = WHISPER_LANGUAGE
    lang_prob = 0.0

    # Check which backend we have
    if type(whisper_model).__name__ == "WhisperModel":
        # faster-whisper
        segments, info = whisper_model.transcribe(
            audio_float,
            language=WHISPER_LANGUAGE,
            beam_size=1,
            vad_filter=False,
            without_timestamps=True,
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()
        lang = info.language if info else WHISPER_LANGUAGE
        lang_prob = round(info.language_probability, 3) if info else 0.0
    else:
        # openai-whisper
        result = whisper_model.transcribe(
            audio_float,
            language=WHISPER_LANGUAGE,
            fp16=False,
        )
        text = result.get("text", "").strip()
        lang = result.get("language", WHISPER_LANGUAGE)

    elapsed_ms = (time.perf_counter() - start_time) * 1000
    duration_ms = len(audio_np) / SAMPLE_RATE * 1000

    logger.info(f"Transcribed {duration_ms:.0f}ms audio in {elapsed_ms:.0f}ms: \"{text[:80]}\"")

    return {
        "text": text,
        "language": lang,
        "language_probability": lang_prob,
        "transcription_ms": round(elapsed_ms, 1),
        "audio_duration_ms": round(duration_ms, 1),
    }


# ─────────────────────────────────────────────
# Simple Energy-Based VAD
# ─────────────────────────────────────────────
class SimpleVAD:
    """Energy-based VAD that works on any platform without torch."""

    def __init__(self):
        self.threshold = VAD_ENERGY_THRESHOLD
        self.min_silence_chunks = int(VAD_MIN_SILENCE_MS / 30)  # 30ms per chunk
        self.speech_pad_chunks = int(VAD_SPEECH_PAD_MS / 30)
        self.is_speaking = False
        self.silence_count = 0
        self.pre_buffer = deque(maxlen=self.speech_pad_chunks)

    def process(self, chunk: np.ndarray) -> Optional[str]:
        """Returns 'speech_start', 'speech_end', 'speaking', or None."""
        rms = np.sqrt(np.mean(chunk.astype(np.float64) ** 2))

        if rms >= self.threshold:
            self.silence_count = 0
            if not self.is_speaking:
                self.is_speaking = True
                return "speech_start"
            return "speaking"
        else:
            self.pre_buffer.append(chunk)
            if self.is_speaking:
                self.silence_count += 1
                if self.silence_count >= self.min_silence_chunks:
                    self.is_speaking = False
                    self.silence_count = 0
                    return "speech_end"
                return "speaking"
            return None


# ─────────────────────────────────────────────
# FastAPI Application
# ─────────────────────────────────────────────
app = FastAPI(title="VaaniAI STT Server (Dev)", version="1.0.0-dev")


@app.get("/health")
async def health():
    return JSONResponse({
        "status": "healthy",
        "service": "stt-server-dev",
        "model": WHISPER_MODEL if not USE_MOCK else "MOCK",
        "device": "cpu",
        "language": WHISPER_LANGUAGE,
        "mock_mode": USE_MOCK,
    })


@app.websocket("/ws/transcribe")
async def ws_transcribe(ws: WebSocket):
    await ws.accept()
    session_id = f"dev_{id(ws) % 10000:04d}"
    logger.info(f"[{session_id}] Connected")

    vad = SimpleVAD()
    audio_buffer: list[np.ndarray] = []
    CHUNK_SAMPLES = int(SAMPLE_RATE * 0.03)  # 30ms

    try:
        while True:
            data = await ws.receive()

            if "text" in data:
                try:
                    msg = json.loads(data["text"])
                    if msg.get("type") == "ping":
                        await ws.send_json({"type": "pong", "timestamp": time.time()})
                    elif msg.get("type") == "reset":
                        vad = SimpleVAD()
                        audio_buffer = []
                        await ws.send_json({"type": "reset_ack"})
                except json.JSONDecodeError:
                    pass
                continue

            if "bytes" not in data or not data["bytes"]:
                continue

            # Parse PCM int16 audio
            raw = data["bytes"]
            samples = np.frombuffer(raw, dtype=np.int16)

            # Process in 30ms chunks through VAD
            offset = 0
            while offset + CHUNK_SAMPLES <= len(samples):
                chunk = samples[offset:offset + CHUNK_SAMPLES]
                offset += CHUNK_SAMPLES

                result = vad.process(chunk.astype(np.float32))

                if result == "speech_start":
                    audio_buffer = [chunk]
                    await ws.send_json({"type": "speech_start", "timestamp": time.time()})

                elif result == "speaking":
                    audio_buffer.append(chunk)

                elif result == "speech_end":
                    audio_buffer.append(chunk)
                    if audio_buffer:
                        full_audio = np.concatenate(audio_buffer)
                        if len(full_audio) > CHUNK_SAMPLES * 3:
                            # Transcribe in a thread to not block WebSocket
                            loop = asyncio.get_event_loop()
                            transcription = await loop.run_in_executor(
                                None, transcribe_audio, full_audio
                            )
                            if transcription["text"]:
                                await ws.send_json({
                                    "type": "final",
                                    **transcription,
                                    "timestamp": time.time(),
                                })
                    audio_buffer = []
                    await ws.send_json({"type": "speech_end", "timestamp": time.time()})

    except WebSocketDisconnect:
        logger.info(f"[{session_id}] Disconnected")
    except Exception as e:
        logger.error(f"[{session_id}] Error: {e}", exc_info=True)


if __name__ == "__main__":
    logger.info(f"Starting DEV STT server on {HOST}:{PORT}")
    logger.info(f"Model: {WHISPER_MODEL} | Mock: {USE_MOCK}")
    uvicorn.run(app, host=HOST, port=PORT, log_level="info", ws_ping_interval=20, ws_ping_timeout=20)
