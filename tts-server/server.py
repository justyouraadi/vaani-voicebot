"""
🗣️ TBB-VaaniAI — TTS Server
Streaming Text-to-Speech with XTTS v2 and voice cloning.

Accepts text via HTTP POST, returns streaming audio chunks.
Supports voice cloning from reference audio files.

Architecture:
  Orchestrator → [Text + Language] → HTTP POST → XTTS v2 → [Streaming PCM/WAV] → Response
"""

import os
import io
import time
import wave
import struct
import logging
import numpy as np
import subprocess
import time
import asyncio
import logging
import torch
from pathlib import Path
from typing import Optional

# [WORKAROUND] Monkeypatch for transformers >= 4.40 breaking older Coqui TTS
import transformers.pytorch_utils
if not hasattr(transformers.pytorch_utils, 'isin_mps_friendly'):
    transformers.pytorch_utils.isin_mps_friendly = lambda *args, **kwargs: False

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel
import uvicorn

# ─────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────
XTTS_MODEL = os.getenv("XTTS_MODEL", "tts_models/multilingual/multi-dataset/xtts_v2")
XTTS_VOICE = os.getenv("XTTS_VOICE", "vaani_default.wav")
XTTS_LANGUAGE = os.getenv("XTTS_LANGUAGE", "hi")
XTTS_DEVICE = os.getenv("XTTS_DEVICE", "cuda" if torch.cuda.is_available() else "cpu")

VOICES_DIR = Path(os.getenv("VOICES_DIR", "/app/voices"))
HOST = os.getenv("TTS_SERVER_HOST", "0.0.0.0")
PORT = int(os.getenv("TTS_SERVER_PORT", "8002"))

# Output audio config
OUTPUT_SAMPLE_RATE = 24000  # XTTS v2 outputs 24kHz
OUTPUT_CHANNELS = 1

logging.basicConfig(
    level=getattr(logging, os.getenv("LOG_LEVEL", "INFO")),
    format="%(asctime)s [TTS] %(levelname)s %(message)s",
)
logger = logging.getLogger("tts-server")

# ─────────────────────────────────────────────
# Model Loading
# ─────────────────────────────────────────────
logger.info(f"Loading XTTS v2 model on {XTTS_DEVICE}...")

from TTS.tts.configs.xtts_config import XttsConfig
from TTS.tts.models.xtts import Xtts
from TTS.utils.manage import ModelManager

# Use the TTS API to download and load the model
tts_model = None
gpt_cond_latent = None
speaker_embedding = None


def load_model():
    """Load the XTTS v2 model and compute speaker embeddings."""
    global tts_model, gpt_cond_latent, speaker_embedding

    try:
        from TTS.api import TTS

        tts = TTS(XTTS_MODEL)

        # Access the underlying XTTS model for streaming
        tts_model = tts.synthesizer.tts_model
        tts_model.to(XTTS_DEVICE)

        # Load reference voice for cloning
        voice_path = VOICES_DIR / XTTS_VOICE
        if voice_path.exists():
            logger.info(f"Loading reference voice: {voice_path}")
            gpt_cond_latent, speaker_embedding = tts_model.get_conditioning_latents(
                audio_path=[str(voice_path)]
            )
            logger.info("Reference voice embeddings computed successfully")
        else:
            logger.warning(
                f"Reference voice not found: {voice_path}. "
                f"Available voices: {list(VOICES_DIR.glob('*.wav'))}"
            )
            # Use a default/random embedding - will sound generic but functional
            logger.info("Using default speaker embedding (no voice cloning)")
            gpt_cond_latent = None
            speaker_embedding = None

        logger.info("XTTS v2 model loaded successfully")

    except Exception as e:
        logger.error(f"Failed to load XTTS v2 model: {e}", exc_info=True)
        raise


# Load model at startup
load_model()


# ─────────────────────────────────────────────
# Request/Response Models
# ─────────────────────────────────────────────
class SynthesizeRequest(BaseModel):
    text: str
    language: str = XTTS_LANGUAGE
    voice: Optional[str] = None  # Override reference voice
    speed: float = 1.0
    stream: bool = True  # Enable streaming by default


class SynthesizeInfo(BaseModel):
    text: str
    language: str
    voice: str
    duration_ms: float
    synthesis_ms: float
    sample_rate: int
    streaming: bool


