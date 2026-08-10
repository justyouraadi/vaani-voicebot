"""
👂 TBB-VaaniAI — STT Service
Async WebSocket client that connects to the STT server for streaming transcription.
"""

import json
import asyncio
import logging
import time
from typing import AsyncGenerator, Optional, Callable

import websockets
from config import settings

logger = logging.getLogger("orchestrator.stt")


class STTService:
    """
    Connects to the STT server via WebSocket and streams audio for transcription.

    Usage:
        stt = STTService()
        await stt.connect()
        await stt.send_audio(pcm_bytes)
        # Results come via the callback or async iteration
    """

    def __init__(self, url: Optional[str] = None):
        self.url = url or settings.stt_server_url
        self.ws: Optional[websockets.WebSocketClientProtocol] = None
        self._connected = False
        self._receive_task: Optional[asyncio.Task] = None
        self._result_queue: asyncio.Queue = asyncio.Queue()
        self._on_speech_start: Optional[Callable] = None
        self._on_partial: Optional[Callable] = None
        self._on_final: Optional[Callable] = None
        self._on_speech_end: Optional[Callable] = None

    async def connect(self) -> bool:
        """Connect to the STT server."""
        try:
            self.ws = await websockets.connect(
                self.url,
                ping_interval=20,
                ping_timeout=20,
                max_size=None,
            )
            self._connected = True
            self._receive_task = asyncio.create_task(self._receive_loop())
            logger.info(f"Connected to STT server: {self.url}")
            return True
        except Exception as e:
            logger.error(f"Failed to connect to STT server: {e}")
            self._connected = False
            return False

    async def disconnect(self):
        """Disconnect from the STT server."""
        self._connected = False
        if self._receive_task:
            self._receive_task.cancel()
            try:
                await self._receive_task
            except asyncio.CancelledError:
                pass
        if self.ws:
            await self.ws.close()
            self.ws = None
        logger.info("Disconnected from STT server")

    @property
    def connected(self) -> bool:
        return self._connected and self.ws is not None

    async def send_audio(self, pcm_bytes: bytes):
        """Send raw PCM audio bytes to the STT server."""
        if not self.connected:
            return
        try:
            await self.ws.send(pcm_bytes)
        except Exception as e:
            logger.error(f"Error sending audio to STT: {e}")
            self._connected = False

    async def reset(self):
        """Reset the STT session (clear buffers, re-init VAD)."""
        if not self.connected:
            return
        try:
            await self.ws.send(json.dumps({"type": "reset"}))
        except Exception as e:
            logger.error(f"Error resetting STT: {e}")

    def on_speech_start(self, callback: Callable):
        self._on_speech_start = callback

    def on_partial(self, callback: Callable):
        self._on_partial = callback

    def on_final(self, callback: Callable):
        self._on_final = callback

    def on_speech_end(self, callback: Callable):
        self._on_speech_end = callback

    async def _receive_loop(self):
        """Background task that receives messages from STT server."""
        try:
            async for message in self.ws:
                try:
                    data = json.loads(message)
                    msg_type = data.get("type", "")

                    if msg_type == "speech_start":
                        if self._on_speech_start:
                            await self._on_speech_start(data)

                    elif msg_type == "partial":
                        if self._on_partial:
                            await self._on_partial(data)

                    elif msg_type == "final":
                        await self._result_queue.put(data)
                        if self._on_final:
                            await self._on_final(data)

                    elif msg_type == "speech_end":
                        if self._on_speech_end:
                            await self._on_speech_end(data)

                except json.JSONDecodeError:
                    logger.warning("Non-JSON message from STT server")

        except websockets.exceptions.ConnectionClosed:
            logger.info("STT WebSocket connection closed")
            self._connected = False
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"STT receive loop error: {e}", exc_info=True)
            self._connected = False

    async def get_next_result(self, timeout: float = 30.0) -> Optional[dict]:
        """Wait for the next final transcription result."""
        try:
            return await asyncio.wait_for(self._result_queue.get(), timeout=timeout)
        except asyncio.TimeoutError:
            return None
