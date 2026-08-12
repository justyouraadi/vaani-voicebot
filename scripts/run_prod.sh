#!/usr/bin/env bash
# ============================================================
# TBB-VaaniAI — RunPod Production Runner (No Docker)
# Runs all services natively inside a RunPod PyTorch Container
# Template: runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04
#
# ARCHITECTURE NOTE:
# vLLM tightly couples to specific torch versions. Coqui XTTS breaks with
# transformers >= 4.43. The idiap maintainer recommends separate environments.
# This script creates TWO venvs:
#   - venv_llm:   torch 2.4.0 + vLLM 0.6.3.post1 (prefix caching, modern)
#   - venv_audio: torch 2.3.0 + transformers 4.40.0 + coqui-tts (proven stable)
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC}  $1"; }
log_success() { echo -e "${GREEN}[OK]${NC}    $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC}  $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

# Version pins (override via env if needed)
VLLM_VERSION="${VLLM_VERSION:-0.6.6.post2}"
TORCH_LLM_VERSION="${TORCH_LLM_VERSION:-2.4.0}"
TORCHVISION_LLM_VERSION="${TORCHVISION_LLM_VERSION:-0.19.0}"
TORCHAUDIO_LLM_VERSION="${TORCHAUDIO_LLM_VERSION:-2.4.0}"
# Audio stack
TORCH_AUDIO_VERSION="${TORCH_AUDIO_VERSION:-2.3.0}"
# Don't pin transformers for audio - let coqui-tts pull its required version (>=4.57)
# TRANSFORMERS_AUDIO_VERSION="${TRANSFORMERS_AUDIO_VERSION:-4.57.0}"

print_banner() {
    echo -e "${CYAN}"
    echo "╔══════════════════════════════════════════════╗"
    echo "║    🎙️  VaaniAI Production Runner (RunPod)    ║"
    echo "║    Native Python • Dual Venv • GPU Accel     ║"
    echo "╚══════════════════════════════════════════════╝"
    echo -e "${NC}"
}

cleanup() {
    log_info "Shutting down all services..."
    fuser -k 9000/tcp 2>/dev/null || true
    fuser -k 9001/tcp 2>/dev/null || true
    fuser -k 9002/tcp 2>/dev/null || true
    fuser -k 8080/tcp 2>/dev/null || true
    kill $(jobs -p) 2>/dev/null || true
    wait 2>/dev/null || true
    log_success "All services stopped"
}

trap cleanup EXIT INT TERM

# ─────────────────────────────────────────────
# Step 1: Install Dependencies (Two Venvs)
# ─────────────────────────────────────────────
install_deps() {
    log_info "Installing system dependencies (ffmpeg, psmisc)..."
    apt-get update -yqq && apt-get install -yqq ffmpeg psmisc

    # ── venv_llm: Modern vLLM stack (torch 2.4, CUDA 12.4) ──────────────
    log_info "Creating venv_llm (vLLM stack)..."
    python -m venv /workspace/venv_llm
    source /workspace/venv_llm/bin/activate

    log_info "Installing vLLM stack: torch ${TORCH_LLM_VERSION}, vLLM ${VLLM_VERSION}..."
    pip install -q --upgrade pip

    # vLLM 0.6.6.post2 needs torch 2.4.0 (cu124)
    pip install -q "torch==${TORCH_LLM_VERSION}" \
        "torchvision==${TORCHVISION_LLM_VERSION}" \
        "torchaudio==${TORCHAUDIO_LLM_VERSION}" \
        --extra-index-url https://download.pytorch.org/whl/cu124

    # vLLM pulls transformers>=4.45 automatically; pin to 4.51.3 for vLLM 0.6.6 compatibility
    pip install -q "vllm==${VLLM_VERSION}"
    pip install -q "transformers==4.51.3"

    # Orchestrator deps (openai, httpx, websockets, etc.) in venv_llm too
    pip install -q -r "$PROJECT_DIR/orchestrator/requirements.txt"

    log_success "venv_llm ready!"

    # ── venv_audio: Audio stack (torch 2.3, transformers auto-pulled by coqui-tts) ────
    log_info "Creating venv_audio (STT/TTS/Orchestrator)..."
    python -m venv /workspace/venv_audio
    source /workspace/venv_audio/bin/activate

    log_info "Installing audio stack: torch ${TORCH_AUDIO_VERSION}..."
    pip install -q --upgrade pip

    # Torch 2.3.0 cu121 works on CUDA 12.4 driver via LD_LIBRARY_PATH
    pip install -q "torch==${TORCH_AUDIO_VERSION}" \
        "torchvision==0.18.0" \
        "torchaudio==2.3.0" \
        --extra-index-url https://download.pytorch.org/whl/cu121

    # STT, TTS, Orchestrator requirements (coqui-tts will pull transformers>=4.57)
    pip install -q \
        -r "$PROJECT_DIR/stt-server/requirements.txt" \
        -r "$PROJECT_DIR/tts-server/requirements.txt" \
        -r "$PROJECT_DIR/orchestrator/requirements.txt"

    # coqui-tts fork uses coqpit-config now
    pip install -q --force-reinstall --no-deps coqpit-config
    # No patch needed for coqpit-config

    log_success "venv_audio ready!"
}

# ─────────────────────────────────────────────
# Step 2: Setup .env
# ─────────────────────────────────────────────
setup_env() {
    if [ ! -f "$PROJECT_DIR/.env" ]; then
        log_info "Creating production .env file..."
        cat > "$PROJECT_DIR/.env" << 'EOF'
VLLM_BASE_URL=http://localhost:9000/v1
VLLM_MODEL=Qwen/Qwen2.5-7B-Instruct
VLLM_API_KEY=EMPTY
LLM_MAX_TOKENS=100
LLM_TEMPERATURE=0.7

STT_SERVER_URL=ws://localhost:9001/ws/transcribe
TTS_SERVER_URL=http://localhost:9002/synthesize

WHISPER_MODEL=large-v3-turbo
WHISPER_LANGUAGE=auto
WHISPER_DEVICE=cuda

VAD_ENERGY_THRESHOLD=300
VAD_MIN_SILENCE_MS=500

ORCHESTRATOR_HOST=0.0.0.0
ORCHESTRATOR_PORT=8080
LOG_LEVEL=INFO
EOF
        log_success "Created .env (WHISPER_LANGUAGE=auto for auto-detect)"
    fi
}

# ─────────────────────────────────────────────
# Step 3: Start Services
# ─────────────────────────────────────────────
start_services() {
    cd "$PROJECT_DIR"
    set -a
    source .env 2>/dev/null || true
    set +a

    # CUDA lib paths for each venv
    LLM_NVIDIA_LIB="/workspace/venv_llm/lib/python3.11/site-packages/nvidia"
    AUDIO_NVIDIA_LIB="/workspace/venv_audio/lib/python3.11/site-packages/nvidia"

    # Voice cloning setup
    export VOICES_DIR="$PROJECT_DIR/voices"
    mkdir -p "$VOICES_DIR"
    if [ ! -f "$VOICES_DIR/vaani_default.wav" ]; then
        log_info "No reference voice found. Downloading default voice..."
        curl -sL "https://huggingface.co/coqui/XTTS-v2/resolve/main/samples/en_sample.wav" -o "$VOICES_DIR/vaani_default.wav"
        log_success "Downloaded default voice."
    fi

    export COQUI_TOS_AGREED=1

    # ── vLLM Server (venv_llm) ──────────────────────────────────────────
    log_info "Starting vLLM Server (port 9000) with prefix caching..."
    export LD_LIBRARY_PATH="${LLM_NVIDIA_LIB}/cuda_runtime/lib:${LLM_NVIDIA_LIB}/cublas/lib:${LD_LIBRARY_PATH:-}"
    source /workspace/venv_llm/bin/activate
    VLLM_USE_V1=0 python -m vllm.entrypoints.openai.api_server \
        --host 0.0.0.0 \
        --port 9000 \
        --model Qwen/Qwen2.5-7B-Instruct \
        --gpu-memory-utilization 0.60 \
        --max-model-len 8128 \
        --enable-prefix-caching \
        2>&1 | tee -a vllm.log &
    VLLM_PID=$!

    log_info "Waiting 45 seconds for vLLM to initialize..."
    sleep 45

    # ── STT Server (venv_audio) ─────────────────────────────────────────
    log_info "Starting STT Server (port 9001)..."
    export LD_LIBRARY_PATH="${AUDIO_NVIDIA_LIB}/cuda_runtime/lib:${AUDIO_NVIDIA_LIB}/cublas/lib:${LD_LIBRARY_PATH:-}"
    source /workspace/venv_audio/bin/activate
    STT_SERVER_PORT=9001 python stt-server/server.py 2>&1 | tee -a stt.log &
    STT_PID=$!

    while ! curl -s http://localhost:9001/health > /dev/null; do
        if ! kill -0 $STT_PID 2>/dev/null; then
            log_error "STT Server crashed! Check stt.log"
            exit 1
        fi
        sleep 1
    done
    log_success "STT Server is ready!"

    # ── TTS Server (venv_audio) ─────────────────────────────────────────
    log_info "Starting TTS Server (port 9002)..."
    TTS_SERVER_PORT=9002 python tts-server/server.py 2>&1 | tee -a tts.log &
    TTS_PID=$!

    log_info "Waiting for TTS model to load (~10s)..."
    while ! curl -s http://localhost:9002/health > /dev/null; do
        if ! kill -0 $TTS_PID 2>/dev/null; then
            log_error "TTS Server crashed! Check tts.log"
            exit 1
        fi
        sleep 1
    done
    log_success "TTS Server is ready!"

    # ── Orchestrator (venv_audio) ───────────────────────────────────────
    log_info "Starting Orchestrator (port 8080)..."
    FRONTEND_DIR="$PROJECT_DIR/frontend" python orchestrator/main.py 2>&1 | tee -a orchestrator.log &
    ORCH_PID=$!

    echo ""
    echo -e "${CYAN}╔══════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║         🚀 VaaniAI is Live on RunPod!        ║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  ${GREEN}🌐 Public UI:${NC} Check your RunPod exposed port 8080 URL!"
    echo ""
    echo -e "  ${YELLOW}Press Ctrl+C to stop all services${NC}"
    echo ""

    wait
}

main() {
    print_banner
    fuser -k 9000/tcp 2>/dev/null || true
    fuser -k 9001/tcp 2>/dev/null || true
    fuser -k 9002/tcp 2>/dev/null || true
    fuser -k 8080/tcp 2>/dev/null || true

    install_deps
    setup_env
    start_services
}

main "$@"