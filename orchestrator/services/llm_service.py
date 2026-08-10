"""
🧠 TBB-VaaniAI — LLM Service
Streaming LLM client using OpenAI-compatible API (vLLM endpoint).
Yields tokens one-by-one as they're generated via SSE.
"""

import asyncio
import logging
import time
from typing import AsyncGenerator, Optional

from openai import AsyncOpenAI
from config import settings
from prompts.vaani_persona import get_system_prompt

logger = logging.getLogger("orchestrator.llm")


class LLMService:
    """
    Connects to a vLLM (or any OpenAI-compatible) endpoint for streaming chat.

    Key design decisions:
    - Uses SSE token streaming for minimum time-to-first-token
    - Maintains conversation history with sliding window
    - System prompt includes filler-word instructions for perceived zero-latency
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        model: Optional[str] = None,
        api_key: Optional[str] = None,
    ):
        self.base_url = base_url or settings.vllm_base_url
        self.model = model or settings.vllm_model
        self.api_key = api_key or settings.vllm_api_key
        self.max_tokens = settings.llm_max_tokens
        self.temperature = settings.llm_temperature

        self.client = AsyncOpenAI(
            base_url=self.base_url,
            api_key=self.api_key,
        )

        # Conversation history (sliding window)
        self.conversation_history: list[dict] = []
        self.max_history_turns = 10  # Keep last N turns
        self.system_prompt = get_system_prompt("hi")

        logger.info(f"LLM Service initialized: {self.model} @ {self.base_url}")

    def set_system_prompt(self, prompt: str):
        """Override the system prompt."""
        self.system_prompt = prompt

    def add_user_message(self, text: str):
        """Add a user message to conversation history."""
        self.conversation_history.append({"role": "user", "content": text})
        self._trim_history()

    def add_assistant_message(self, text: str):
        """Add an assistant message to conversation history."""
        self.conversation_history.append({"role": "assistant", "content": text})
        self._trim_history()

    def add_interrupted_message(self, partial_text: str):
        """
        Add a message that was interrupted by barge-in.
        Marks it so the LLM knows the response was cut short.
        """
        if partial_text.strip():
            self.conversation_history.append({
                "role": "assistant",
                "content": f"{partial_text}... [interrupted by user]",
            })
            self._trim_history()

    def _trim_history(self):
        """Keep conversation history within the sliding window."""
        if len(self.conversation_history) > self.max_history_turns * 2:
            # Keep the most recent turns
            self.conversation_history = self.conversation_history[-(self.max_history_turns * 2):]

    def _build_messages(self) -> list[dict]:
        """Build the full message array for the API call."""
        messages = [{"role": "system", "content": self.system_prompt}]
        messages.extend(self.conversation_history)
        return messages

    async def generate_stream(self, user_text: str) -> AsyncGenerator[str, None]:
        """
        Stream LLM response tokens one-by-one.

        This is the core of the sub-300ms latency pipeline:
        - Each token is yielded immediately as the LLM generates it
        - The sentence chunker collects tokens and flushes to TTS at punctuation
        - First token (usually a filler word) arrives in ~50-100ms

        Args:
            user_text: The transcribed user speech

        Yields:
            Individual tokens as strings
        """
        self.add_user_message(user_text)
        messages = self._build_messages()

        start_time = time.perf_counter()
        first_token_time = None
        full_response = []
        token_count = 0

        try:
            stream = await self.client.chat.completions.create(
                model=self.model,
                messages=messages,
                max_tokens=self.max_tokens,
                temperature=self.temperature,
                stream=True,
            )

            async for chunk in stream:
                if not chunk.choices:
                    continue

                delta = chunk.choices[0].delta
                if delta.content:
                    token = delta.content
                    token_count += 1
                    full_response.append(token)

                    if first_token_time is None:
                        first_token_time = (time.perf_counter() - start_time) * 1000
                        logger.info(f"LLM first token in {first_token_time:.0f}ms: \"{token}\"")

                    yield token

                # Check for finish
                if chunk.choices[0].finish_reason:
                    break

        except Exception as e:
            logger.error(f"LLM streaming error (is Ollama running?): {e}")
            # Mock fallback so the pipeline can still be tested locally without an LLM
            fallback_text = "Hmm, lagta hai Ollama abhi chal nahi raha. Par mera pipeline bilkul theek kaam kar raha hai! "
            for word in fallback_text.split():
                token = word + " "
                full_response.append(token)
                token_count += 1
                if first_token_time is None:
                    first_token_time = (time.perf_counter() - start_time) * 1000
                yield token
                await asyncio.sleep(0.05)

        finally:
            elapsed_ms = (time.perf_counter() - start_time) * 1000
            response_text = "".join(full_response)

            if response_text:
                self.add_assistant_message(response_text)

            logger.info(
                f"LLM complete: {token_count} tokens in {elapsed_ms:.0f}ms "
                f"(TTFT={first_token_time:.0f}ms): "
                f"\"{response_text[:100]}{'...' if len(response_text) > 100 else ''}\""
            )

    async def generate_full(self, user_text: str) -> str:
        """Non-streaming generation (for testing/fallback)."""
        tokens = []
        async for token in self.generate_stream(user_text):
            tokens.append(token)
        return "".join(tokens)

    def reset_conversation(self):
        """Clear conversation history."""
        self.conversation_history = []
        logger.info("Conversation history cleared")

    async def check_health(self) -> bool:
        """Check if the LLM endpoint is reachable."""
        try:
            models = await self.client.models.list()
            return True
        except Exception as e:
            logger.error(f"LLM health check failed: {e}")
            return False
