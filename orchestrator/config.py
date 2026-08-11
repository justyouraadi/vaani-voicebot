"""
⚙️ TBB-VaaniAI — Centralized Configuration
All environment variables and settings in one place.
"""

import os
from pydantic_settings import BaseSettings
from pydantic import Field


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # ── LLM (The Brain) ──
    vllm_base_url: str = Field(default="http://localhost:8000/v1", alias="VLLM_BASE_URL")
    vllm_model: str = Field(default="Qwen/Qwen2.5-7B-Instruct", alias="VLLM_MODEL")
    vllm_api_key: str = Field(default="EMPTY", alias="VLLM_API_KEY")
    llm_max_tokens: int = Field(default=100, alias="LLM_MAX_TOKENS")
    llm_temperature: float = Field(default=0.7, alias="LLM_TEMPERATURE")

    # ── STT Server (The Ears) ──
    stt_server_url: str = Field(default="ws://localhost:8001/ws/transcribe", alias="STT_SERVER_URL")

    # ── TTS Server (The Voice) ──
    tts_server_url: str = Field(default="http://localhost:8002/synthesize", alias="TTS_SERVER_URL")

    # ── VAD ──
    vad_threshold: float = Field(default=0.5, alias="VAD_THRESHOLD")
    vad_min_silence_ms: int = Field(default=300, alias="VAD_MIN_SILENCE_MS")

    # ── Pipeline ──
    sentence_chunk_min_words: int = Field(default=6, alias="SENTENCE_CHUNK_MIN_WORDS")
    sentence_chunk_max_wait_ms: int = Field(default=500, alias="SENTENCE_CHUNK_MAX_WAIT_MS")
    filler_words: str = Field(default="Ji,Hmm,Achha,Dekhiye,Bilkul", alias="FILLER_WORDS")

    # ── Server ──
    orchestrator_host: str = Field(default="0.0.0.0", alias="ORCHESTRATOR_HOST")
    orchestrator_port: int = Field(default=8080, alias="ORCHESTRATOR_PORT")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")

    # ── Audio ──
    audio_sample_rate: int = Field(default=16000, alias="AUDIO_SAMPLE_RATE")
    tts_sample_rate: int = Field(default=24000)

    @property
    def filler_words_list(self) -> list[str]:
        return [w.strip() for w in self.filler_words.split(",") if w.strip()]

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        populate_by_name = True
        extra = "ignore"


# Singleton
settings = Settings()
