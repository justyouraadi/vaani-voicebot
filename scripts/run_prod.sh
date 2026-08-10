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
    
    # [STABILITY FIX] Guarantee a perfect PyTorch 2.3.1 golden environment inside the venv
    # PyTorch 2.4 broke transformers and vLLM. We pin everything to the stable era.
    pip install -q --upgrade pip
    pip install -q torch==2.3.1 torchvision==0.18.1 torchaudio==2.3.1 --index-url https://download.pytorch.org/whl/cu121
    
    # We combine these into a single command so that pip's resolver enforces the transformers pin
    # and prevents coqui-tts from silently upgrading transformers to 4.44.0 (which crashes vLLM)
    # We pin transformers==4.40.0 which contains LogitsWarper and is compatible with torch 2.3.1 DTensor.
    pip install -q "transformers==4.40.0" "vllm==0.5.3.post1" "numpy<2.0.0" "pyairports==2.1.1" pycountry \
        -r "$PROJECT_DIR/orchestrator/requirements.txt" \
        -r "$PROJECT_DIR/tts-server/requirements.txt" \
        -r "$PROJECT_DIR/stt-server/requirements.txt"

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
    STT_SERVER_PORT=9001 python stt-server/server.py &
    STT_PID=$!
    sleep 5

    log_info "Starting TTS Server (port 9002)..."
    TTS_SERVER_PORT=9002 python tts-server/server.py &
    TTS_PID=$!
    sleep 5

    log_info "Starting Orchestrator (port 8080)..."
    FRONTEND_DIR="$PROJECT_DIR/frontend" python orchestrator/main.py &
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
