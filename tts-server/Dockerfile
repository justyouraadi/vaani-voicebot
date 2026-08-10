# ============================================================
# TTS Server — XTTS v2 Streaming Synthesis
# CUDA-enabled for real-time voice generation with cloning
# ============================================================
FROM nvidia/cuda:12.1.1-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-dev \
    libsndfile1 ffmpeg espeak-ng curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

# Pre-download XTTS v2 model at build time
RUN python3 -c "from TTS.api import TTS; TTS('tts_models/multilingual/multi-dataset/xtts_v2')" || true

COPY . .

EXPOSE 8002

CMD ["python3", "server.py"]
