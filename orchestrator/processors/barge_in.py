"""
🛑 TBB-VaaniAI — Barge-In Controller
Handles user interruptions during AI speech output.

When the user speaks while the AI is talking:
1. Immediately stop TTS audio output
2. Cancel pending LLM generation
3. Re-enable STT pipeline
4. Append interrupted context to conversation history
"""

import asyncio
import logging
import time
from typing import Optional, Callable
from enum import Enum

logger = logging.getLogger("orchestrator.bargein")


class PipelineState(Enum):
    """Current state of the voice pipeline."""
    IDLE = "idle"              # Waiting for user to speak
    LISTENING = "listening"    # User is speaking, STT active
    THINKING = "thinking"     # LLM is generating response
    SPEAKING = "speaking"     # TTS audio is playing
    INTERRUPTED = "interrupted"  # Barge-in detected, cleaning up


class BargeInController:
    """
    Manages the voice pipeline state and handles barge-in interruptions.

    The barge-in flow:
    1. AI is in SPEAKING state, playing TTS audio
    2. User starts speaking → VAD detects speech
    3. Debounce: wait 200ms of sustained speech (avoid false triggers)
    4. If speech persists: trigger barge-in
       a. Cancel TTS audio stream
       b. Cancel LLM generation (if still running)
       c. Record partial AI response in conversation history
       d. Switch to LISTENING state
       e. STT processes the user's interruption
    """

    def __init__(self, debounce_ms: float = 200.0):
        self.state = PipelineState.IDLE
        self.debounce_ms = debounce_ms

        # Callbacks
        self._on_barge_in: Optional[Callable] = None
        self._on_state_change: Optional[Callable] = None

        # Tracking
        self._speech_start_time: Optional[float] = None
        self._partial_response: str = ""
        self._barge_in_count = 0

        # Cancellation
        self._cancel_event = asyncio.Event()

    @property
    def is_speaking(self) -> bool:
        return self.state == PipelineState.SPEAKING

    @property
    def is_interruptible(self) -> bool:
        return self.state in (PipelineState.SPEAKING, PipelineState.THINKING)

    @property
    def cancel_event(self) -> asyncio.Event:
        return self._cancel_event

    def on_barge_in(self, callback: Callable):
        """Register a callback for when barge-in is triggered."""
        self._on_barge_in = callback

    def on_state_change(self, callback: Callable):
        """Register a callback for state changes."""
        self._on_state_change = callback

    def set_state(self, new_state: PipelineState):
        """Transition to a new pipeline state."""
        old_state = self.state
        self.state = new_state

        if old_state != new_state:
            logger.info(f"Pipeline state: {old_state.value} → {new_state.value}")
            if self._on_state_change:
                asyncio.ensure_future(self._on_state_change(old_state, new_state))

        # Reset cancel event when entering new processing cycle
        if new_state in (PipelineState.THINKING, PipelineState.SPEAKING):
            self._cancel_event.clear()
        elif new_state == PipelineState.IDLE:
            self._speech_start_time = None
            self._partial_response = ""

    def track_partial_response(self, text: str):
        """Track the partial AI response for interrupted context."""
        self._partial_response = text

    async def check_barge_in(self, user_is_speaking: bool) -> bool:
        """
        Check if a barge-in should be triggered.

        Called on each audio frame while the AI is speaking.

        Returns True if barge-in was triggered.
        """
        if not self.is_interruptible:
            return False

        if user_is_speaking:
            if self._speech_start_time is None:
                self._speech_start_time = time.perf_counter()

            elapsed_ms = (time.perf_counter() - self._speech_start_time) * 1000

            if elapsed_ms >= self.debounce_ms:
                # Barge-in confirmed!
                await self._trigger_barge_in()
                return True
        else:
            # Reset debounce counter
            self._speech_start_time = None

        return False

    async def _trigger_barge_in(self):
        """Execute the barge-in sequence."""
        self._barge_in_count += 1
        logger.info(
            f"🛑 BARGE-IN #{self._barge_in_count} triggered! "
            f"Partial response: \"{self._partial_response[:60]}...\""
        )

        # Signal cancellation to all running tasks
        self._cancel_event.set()

        self.set_state(PipelineState.INTERRUPTED)

        # Call the barge-in callback
        if self._on_barge_in:
            await self._on_barge_in(self._partial_response)

        # Reset for next cycle
        self._speech_start_time = None
        self.set_state(PipelineState.LISTENING)

    def get_stats(self) -> dict:
        """Return barge-in statistics."""
        return {
            "state": self.state.value,
            "barge_in_count": self._barge_in_count,
            "partial_response_length": len(self._partial_response),
        }

    def reset(self):
        """Full reset."""
        self.state = PipelineState.IDLE
        self._speech_start_time = None
        self._partial_response = ""
        self._cancel_event.clear()
