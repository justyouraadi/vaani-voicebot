#!/usr/bin/env bash
# ============================================================
# TBB-VaaniAI — RunPod Production Runner (No Docker)
# Runs all services natively inside a RunPod PyTorch Container
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

print_banner() {
    echo -e "${CYAN}"
    echo "╔══════════════════════════════════════════════╗"
    echo "║    🎙️  VaaniAI Production Runner (RunPod)    ║"
    echo "║    Native Python • GPU Accelerated           ║"
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
# Step 1: Install Dependencies
# ─────────────────────────────────────────────
install_deps() {
    log_info "Installing system dependencies (ffmpeg, psmisc)..."
    apt-get update -yqq && apt-get install -yqq ffmpeg psmisc

    log_info "Creating clean Python virtual environment..."
    python -m venv /workspace/venv
    source /workspace/venv/bin/activate

    log_info "Installing Python requirements (this may take a few minutes)..."
    
    # [STABILITY FIX] Guarantee a perfect PyTorch 2.3 golden environment inside the venv
    # PyTorch 2.4 broke transformers and vLLM 0.5.4.
    # vLLM 0.4.3 specifically requires torch 2.3.0.
    # We downgrade the entire stack to May 2024 (vLLM 0.4.3 and Transformers 4.40.0)
    # This completely sidesteps all LogitsWarper, DTensor, and pyairports bugs.
    pip install -q --upgrade pip
    
    # We combine ALL installs into a single command so that pip's resolver guarantees
    # perfectly aligned versions for torch, torchaudio, transformers, and vLLM.
    pip install -q "torch==2.3.0" "torchvision==0.18.0" "torchaudio==2.3.0" \
        "transformers==4.40.0" "vllm==0.4.3" "numpy<2.0.0" \
        -r "$PROJECT_DIR/orchestrator/requirements.txt" \
        -r "$PROJECT_DIR/tts-server/requirements.txt" \
        -r "$PROJECT_DIR/stt-server/requirements.txt" \
        --extra-index-url https://download.pytorch.org/whl/cu121

    # [PYTHON 3.11 FIX] Patch coqpit's broken issubclass check for Python 3.11 Typing features
    # Coqui-TTS's config parser crashes when checking issubclass() on typing.Union or List in Python 3.11.
    python3 -c "
import os
path = os.path.join('$PROJECT_DIR', 'venv', 'lib', 'python3.11', 'site-packages', 'coqpit', 'coqpit.py')
if os.path.exists(path):
    with open(path, 'r') as f: content = f.read()
    content = content.replace('issubclass(type(x), Serializable)', 'safe_issubclass(type(x), Serializable)')
    content = content.replace('issubclass(x, Serializable)', 'safe_issubclass(x, Serializable)')
    content = content.replace('issubclass(field_type, Serializable)', 'safe_issubclass(field_type, Serializable)')
    with open(path, 'w') as f: f.write(content)
"

    log_success "All dependencies installed in venv!"
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
LLM_MAX_TOKENS=256
LLM_TEMPERATURE=0.7

STT_SERVER_URL=ws://localhost:9001/ws/transcribe
TTS_SERVER_URL=http://localhost:9002/synthesize

WHISPER_MODEL=large-v3-turbo
WHISPER_LANGUAGE=hi
WHISPER_DEVICE=cuda

VAD_ENERGY_THRESHOLD=300
VAD_MIN_SILENCE_MS=500

ORCHESTRATOR_HOST=0.0.0.0
ORCHESTRATOR_PORT=8080
LOG_LEVEL=INFO
EOF
        log_success "Created .env"
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

    # [STABILITY FIX] Ensure torchaudio can find the pip-installed libcudart.so.12
    # The pip wheel for torch 2.3.0 installs CUDA libraries into the nvidia folder,
    # but the OS dynamic linker doesn't know about it unless we export it!
    export LD_LIBRARY_PATH="/workspace/venv/lib/python3.11/site-packages/nvidia/cuda_runtime/lib:${LD_LIBRARY_PATH:-}"

    echo ""
    log_info "Starting vLLM Server (port 9000)..."
    VLLM_USE_V1=0 python -m vllm.entrypoints.openai.api_server \
        --host 0.0.0.0 \
        --port 9000 \
        --model Qwen/Qwen2.5-7B-Instruct \
        --gpu-memory-utilization 0.60 \
        --max-model-len 8128 &
    VLLM_PID=$!
    
    # Wait for vLLM to download the model and initialize
    log_info "Waiting 45 seconds for vLLM to initialize..."
    sleep 45

    log_info "Starting STT Server (port 9001)..."
    STT_SERVER_PORT=9001 python stt-server/server.py 2>&1 | tee -a stt.log &
    STT_PID=$!
    sleep 5

    log_info "Starting TTS Server (port 9002)..."
    TTS_SERVER_PORT=9002 python tts-server/server.py 2>&1 | tee -a tts.log &
    TTS_PID=$!
    sleep 5

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
    # Ensure no ghost processes from a previous crash are holding the ports
    fuser -k 9000/tcp 2>/dev/null || true
    fuser -k 9001/tcp 2>/dev/null || true
    fuser -k 9002/tcp 2>/dev/null || true
    fuser -k 8080/tcp 2>/dev/null || true

    export COQUI_TOS_AGREED=1

    install_deps
    setup_env
    start_services
}

main "$@"
