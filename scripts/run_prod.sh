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
    kill $(jobs -p) 2>/dev/null || true
    wait 2>/dev/null || true
    log_success "All services stopped"
}

trap cleanup EXIT INT TERM

# ─────────────────────────────────────────────
# Step 1: Install Dependencies
# ─────────────────────────────────────────────
install_deps() {
    log_info "Installing system dependencies (ffmpeg)..."
    apt-get update -yqq && apt-get install -yqq ffmpeg

    log_info "Installing Python requirements (this may take a few minutes)..."
    pip install -q -r "$PROJECT_DIR/orchestrator/requirements.txt"
    pip install -q -r "$PROJECT_DIR/tts-server/requirements.txt"
    pip install -q -r "$PROJECT_DIR/stt-server/requirements.txt"
    pip install -q vllm

    log_success "All dependencies installed!"
}

# ─────────────────────────────────────────────
# Step 2: Setup .env
# ─────────────────────────────────────────────
setup_env() {
    if [ ! -f "$PROJECT_DIR/.env" ]; then
        log_info "Creating production .env file..."
        cat > "$PROJECT_DIR/.env" << 'EOF'
VLLM_BASE_URL=http://localhost:8000/v1
VLLM_MODEL=Qwen/Qwen2.5-7B-Instruct
VLLM_API_KEY=EMPTY
LLM_MAX_TOKENS=256
LLM_TEMPERATURE=0.7

STT_SERVER_URL=ws://localhost:8001/ws/transcribe
TTS_SERVER_URL=http://localhost:8002/synthesize

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
    log_info "Starting vLLM Server (port 8000)..."
    VLLM_USE_V1=0 python -m vllm.entrypoints.openai.api_server \
        --host 0.0.0.0 \
        --port 8000 \
        --model Qwen/Qwen2.5-7B-Instruct \
        --gpu-memory-utilization 0.60 \
        --max-model-len 8128 &
    VLLM_PID=$!
    
    # Wait for vLLM to download the model and initialize
    log_info "Waiting 45 seconds for vLLM to initialize..."
    sleep 45

    log_info "Starting STT Server (port 8001)..."
    python stt-server/server.py &
    STT_PID=$!
    sleep 5

    log_info "Starting TTS Server (port 8002)..."
    python tts-server/server.py &
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
    install_deps
    setup_env
    start_services
}

main "$@"
