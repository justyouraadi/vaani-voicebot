"""
✂️ TBB-VaaniAI — Sentence Chunker
Collects streamed LLM tokens and flushes to TTS at punctuation boundaries.

This is a critical latency optimization:
- Word-by-word TTS sounds robotic
- Full paragraph TTS adds seconds of latency
- Sentence/clause chunking at punctuation gives the best quality/latency tradeoff
"""

import asyncio
import logging
import time
from typing import AsyncGenerator, Callable, Optional

from config import settings

logger = logging.getLogger("orchestrator.chunker")

# Punctuation marks that trigger a flush to TTS
FLUSH_PUNCTUATION = {'.', ',', '!', '?', ';', ':', '।', '—', '–'}

# Hindi sentence-ending markers
HINDI_SENTENCE_ENDERS = {'।', '?', '!', '.'}


class SentenceChunker:
    """
    Buffers LLM tokens and yields sentence/clause chunks for TTS.

    Rules:
    1. Accumulate tokens until punctuation is detected
    2. Minimum chunk size: N words (avoids tiny fragments)
    3. Maximum buffer time: M ms (forces flush for long unpunctuated text)
    4. Always flush on sentence-ending punctuation (. ? ! ।)
    """

    def __init__(
        self,
        min_words: int = None,
        max_wait_ms: int = None,
    ):
        self.min_words = min_words or settings.sentence_chunk_min_words
        self.max_wait_ms = max_wait_ms or settings.sentence_chunk_max_wait_ms
        self._buffer: list[str] = []
        self._last_flush_time = time.perf_counter()

    async def process_token_stream(
        self,
        token_stream: AsyncGenerator[str, None],
    ) -> AsyncGenerator[str, None]:
        """
        Takes a stream of tokens and yields sentence chunks.

        Example:
          Input tokens:  "Ji" "," " main" " Vaani" " bol" " rahi" " hoon" "."
          Output chunks: "Ji,"  →  "main Vaani bol rahi hoon."
        """
        self._buffer = []
        self._last_flush_time = time.perf_counter()

        async for token in token_stream:
            self._buffer.append(token)
            current_text = "".join(self._buffer).strip()

            # Count words in buffer
            word_count = len(current_text.split())

            # Check if we should flush
            should_flush = False
            reason = ""

            # Rule 1: Sentence-ending punctuation with minimum words
            if any(current_text.endswith(p) for p in HINDI_SENTENCE_ENDERS):
                if word_count >= 1:  # Always flush on sentence end
                    should_flush = True
                    reason = "sentence_end"

            # Rule 2: Clause punctuation (comma, semicolon) with minimum words
            elif any(current_text.endswith(p) for p in FLUSH_PUNCTUATION):
                if word_count >= self.min_words:
                    should_flush = True
                    reason = "clause_break"

            # Rule 3: Time-based flush (long unpunctuated stream)
            elif self._time_since_flush_ms() >= self.max_wait_ms:
                if word_count >= self.min_words:
                    should_flush = True
                    reason = "timeout"

            if should_flush and current_text:
                if reason in ("timeout", "clause_break") and not current_text.endswith(" "):
                    # If we flush mid-stream, the last word might still be generating!
                    # Example: LLM emitted "Bha", next token is "i". If we flush now, we get "Bha".
                    # We MUST keep the last incomplete word in the buffer.
                    words = current_text.split(" ")
                    if len(words) > 1:
                        complete_text = " ".join(words[:-1])
                        kept_word = words[-1]
                        logger.debug(f"Chunk flush ({reason}): \"{complete_text}\" (kept: \"{kept_word}\")")
                        self._buffer = [kept_word]
                        self._last_flush_time = time.perf_counter()
                        yield complete_text
                    else:
                        # Cannot split into complete words, wait for more tokens
                        continue
                else:
                    logger.debug(f"Chunk flush ({reason}): \"{current_text}\"")
                    self._buffer = []
                    self._last_flush_time = time.perf_counter()
                    yield current_text

        # Flush remaining buffer at end of stream
        remaining = "".join(self._buffer).strip()
        if remaining:
            logger.debug(f"Chunk flush (end): \"{remaining}\"")
            yield remaining
            self._buffer = []

    def _time_since_flush_ms(self) -> float:
        return (time.perf_counter() - self._last_flush_time) * 1000

    def flush(self) -> Optional[str]:
        """Force flush the current buffer."""
        text = "".join(self._buffer).strip()
        self._buffer = []
        self._last_flush_time = time.perf_counter()
        return text if text else None

    def reset(self):
        """Clear the buffer."""
        self._buffer = []
        self._last_flush_time = time.perf_counter()