# ─────────────────────────────────────────────
# Audio Utilities
# ─────────────────────────────────────────────
def numpy_to_wav_bytes(audio_np: np.ndarray, sample_rate: int = OUTPUT_SAMPLE_RATE) -> bytes:
    """Convert numpy float32 audio to WAV bytes."""
    # Normalize and convert to int16
    audio_int16 = np.clip(audio_np * 32767, -32768, 32767).astype(np.int16)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(OUTPUT_CHANNELS)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(sample_rate)
        wf.writeframes(audio_int16.tobytes())

    return buf.getvalue()


def numpy_to_pcm_bytes(audio_np: np.ndarray) -> bytes:
    """Convert numpy float32 audio to raw PCM int16 bytes."""
    audio_int16 = np.clip(audio_np * 32767, -32768, 32767).astype(np.int16)
    return audio_int16.tobytes()


# ─────────────────────────────────────────────
# FastAPI Application
# ─────────────────────────────────────────────
app = FastAPI(
    title="VaaniAI TTS Server",
    description="Streaming Text-to-Speech with XTTS v2 and voice cloning",
    version="1.0.0",
)


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return JSONResponse({
        "status": "healthy" if tts_model is not None else "degraded",
        "service": "tts-server",
        "model": XTTS_MODEL,
        "device": XTTS_DEVICE,
        "default_language": XTTS_LANGUAGE,
        "voice_cloning": gpt_cond_latent is not None,
        "output_sample_rate": OUTPUT_SAMPLE_RATE,
    })


@app.get("/voices")
async def list_voices():
    """List available reference voice files."""
    voices = []
    if VOICES_DIR.exists():
        for f in VOICES_DIR.glob("*.wav"):
            voices.append({
                "name": f.stem,
                "filename": f.name,
                "size_bytes": f.stat().st_size,
            })
    return JSONResponse({"voices": voices, "default": XTTS_VOICE})


