"""
💬 TBB-VaaniAI — Filler Injector
Detects and handles filler words for perceived zero-latency responses.

The filler-word technique:
1. LLM generates "Hmm..." as the very first token (~50ms)
2. TTS plays "Hmm..." immediately
3. User hears the AI "thinking" while the real response generates
4. Perceived latency drops to near zero
"""

import logging
from typing import Optional

from config import settings

logger = logging.getLogger("orchestrator.filler")


class FillerInjector:
    """
    Detects filler words at the start of LLM responses.

    In our architecture, the LLM is prompt-engineered to always start
    with a filler word. This processor detects the filler and can:
    1. Signal the TTS to play the filler immediately (priority chunk)
    2. Track whether a filler was generated for latency reporting
    """

    def __init__(self, filler_words: Optional[list[str]] = None):
        self.filler_words = filler_words or settings.filler_words_list
        # Lowercase versions for matching
        self._filler_set = {w.lower().strip().rstrip(".,!?;:") for w in self.filler_words}
        self._detected_filler: Optional[str] = None
        self._is_first_tokens = True
        self._token_buffer: list[str] = []

    def check_token(self, token: str) -> Optional[str]:
        """
        Check if the accumulated tokens form a filler word.

        Call this for each token at the start of a response.
        Returns the filler text when detected, None otherwise.

        After the first filler is detected (or after enough tokens
        to determine no filler), this becomes a no-op.
        """
        if not self._is_first_tokens:
            return None

        self._token_buffer.append(token)
        accumulated = "".join(self._token_buffer).strip()

        # Check if accumulated text matches a filler
        clean = accumulated.lower().rstrip(".,!?;: ")

        if clean in self._filler_set:
            # Found a filler! Wait for the trailing punctuation
            if accumulated.rstrip().endswith((",", ".", "!", "...", " ")):
                self._detected_filler = accumulated
                self._is_first_tokens = False
                logger.info(f"Filler detected: \"{accumulated.strip()}\"")
                return accumulated.strip()

            # Filler word found but waiting for punctuation
            return None

        # Check if any filler starts with the accumulated text
        any_prefix = any(
            f.startswith(clean) for f in self._filler_set
        )

        if not any_prefix or len(self._token_buffer) > 5:
            # No filler match possible — stop looking
            self._is_first_tokens = False
            logger.debug(f"No filler detected in first tokens: \"{accumulated}\"")
            return None

        return None

    @property
    def filler_detected(self) -> bool:
        return self._detected_filler is not None

    @property
    def detected_filler(self) -> Optional[str]:
        return self._detected_filler

    def reset(self):
        """Reset for a new response."""
        self._detected_filler = None
        self._is_first_tokens = True
        self._token_buffer = []

    def check_text(self, text: str) -> Optional[str]:
        """
        Check if the given text chunk starts with a filler word.

        This is used when we receive whole chunks from the sentence chunker
        rather than individual tokens. Returns the filler if detected.
        """
        if not self._is_first_tokens:
            return None

        first_word = text.strip().split(" ", 1)[0].strip()
        clean = first_word.lower().rstrip(".,!?;: ")

        if clean in self._filler_set:
            self._detected_filler = first_word
            self._is_first_tokens = False
            logger.info(f"Filler detected: \"{first_word}\"")
            return first_word

        self._is_first_tokens = False
        return None
