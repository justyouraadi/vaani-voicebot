"""
🎛️ TBB-VaaniAI — Main Orchestrator Server
FastAPI application with WebSocket endpoint for the voice pipeline.

Serves the browser frontend and manages voice pipeline sessions.
"""

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from config import settings
from pipeline import VoicePipeline

# ─────────────────────────────────────────────
# Logging
# ─────────────────────────────────────────────
logging.basicConfig(
    level=getattr(logging, settings.log_level),
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
)
logger = logging.getLogger("orchestrator")

# ─────────────────────────────────────────────
# FastAPI Application
# ─────────────────────────────────────────────
app = FastAPI(
    title="🎙️ TBB-VaaniAI Orchestrator",
    description="Ultra-low latency voice AI agent orchestrator",
    version="1.0.0",
)

# CORS for browser access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Track active sessions
active_sessions: dict[str, VoicePipeline] = {}

# Frontend directory
FRONTEND_DIR = Path(os.getenv("FRONTEND_DIR", "/app/frontend"))
if not FRONTEND_DIR.exists():
    # Development fallback
    FRONTEND_DIR = Path(__file__).parent.parent / "frontend"


# ─────────────────────────────────────────────
# Frontend Routes
# ─────────────────────────────────────────────
@app.get("/", response_class=HTMLResponse)
async def serve_frontend():
    """Serve the demo UI."""
    index_path = FRONTEND_DIR / "index.html"
    if index_path.exists():
        return HTMLResponse(content=index_path.read_text(encoding="utf-8"))
    return HTMLResponse(content="<h1>VaaniAI - Frontend not found</h1>", status_code=404)


@app.get("/style.css")
async def serve_css():
    css_path = FRONTEND_DIR / "style.css"
    if css_path.exists():
        return FileResponse(css_path, media_type="text/css")
    return JSONResponse({"error": "CSS not found"}, status_code=404)


@app.get("/app.js")
async def serve_js():
    js_path = FRONTEND_DIR / "app.js"
    if js_path.exists():
        return FileResponse(js_path, media_type="application/javascript")
    return JSONResponse({"error": "JS not found"}, status_code=404)


@app.get("/audio-worklet.js")
async def serve_worklet():
    worklet_path = FRONTEND_DIR / "audio-worklet.js"
    if worklet_path.exists():
        return FileResponse(worklet_path, media_type="application/javascript")
    return JSONResponse({"error": "Worklet not found"}, status_code=404)


# ─────────────────────────────────────────────
# API Routes
# ─────────────────────────────────────────────
@app.get("/health")
async def health_check():
    """System health check — reports status of all sub-services."""
    return JSONResponse({
        "status": "healthy",
        "service": "orchestrator",
        "active_sessions": len(active_sessions),
        "config": {
            "stt_server": settings.stt_server_url,
            "tts_server": settings.tts_server_url,
            "llm_endpoint": settings.vllm_base_url,
            "llm_model": settings.vllm_model,
        },
    })


@app.get("/metrics")
async def get_metrics():
    """Aggregate metrics from all active sessions."""
    session_metrics = {}
    for sid, pipeline in active_sessions.items():
        session_metrics[sid] = pipeline.get_metrics()

    return JSONResponse({
        "active_sessions": len(active_sessions),
        "sessions": session_metrics,
    })


# ─────────────────────────────────────────────
# WebSocket — Voice Pipeline
# ─────────────────────────────────────────────
@app.websocket("/ws/audio")
async def websocket_voice_pipeline(ws: WebSocket):
    """
    Main WebSocket endpoint for the voice pipeline.

    Protocol:
    - Client sends BINARY: raw PCM audio (16kHz, 16-bit, mono)
    - Client sends TEXT (JSON): control messages
        {"type": "start"}     — initialize pipeline
        {"type": "stop"}      — stop pipeline
        {"type": "reset"}     — reset conversation
        {"type": "ping"}      — keepalive

    - Server sends BINARY: TTS audio (24kHz, 16-bit, mono)
    - Server sends TEXT (JSON): events
        {"type": "ready"}                 — pipeline ready
        {"type": "state", "state": "..."}  — pipeline state change
        {"type": "transcription", "text": "..."}  — final STT result
        {"type": "partial_transcription", "text": "..."}
        {"type": "ai_text", "text": "..."}  — AI response text chunk
        {"type": "metrics", ...}            — latency metrics
        {"type": "barge_in", ...}           — barge-in occurred
        {"type": "error", "message": "..."}
    """
    await ws.accept()

    session_id = f"ws_{id(ws) % 100000:05d}_{int(time.time()) % 10000}"
    logger.info(f"[{session_id}] WebSocket connected")

    async def send_audio(audio_bytes: bytes):
        """Send audio back to the browser."""
        try:
            await ws.send_bytes(audio_bytes)
        except Exception as e:
            logger.error(f"[{session_id}] Error sending audio: {e}")

    async def send_json(data: dict):
        """Send JSON message to the browser."""
        try:
            await ws.send_text(json.dumps(data))
        except Exception as e:
            logger.error(f"[{session_id}] Error sending JSON: {e}")

    # Create pipeline
    pipeline = VoicePipeline(
        session_id=session_id,
        send_audio=send_audio,
        send_json=send_json,
    )
    active_sessions[session_id] = pipeline

    try:
        # Initialize pipeline
        started = await pipeline.start()
        if not started:
            logger.error(f"[{session_id}] Pipeline failed to start")
            await ws.close(code=1011, reason="Pipeline initialization failed")
            return

        # Main message loop
        while True:
            data = await ws.receive()

            if "text" in data:
                # Control message
                try:
                    msg = json.loads(data["text"])
                    msg_type = msg.get("type", "")

                    if msg_type == "stop":
                        logger.info(f"[{session_id}] Client requested stop")
                        break

                    elif msg_type == "reset":
                        pipeline.llm.reset_conversation()
                        pipeline.barge_in.reset()
                        await send_json({"type": "reset_ack"})
                        logger.info(f"[{session_id}] Conversation reset")

                    elif msg_type == "ping":
                        await send_json({
                            "type": "pong",
                            "timestamp": time.time(),
                        })

                except json.JSONDecodeError:
                    pass

            elif "bytes" in data:
                # Audio data
                audio_bytes = data["bytes"]
                if audio_bytes:
                    await pipeline.process_audio_chunk(audio_bytes)

    except WebSocketDisconnect:
        logger.info(f"[{session_id}] WebSocket disconnected")
    except Exception as e:
        logger.error(f"[{session_id}] WebSocket error: {e}", exc_info=True)
    finally:
        await pipeline.stop()
        active_sessions.pop(session_id, None)
        logger.info(f"[{session_id}] Session cleaned up. Active sessions: {len(active_sessions)}")


# ─────────────────────────────────────────────
# Entry Point
# ─────────────────────────────────────────────
if __name__ == "__main__":
    logger.info(f"Starting VaaniAI Orchestrator on {settings.orchestrator_host}:{settings.orchestrator_port}")
    logger.info(f"LLM: {settings.vllm_model} @ {settings.vllm_base_url}")
    logger.info(f"STT: {settings.stt_server_url}")
    logger.info(f"TTS: {settings.tts_server_url}")

    uvicorn.run(
        app,
        host=settings.orchestrator_host,
        port=settings.orchestrator_port,
        log_level="info",
        ws_ping_interval=20,
        ws_ping_timeout=20,
    )
