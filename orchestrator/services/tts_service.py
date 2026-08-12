"""
🗣️ TBB-VaaniAI — TTS Service
Async HTTP client that streams audio from the TTS server.
"""

import asyncio
import logging
import time
from typing import AsyncGenerator, Optional

import httpx
from config import settings

logger = logging.getLogger("orchestrator.tts")


class TTSService:
    """
    Connects to the TTS server for streaming speech synthesis.

    The TTS server returns chunked PCM audio that we forward
    immediately to the browser — no buffering the full response.
    """

    def __init__(self, url: Optional[str] = None):
        self.url = url or settings.tts_server_url
        self.client = httpx.AsyncClient(timeout=30.0)
        self._cancel_event: Optional[asyncio.Event] = None

        logger.info(f"TTS Service initialized: {self.url}")

    async def synthesize_stream(
        self,
        text: str,
        language: str = "hi",
        voice: Optional[str] = None,
    ) -> AsyncGenerator[bytes, None]:
        """
        Stream audio chunks from the TTS server.

        Args:
            text: Text to synthesize
            language: Target language
            voice: Optional voice file override

        Yields:
            Raw PCM audio bytes (int16, 24kHz, mono)
        """
        self._cancel_event = asyncio.Event()

        payload = {
            "text": text,
            "language": language,
            "stream": True,
        }
        if voice:
            payload["voice"] = voice

        start_time = time.perf_counter()
        first_chunk_time = None
        total_bytes = 0
        chunk_count = 0

        try:
            async with self.client.stream("POST", self.url, json=payload) as response:
                if response.status_code != 200:
                    body = await response.aread()
                    logger.error(f"TTS error {response.status_code}: {body.decode()}")
                    return

                byte_buffer = bytearray()
                async for chunk in response.aiter_bytes(chunk_size=4096):
                    # Check for cancellation (barge-in)
                    if self._cancel_event and self._cancel_event.is_set():
                        logger.info("TTS synthesis cancelled (barge-in)")
                        break

                    if chunk:
                        byte_buffer.extend(chunk)
                        even_len = (len(byte_buffer) // 2) * 2
                        if even_len > 0:
                            to_send = bytes(byte_buffer[:even_len])
                            byte_buffer = byte_buffer[even_len:]
                            chunk_count += 1
                            total_bytes += len(to_send)

                            if first_chunk_time is None:
                                first_chunk_time = (time.perf_counter() - start_time) * 1000
                                logger.info(f"TTS first chunk in {first_chunk_time:.0f}ms")

                            yield to_send

                if len(byte_buffer) >= 2:
                    even_len = (len(byte_buffer) // 2) * 2
                    yield bytes(byte_buffer[:even_len])

        except httpx.ReadError:
            if self._cancel_event and self._cancel_event.is_set():
                logger.info("TTS stream cancelled cleanly")
            else:
                raise
        except Exception as e:
            logger.error(f"TTS streaming error: {e}", exc_info=True)
        finally:
            elapsed_ms = (time.perf_counter() - start_time) * 1000
            logger.info(
                f"TTS stream: {chunk_count} chunks, {total_bytes} bytes "
                f"in {elapsed_ms:.0f}ms (TTFC={first_chunk_time:.0f}ms)"
                if first_chunk_time
                else f"TTS stream: no audio generated in {elapsed_ms:.0f}ms"
            )

    def cancel(self):
        """Cancel the current synthesis (used for barge-in)."""
        if self._cancel_event:
            self._cancel_event.set()

    async def synthesize_full(self, text: str, language: str = "hi") -> Optional[bytes]:
        """
        Non-streaming synthesis — returns complete WAV bytes.

        This is the GOLD STANDARD audio path: same code as the Voice Cloner
        that produced perfectly clean audio. Each sentence chunk gets its own
        full inference() call and returns a complete WAV file.

        Args:
            text: Text to synthesize
            language: 'hi', 'en', or 'auto' (let TTS server auto-detect script)

        Returns:
            Complete WAV bytes, or None on error
        """
        try:
            payload: dict = {
                "text": text,
                "stream": False,
            }
            # 'auto' means don't set language — let the TTS server auto-detect
            # based on unicode script (Devanagari → hi, Latin → en)
            if language != "auto":
                payload["language"] = language

            response = await self.client.post(
                self.url,
                json=payload,
                timeout=60.0,  # Full inference can take up to ~30s on first call
            )
            if response.status_code == 200:
                return response.content
            logger.error(f"TTS full synthesis error {response.status_code}: {response.text[:200]}")
            return None
        except asyncio.CancelledError:
            logger.info("TTS full synthesis cancelled (barge-in)")
            raise
        except Exception as e:
            logger.error(f"TTS full synthesis error: {e}")
            return None

    async def check_health(self) -> bool:
        """Check if the TTS server is healthy."""
        try:
            # Derive health URL from synthesis URL
            base = self.url.rsplit("/", 1)[0]
            response = await self.client.get(f"{base}/health")
            return response.status_code == 200
        except Exception:
            return False

    async def close(self):
        """Close the HTTP client."""
        await self.client.aclose()
