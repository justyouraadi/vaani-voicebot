"""
🗣️ TBB-VaaniAI — Local Dev TTS Server (Mac-friendly)
Uses macOS `say` command as TTS fallback, or edge-tts for better quality.
No GPU or heavy ML models required.

For production, use the full tts-server/ with XTTS v2.
"""

import os
import io
import time
import wave
import asyncio
import logging
import subprocess
import tempfile
import struct
import numpy as np
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel
import uvicorn

# ─────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────
HOST = os.getenv("TTS_SERVER_HOST", "0.0.0.0")
PORT = int(os.getenv("TTS_SERVER_PORT", "8002"))
OUTPUT_SAMPLE_RATE = 24000  # Match production TTS output rate

logging.basicConfig(
    level=getattr(logging, os.getenv("LOG_LEVEL", "INFO")),
    format="%(asctime)s [TTS-Dev] %(levelname)s %(message)s",
)
logger = logging.getLogger("tts-dev")

# ─────────────────────────────────────────────
# TTS Backend Selection
# ─────────────────────────────────────────────
TTS_BACKEND = "none"

# Try ElevenLabs first if API key is present
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY")
ELEVENLABS_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID")

if ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID:
    TTS_BACKEND = "elevenlabs"
    import httpx
    logger.info("Using ElevenLabs backend for ultra-low latency voice cloning")
else:
    # Try edge-tts next
    try:
        import edge_tts
        TTS_BACKEND = "edge-tts"
        logger.info("Using edge-tts backend (Microsoft Edge voices)")
    except ImportError:
        pass

# Fallback: macOS `say` command
if TTS_BACKEND == "none":
    say_path = "/usr/bin/say"
    if os.path.exists(say_path):
        TTS_BACKEND = "macos-say"
        logger.info("Using macOS `say` command as TTS backend")
    else:
        TTS_BACKEND = "mock"
        logger.warning("No TTS backend available. Using silent mock mode.")
        logger.warning("Install: pip install edge-tts")

logger.info(f"TTS Backend: {TTS_BACKEND}")

# Voice mapping
EDGE_VOICES = {
    "hi": "hi-IN-SwaraNeural",       # Hindi female
    "hi-male": "hi-IN-MadhurNeural",   # Hindi male
    "en": "en-US-JennyNeural",         # English female
}


# ─────────────────────────────────────────────
# Request Model
# ─────────────────────────────────────────────
class SynthesizeRequest(BaseModel):
    text: str
    language: str = "hi"
    voice: Optional[str] = None
    speed: float = 1.0
    stream: bool = True


# ─────────────────────────────────────────────
# TTS Engines
# ─────────────────────────────────────────────
async def synthesize_edge_tts(text: str, language: str, speed: float):
    """Use edge-tts for high-quality streaming TTS."""
    voice = EDGE_VOICES.get(language, EDGE_VOICES["hi"])

    # edge-tts rate adjustment: +/- percentage
    rate_str = f"+{int((speed - 1) * 100)}%" if speed >= 1 else f"{int((speed - 1) * 100)}%"

    communicate = edge_tts.Communicate(text=text, voice=voice, rate=rate_str)

    # edge-tts streams MP3, we need to yield it and let the client handle it
    # For PCM output, we'll collect and convert
    audio_chunks = []
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio_chunks.append(chunk["data"])

    if not audio_chunks:
        return

    # Combine all MP3 chunks
    mp3_data = b"".join(audio_chunks)

    # Convert MP3 to PCM using ffmpeg
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-i", "pipe:0",
            "-f", "s16le", "-acodec", "pcm_s16le",
            "-ar", str(OUTPUT_SAMPLE_RATE), "-ac", "1",
            "pipe:1",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        pcm_data, stderr = await proc.communicate(input=mp3_data)

        if pcm_data:
            # Yield in chunks for streaming feel
            chunk_size = OUTPUT_SAMPLE_RATE * 2 // 10  # 100ms chunks (16-bit = 2 bytes/sample)
            for i in range(0, len(pcm_data), chunk_size):
                yield pcm_data[i:i + chunk_size]
    except FileNotFoundError:
        logger.error("ffmpeg not found. Install: brew install ffmpeg")
        # Fallback: generate silence
        yield generate_silence(0.5)


async def synthesize_elevenlabs(text: str):
    """Use ElevenLabs API for low-latency voice cloning streaming."""
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}/stream?output_format=pcm_24000"
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json"
    }
    payload = {
        "text": text,
        "model_id": "eleven_multilingual_v2",
    }
    
    # We use a context manager to handle the streaming response cleanly
    async with httpx.AsyncClient() as client:
        try:
            async with client.stream("POST", url, json=payload, headers=headers, timeout=10.0) as response:
                if response.status_code != 200:
                    body = await response.aread()
                    logger.error(f"ElevenLabs error {response.status_code}: {body.decode()}")
                    yield generate_silence(0.5)
                    return
                
                async for chunk in response.aiter_bytes(chunk_size=4096):
                    if chunk:
                        yield chunk
        except Exception as e:
            logger.error(f"ElevenLabs streaming error: {e}")
            yield generate_silence(0.5)