@app.post("/voices")
async def upload_voice(file: UploadFile = File(...)):
    """Upload a new reference voice file and convert it for XTTS."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")
    
    # Secure filename
    safe_name = file.filename.replace(" ", "_").lower()
    base_name = Path(safe_name).stem
    final_filename = f"{base_name}.wav"
    
    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    temp_path = VOICES_DIR / f"temp_{safe_name}"
    final_path = VOICES_DIR / final_filename
    
    try:
        # Save uploaded file
        with open(temp_path, "wb") as buffer:
            buffer.write(await file.read())
            
        # Convert to 24kHz Mono 16-bit PCM WAV using ffmpeg
        logger.info(f"Converting uploaded voice {safe_name} to {final_filename}...")
        cmd = [
            "ffmpeg", "-y", "-i", str(temp_path),
            "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le",
            str(final_path)
        ]
        
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            logger.error(f"FFmpeg error: {result.stderr}")
            raise HTTPException(status_code=500, detail="Audio conversion failed")
            
        logger.info(f"Successfully processed voice clone: {final_filename}")
        
        # Pre-compute and cache the embeddings for this new voice
        if tts_model is not None:
            tts_model.get_conditioning_latents(audio_path=[str(final_path)])
            
        return JSONResponse({"status": "success", "filename": final_filename})
        
    except Exception as e:
        logger.error(f"Error processing upload: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if temp_path.exists():
            temp_path.unlink()

@app.post("/synthesize")
async def synthesize(request: SynthesizeRequest):
    """
    Synthesize speech from text.

    Streaming mode (default): Returns chunked audio as the model generates it.
    Non-streaming mode: Returns complete WAV file.

    Each streamed chunk is a raw PCM int16 audio fragment at 24kHz.
    The first chunk includes a small WAV header for playback compatibility.
    """
    if tts_model is None:
        raise HTTPException(status_code=503, detail="TTS model not loaded")

    if not request.text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    logger.info(
        f"Synthesize request: \"{request.text[:80]}{'...' if len(request.text) > 80 else ''}\" "
        f"(lang={request.language}, stream={request.stream})"
    )

    # Resolve voice embeddings
    current_gpt_cond = gpt_cond_latent
    current_speaker_emb = speaker_embedding

    if request.voice and request.voice != XTTS_VOICE:
        voice_path = VOICES_DIR / request.voice
        if voice_path.exists():
            current_gpt_cond, current_speaker_emb = tts_model.get_conditioning_latents(
                audio_path=[str(voice_path)]
            )
        else:
            logger.warning(f"Requested voice not found: {request.voice}, using default")

    if request.stream:
        return StreamingResponse(
            _stream_synthesis(request.text, request.language, current_gpt_cond, current_speaker_emb, request.speed),
            media_type="audio/pcm",
            headers={
                "X-Sample-Rate": str(OUTPUT_SAMPLE_RATE),
                "X-Channels": str(OUTPUT_CHANNELS),
                "X-Bit-Depth": "16",
                "Transfer-Encoding": "chunked",
            },
        )
    else:
        return await _full_synthesis(request.text, request.language, current_gpt_cond, current_speaker_emb, request.speed)


async def _stream_synthesis(
    text: str,
    language: str,
    gpt_cond: Optional[torch.Tensor],
    speaker_emb: Optional[torch.Tensor],
    speed: float,
):
    """
    Generator that yields audio chunks as XTTS v2 generates them.
    Time-to-first-chunk target: ~200ms on GPU.
    """
    start_time = time.perf_counter()
    total_samples = 0
    chunk_count = 0
    first_chunk_time = None

    try:
        if gpt_cond is not None and speaker_emb is not None:
            # Streaming inference with voice cloning
            chunks = tts_model.inference_stream(
                text,
                language,
                gpt_cond,
                speaker_emb,
                speed=speed,
                enable_text_splitting=True,
            )
        else:
            # Fallback: full inference without cloning (no streaming possible without embeddings)
            logger.warning("No voice embeddings available, using full synthesis")
            result = tts_model.inference(
                text,
                language,
                gpt_cond_latent=None,
                speaker_embedding=None,
            )
            audio = result["wav"]
            audio_np = audio.cpu().numpy() if isinstance(audio, torch.Tensor) else np.array(audio)
            yield numpy_to_pcm_bytes(audio_np)
            return

        for chunk in chunks:
            if isinstance(chunk, torch.Tensor):
                audio_np = chunk.cpu().numpy().squeeze()
            else:
                audio_np = np.array(chunk).squeeze()

            if audio_np.size == 0:
                continue

            chunk_count += 1
            total_samples += len(audio_np)

            if first_chunk_time is None:
                first_chunk_time = (time.perf_counter() - start_time) * 1000
                logger.info(f"TTS first chunk in {first_chunk_time:.0f}ms ({len(audio_np)} samples)")

            yield numpy_to_pcm_bytes(audio_np)

    except Exception as e:
        logger.error(f"Streaming synthesis error: {e}", exc_info=True)
        raise

    finally:
        elapsed_ms = (time.perf_counter() - start_time) * 1000
        duration_ms = (total_samples / OUTPUT_SAMPLE_RATE) * 1000 if total_samples > 0 else 0
        rtf = elapsed_ms / duration_ms if duration_ms > 0 else 0

        logger.info(
            f"TTS complete: {chunk_count} chunks, "
            f"{duration_ms:.0f}ms audio in {elapsed_ms:.0f}ms "
            f"(RTF={rtf:.2f}, TTFC={first_chunk_time:.0f}ms)"
        )


async def _full_synthesis(
    text: str,
    language: str,
    gpt_cond: Optional[torch.Tensor],
    speaker_emb: Optional[torch.Tensor],
    speed: float,
):
    """Full (non-streaming) synthesis returning a complete WAV file."""
    start_time = time.perf_counter()

    if gpt_cond is not None and speaker_emb is not None:
        result = tts_model.inference(
            text,
            language,
            gpt_cond_latent=gpt_cond,
            speaker_embedding=speaker_emb,
            speed=speed,
        )
    else:
        result = tts_model.inference(text, language)

    audio = result["wav"]
    if isinstance(audio, torch.Tensor):
        audio_np = audio.cpu().numpy().squeeze()
    else:
        audio_np = np.array(audio).squeeze()

    elapsed_ms = (time.perf_counter() - start_time) * 1000
    duration_ms = (len(audio_np) / OUTPUT_SAMPLE_RATE) * 1000

    logger.info(f"TTS full synthesis: {duration_ms:.0f}ms audio in {elapsed_ms:.0f}ms")

    wav_bytes = numpy_to_wav_bytes(audio_np)

    return StreamingResponse(
        io.BytesIO(wav_bytes),
        media_type="audio/wav",
        headers={
            "X-Synthesis-Ms": str(round(elapsed_ms, 1)),
            "X-Audio-Duration-Ms": str(round(duration_ms, 1)),
            "X-Sample-Rate": str(OUTPUT_SAMPLE_RATE),
        },
    )


# ─────────────────────────────────────────────
# Entry Point
# ─────────────────────────────────────────────
if __name__ == "__main__":
    logger.info(f"Starting TTS server on {HOST}:{PORT}")
    uvicorn.run(
        app,
        host=HOST,
        port=PORT,
        log_level="info",
    )
