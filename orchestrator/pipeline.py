"""
🔗 TBB-VaaniAI — Streaming Pipeline
Assembles and runs the full STT → LLM → TTS pipeline for a single session.

This is the heart of the system. None of the components wait for the previous
one to finish — they all stream data continuously.
"""

import asyncio
import logging
import time
import json
from typing import Optional, Callable

from services.stt_service import STTService
from services.llm_service import LLMService
from services.tts_service import TTSService
from services.vad_service import SimpleVAD
from processors.sentence_chunker import SentenceChunker
from processors.filler_injector import FillerInjector
from processors.barge_in import BargeInController, PipelineState
from config import settings

logger = logging.getLogger("orchestrator.pipeline")


class VoicePipeline:
    """
    Manages a complete voice conversation session.

    Data flow:
      Browser Audio → STT → LLM (streaming) → Sentence Chunker → TTS (streaming) → Browser

    Barge-in flow:
      Browser Audio → VAD → Barge-in Controller → Cancel LLM+TTS → Re-enable STT

    All operations are async and run concurrently.
    """

    def __init__(
        self,
        session_id: str,
        send_audio: Callable,
        send_json: Callable,
    ):
        """
        Args:
            session_id: Unique identifier for this session
            send_audio: Coroutine to send audio bytes back to the browser
            send_json: Coroutine to send JSON messages back to the browser
        """
        self.session_id = session_id
        self._send_audio = send_audio
        self._send_json = send_json

        # Services
        self.stt = STTService()
        self.llm = LLMService()
        self.tts = TTSService()
        self.vad = SimpleVAD()

        # Processors
        self.chunker = SentenceChunker()
        self.filler = FillerInjector()
        self.barge_in = BargeInController()

        # State
        self._running = False
        self._current_llm_task: Optional[asyncio.Task] = None
        self._current_tts_task: Optional[asyncio.Task] = None
        self._metrics: dict = {
            "total_conversations": 0,
            "total_barge_ins": 0,
            "avg_ttfa_ms": 0,
        }

        # Setup callbacks
        self._setup_callbacks()

    def _setup_callbacks(self):
        """Wire up event callbacks between components."""

        async def on_speech_start(data):
            logger.info(f"[{self.session_id}] 🎤 User speech started")
            self.barge_in.set_state(PipelineState.LISTENING)
            await self._send_json({
                "type": "state",
                "state": "listening",
                "timestamp": time.time(),
            })

        async def on_partial_transcription(data):
            await self._send_json({
                "type": "partial_transcription",
                "text": data.get("text", ""),
                "timestamp": time.time(),
            })

        async def on_final_transcription(data):
            text = data.get("text", "").strip()
            if not text:
                return

            logger.info(f"[{self.session_id}] 📝 Final transcription: \"{text}\"")

            await self._send_json({
                "type": "transcription",
                "text": text,
                "transcription_ms": data.get("transcription_ms", 0),
                "timestamp": time.time(),
            })

            # Start the LLM → TTS pipeline
            await self._process_user_input(text)

        async def on_speech_end(data):
            logger.debug(f"[{self.session_id}] 🔇 User speech ended")

        async def on_barge_in(partial_response):
            logger.info(f"[{self.session_id}] 🛑 Barge-in! Cancelling AI response.")
            self.llm.add_interrupted_message(partial_response)

            # Cancel running tasks
            if self._current_tts_task and not self._current_tts_task.done():
                self.tts.cancel()
            if self._current_llm_task and not self._current_llm_task.done():
                self._current_llm_task.cancel()

            self._metrics["total_barge_ins"] += 1

            await self._send_json({
                "type": "barge_in",
                "partial_response": partial_response[:200],
                "timestamp": time.time(),
            })

        # Register callbacks
        self.stt.on_speech_start(on_speech_start)
        self.stt.on_partial(on_partial_transcription)
        self.stt.on_final(on_final_transcription)
        self.stt.on_speech_end(on_speech_end)
        self.barge_in.on_barge_in(on_barge_in)

    async def start(self):
        """Initialize the pipeline and connect to services."""
        logger.info(f"[{self.session_id}] Starting voice pipeline...")

        # Connect to STT server
        connected = await self.stt.connect()
        if not connected:
            await self._send_json({
                "type": "error",
                "message": "Failed to connect to STT server",
            })
            logger.error(f"[{self.session_id}] STT connection failed")
            return False

        self._running = True
        self.barge_in.set_state(PipelineState.IDLE)

        await self._send_json({
            "type": "ready",
            "session_id": self.session_id,
            "timestamp": time.time(),
        })

        logger.info(f"[{self.session_id}] Voice pipeline ready")
        return True

    async def stop(self):
        """Shut down the pipeline."""
        self._running = False

        # Cancel any running tasks
        for task in [self._current_llm_task, self._current_tts_task]:
            if task and not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

        await self.stt.disconnect()
        await self.tts.close()

        logger.info(f"[{self.session_id}] Pipeline stopped")

    async def process_audio_chunk(self, pcm_bytes: bytes):
        """
        Process incoming audio from the browser.

        This method is called for every audio chunk and handles:
        1. Forwarding audio to STT server
        2. Barge-in detection while AI is speaking
        """
        if not self._running:
            return

        # Forward audio to STT server for transcription
        await self.stt.send_audio(pcm_bytes)

        # Check for barge-in while AI is speaking
        if self.barge_in.is_interruptible:
            is_speaking = self.vad.process_chunk(pcm_bytes)
            if is_speaking:
                await self.barge_in.check_barge_in(True)
            else:
                await self.barge_in.check_barge_in(False)

    async def _process_user_input(self, text: str):
        """
        Process transcribed user text through LLM → TTS pipeline.

        This is the streaming cascade:
        1. LLM generates tokens (streamed via SSE)
        2. Sentence chunker batches tokens at punctuation
        3. TTS synthesizes each chunk (streamed)
        4. Audio chunks are sent to browser immediately
        """
        self._metrics["total_conversations"] += 1
        pipeline_start = time.perf_counter()
        first_audio_time = None

        # Update state
        self.barge_in.set_state(PipelineState.THINKING)
        await self._send_json({
            "type": "state",
            "state": "thinking",
            "timestamp": time.time(),
        })

        # Reset processors
        self.chunker.reset()
        self.filler.reset()
        self.vad.reset()

        accumulated_response = []

        try:
            # Start LLM streaming
            token_stream = self.llm.generate_stream(text)

            # Process tokens through sentence chunker
            async for chunk_text in self.chunker.process_token_stream(token_stream):
                # Check if cancelled (barge-in)
                if self.barge_in.cancel_event.is_set():
                    logger.info(f"[{self.session_id}] Pipeline cancelled by barge-in")
                    break

                accumulated_response.append(chunk_text)
                self.barge_in.track_partial_response(" ".join(accumulated_response))

                # Switch to speaking state on first chunk
                if self.barge_in.state == PipelineState.THINKING:
                    self.barge_in.set_state(PipelineState.SPEAKING)
                    await self._send_json({
                        "type": "state",
                        "state": "speaking",
                        "timestamp": time.time(),
                    })

                # Send chunk text to browser for display
                await self._send_json({
                    "type": "ai_text",
                    "text": chunk_text,
                    "timestamp": time.time(),
                })

                # ── Synthesize as full WAV blob ──────────────────────────────────
                # Request complete WAV bytes for this sentence chunk.
                # This is the same code path as the Voice Cloner (which worked perfectly).
                # The WAV blob is sent immediately so the browser starts playing
                # while the LLM continues generating the next sentence chunk.
                if self.barge_in.cancel_event.is_set():
                    break

                wav_bytes = await self.tts.synthesize_full(chunk_text, language="auto")
                if wav_bytes and not self.barge_in.cancel_event.is_set():
                    chunk_index = len(accumulated_response) - 1

                    if first_audio_time is None:
                        first_audio_time = (time.perf_counter() - pipeline_start) * 1000
                        logger.info(
                            f"[{self.session_id}] ⚡ Time-to-First-Audio: {first_audio_time:.0f}ms"
                        )

                    # Send JSON header so browser knows the next binary message is a WAV
                    await self._send_json({
                        "type": "audio_wav",
                        "chunk_index": chunk_index,
                        "bytes": len(wav_bytes),
                        "timestamp": time.time(),
                    })

                    # Send the complete WAV binary — browser plays it via new Audio()
                    await self._send_audio(wav_bytes)

        except asyncio.CancelledError:
            logger.info(f"[{self.session_id}] Pipeline task cancelled")
        except Exception as e:
            logger.error(f"[{self.session_id}] Pipeline error: {e}", exc_info=True)
            await self._send_json({
                "type": "error",
                "message": f"Pipeline error: {str(e)}",
            })
        finally:
            total_ms = (time.perf_counter() - pipeline_start) * 1000

            # Send completion
            if not self.barge_in.cancel_event.is_set():
                self.barge_in.set_state(PipelineState.IDLE)
                await self._send_json({
                    "type": "state",
                    "state": "idle",
                    "timestamp": time.time(),
                })

            # Send latency metrics
            await self._send_json({
                "type": "metrics",
                "ttfa_ms": round(first_audio_time, 1) if first_audio_time else None,
                "total_ms": round(total_ms, 1),
                "chunks": len(accumulated_response),
                "barge_in": self.barge_in.cancel_event.is_set(),
                "timestamp": time.time(),
            })

            # Update running average
            if first_audio_time:
                prev = self._metrics["avg_ttfa_ms"]
                n = self._metrics["total_conversations"]
                self._metrics["avg_ttfa_ms"] = prev + (first_audio_time - prev) / n

            logger.info(
                f"[{self.session_id}] Pipeline complete: "
                f"TTFA={first_audio_time:.0f}ms, total={total_ms:.0f}ms, "
                f"chunks={len(accumulated_response)}"
                if first_audio_time
                else f"[{self.session_id}] Pipeline complete (no audio): total={total_ms:.0f}ms"
            )

    def get_metrics(self) -> dict:
        """Return session metrics."""
        return {
            **self._metrics,
            **self.barge_in.get_stats(),
            "session_id": self.session_id,
        }