def synthesize_macos_say(text: str, language: str, speed: float) -> bytes:
    """Use macOS `say` for basic TTS."""
    with tempfile.NamedTemporaryFile(suffix=".aiff", delete=False) as tmp:
        tmp_path = tmp.name

    try:
        # macOS say command
        voice = "Lekha" if language == "hi" else "Samantha"
        rate_wpm = int(200 * speed)

        subprocess.run(
            ["say", "-v", voice, "-r", str(rate_wpm), "-o", tmp_path, "--", text],
            capture_output=True, timeout=10,
        )

        # Convert AIFF to PCM using ffmpeg
        result = subprocess.run(
            ["ffmpeg", "-i", tmp_path,
             "-f", "s16le", "-acodec", "pcm_s16le",
             "-ar", str(OUTPUT_SAMPLE_RATE), "-ac", "1",
             "pipe:1"],
            capture_output=True, timeout=10,
        )

        return result.stdout if result.stdout else generate_silence(0.5)

    except Exception as e:
        logger.error(f"macOS say error: {e}")
        return generate_silence(0.5)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def generate_silence(duration_s: float) -> bytes:
    """Generate silent PCM audio."""
    n_samples = int(OUTPUT_SAMPLE_RATE * duration_s)
    return b'\x00\x00' * n_samples


# ─────────────────────────────────────────────
# FastAPI Application
# ─────────────────────────────────────────────
app = FastAPI(title="VaaniAI TTS Server (Dev)", version="1.0.0-dev")


@app.get("/health")
async def health():
    return JSONResponse({
        "status": "healthy",
        "service": "tts-server-dev",
        "backend": TTS_BACKEND,
        "output_sample_rate": OUTPUT_SAMPLE_RATE,
    })


@app.get("/voices")
async def list_voices():
    if TTS_BACKEND == "edge-tts":
        return JSONResponse({"voices": list(EDGE_VOICES.keys()), "backend": "edge-tts"})
    elif TTS_BACKEND == "macos-say":
        return JSONResponse({"voices": ["Lekha (Hindi)", "Samantha (English)"], "backend": "macos-say"})
    return JSONResponse({"voices": [], "backend": "mock"})


@app.post("/synthesize")
async def synthesize(request: SynthesizeRequest):
    if not request.text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    logger.info(f"Synthesize: \"{request.text[:80]}\" (backend={TTS_BACKEND}, lang={request.language})")

    start_time = time.perf_counter()

    if TTS_BACKEND == "elevenlabs":
        async def stream_gen():
            first = True
            async for chunk in synthesize_elevenlabs(request.text):
                if first:
                    ttfc = (time.perf_counter() - start_time) * 1000
                    logger.info(f"TTS first chunk in {ttfc:.0f}ms")
                    first = False
                yield chunk

        return StreamingResponse(
            stream_gen(),
            media_type="audio/pcm",
            headers={
                "X-Sample-Rate": str(OUTPUT_SAMPLE_RATE),
                "X-Channels": "1",
                "X-Bit-Depth": "16",
            },
        )

    elif TTS_BACKEND == "edge-tts":
        async def stream_gen():
            first = True
            async for chunk in synthesize_edge_tts(request.text, request.language, request.speed):
                if first:
                    ttfc = (time.perf_counter() - start_time) * 1000
                    logger.info(f"TTS first chunk in {ttfc:.0f}ms")
                    first = False
                yield chunk

        return StreamingResponse(
            stream_gen(),
            media_type="audio/pcm",
            headers={
                "X-Sample-Rate": str(OUTPUT_SAMPLE_RATE),
                "X-Channels": "1",
                "X-Bit-Depth": "16",
            },
        )

    elif TTS_BACKEND == "macos-say":
        loop = asyncio.get_event_loop()
        pcm_data = await loop.run_in_executor(
            None, synthesize_macos_say, request.text, request.language, request.speed
        )
        ttfc = (time.perf_counter() - start_time) * 1000
        logger.info(f"TTS complete in {ttfc:.0f}ms ({len(pcm_data)} bytes)")

        async def chunk_stream():
            chunk_size = OUTPUT_SAMPLE_RATE * 2 // 10
            for i in range(0, len(pcm_data), chunk_size):
                yield pcm_data[i:i + chunk_size]

        return StreamingResponse(
            chunk_stream(),
            media_type="audio/pcm",
            headers={"X-Sample-Rate": str(OUTPUT_SAMPLE_RATE), "X-Channels": "1", "X-Bit-Depth": "16"},
        )

    else:
        # Mock: return silence
        return StreamingResponse(
            io.BytesIO(generate_silence(1.0)),
            media_type="audio/pcm",
            headers={"X-Sample-Rate": str(OUTPUT_SAMPLE_RATE), "X-Channels": "1", "X-Bit-Depth": "16"},
        )


if __name__ == "__main__":
    logger.info(f"Starting DEV TTS server on {HOST}:{PORT}")
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
