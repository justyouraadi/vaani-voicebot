"""
🎯 TBB-VaaniAI — VAD Service
Lightweight VAD wrapper for the orchestrator.
Used for barge-in detection on the orchestrator side.
"""

import logging
import numpy as np
import struct
from typing import Optional

logger = logging.getLogger("orchestrator.vad")


class SimpleVAD:
    """
    Simple energy-based VAD for the orchestrator layer.

    The heavy-duty Silero VAD runs on the STT server. This lightweight
    energy-based VAD runs in the orchestrator to detect barge-in
    (user speaking while AI is outputting audio) without the overhead
    of a neural network.

    For barge-in detection, we only need to know "is someone speaking loudly?"
    — we don't need the precision of Silero VAD.
    """

    def __init__(self, threshold_rms: float = 500.0, min_speech_frames: int = 3):
        """
        Args:
            threshold_rms: RMS energy threshold for speech detection
            min_speech_frames: Consecutive frames above threshold to confirm speech
        """
        self.threshold_rms = threshold_rms
        self.min_speech_frames = min_speech_frames
        self._speech_frame_count = 0
        self._is_speaking = False

    def process_chunk(self, pcm_bytes: bytes) -> bool:
        """
        Process a PCM audio chunk and return whether speech is detected.

        Args:
            pcm_bytes: Raw PCM int16 audio bytes

        Returns:
            True if sustained speech is detected (barge-in trigger)
        """
        if len(pcm_bytes) < 2:
            return False

        # Convert bytes to int16 samples
        n_samples = len(pcm_bytes) // 2
        samples = struct.unpack(f"<{n_samples}h", pcm_bytes[:n_samples * 2])

        # Calculate RMS energy
        rms = np.sqrt(np.mean(np.array(samples, dtype=np.float64) ** 2))

        if rms >= self.threshold_rms:
            self._speech_frame_count += 1
        else:
            self._speech_frame_count = max(0, self._speech_frame_count - 1)

        was_speaking = self._is_speaking
        self._is_speaking = self._speech_frame_count >= self.min_speech_frames

        if self._is_speaking and not was_speaking:
            logger.debug(f"Barge-in VAD: Speech detected (RMS={rms:.0f})")

        return self._is_speaking

    @property
    def is_speaking(self) -> bool:
        return self._is_speaking

    def reset(self):
        """Reset VAD state."""
        self._speech_frame_count = 0
        self._is_speaking = False
