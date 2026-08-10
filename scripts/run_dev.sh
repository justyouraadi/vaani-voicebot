#!/usr/bin/env bash
# ============================================================
# TBB-VaaniAI — Local Dev Runner (Mac-friendly)
# Runs all services locally without Docker or GPU.
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
VENV_DIR="$PROJECT_DIR/.venv"

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
    echo "║    🎙️  VaaniAI Local Dev Runner (Mac)        ║"
    echo "║    No Docker • No GPU • CPU-only             ║"
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
# Step 1: Setup Python venv
# ─────────────────────────────────────────────
setup_venv() {
    # Find Python 3.12 (better compatibility for ML packages)
    local PYTHON_BIN=""
    if command -v python3.12 &>/dev/null; then
        PYTHON_BIN="python3.12"
    elif [ -f "/usr/local/bin/python3.12" ]; then
        PYTHON_BIN="/usr/local/bin/python3.12"
    elif [ -f "/usr/local/opt/python@3.12/bin/python3.12" ]; then
        PYTHON_BIN="/usr/local/opt/python@3.12/bin/python3.12"
    elif [ -f "/usr/local/Cellar/python@3.12/3.12.13_4/bin/python3.12" ]; then
        PYTHON_BIN="/usr/local/Cellar/python@3.12/3.12.13_4/bin/python3.12"
    else
        log_warn "Python 3.12 not found, using default python3"
        PYTHON_BIN="python3"
    fi

    log_info "Using Python: $PYTHON_BIN ($($PYTHON_BIN --version 2>&1))"

    if [ ! -d "$VENV_DIR" ]; then
        log_info "Creating virtual environment..."
        "$PYTHON_BIN" -m venv "$VENV_DIR"
        log_success "Virtual environment created at $VENV_DIR"
    fi

    source "$VENV_DIR/bin/activate"
    log_success "Activated venv: $(python --version)"

    # Upgrade pip
    pip install --upgrade pip -q

    # Install common dependencies
    log_info "Installing dependencies..."
    pip install -q \
        fastapi \
        "uvicorn[standard]" \
        websockets \
        httpx \
        openai \
        numpy \
        pydantic \
        pydantic-settings \
        python-dotenv \
        aiofiles \
        edge-tts \
        soundfile

    # Try to install whisper (may fail on some Python versions)
    log_info "Installing OpenAI Whisper (this may take a few minutes)..."
    pip install -q openai-whisper 2>/dev/null || {
        log_warn "openai-whisper installation failed. STT will run in mock mode."
        log_warn "You can try: pip install faster-whisper"
    }

    log_success "Dependencies installed"
}

# ─────────────────────────────────────────────
# Step 2: Check ffmpeg
# ─────────────────────────────────────────────
check_ffmpeg() {
    if command -v ffmpeg &>/dev/null; then
        log_success "ffmpeg found"
    else
        log_warn "ffmpeg not found. Installing via brew..."
        brew install ffmpeg 2>/dev/null || log_error "Failed to install ffmpeg. TTS quality may be limited."
    fi
}

# ─────────────────────────────────────────────
# Step 3: Setup .env
# ─────────────────────────────────────────────
setup_env() {
    if [ ! -f "$PROJECT_DIR/.env" ]; then
        cat > "$PROJECT_DIR/.env" << 'EOF'
# Local Dev Configuration
VLLM_BASE_URL=http://localhost:11434/v1
VLLM_MODEL=qwen2.5:7b
VLLM_API_KEY=ollama
LLM_MAX_TOKENS=256
LLM_TEMPERATURE=0.7

STT_SERVER_URL=ws://localhost:8001/ws/transcribe
TTS_SERVER_URL=http://localhost:8002/synthesize

WHISPER_MODEL=base
WHISPER_LANGUAGE=hi

VAD_ENERGY_THRESHOLD=300
VAD_MIN_SILENCE_MS=500

ORCHESTRATOR_HOST=0.0.0.0
ORCHESTRATOR_PORT=8080
LOG_LEVEL=INFO
EOF
        log_success "Created .env for local dev (using Ollama for LLM)"
    fi
}

# ─────────────────────────────────────────────
# Step 4: Start Services
# ─────────────────────────────────────────────
start_services() {
    source "$VENV_DIR/bin/activate"
    cd "$PROJECT_DIR"

    # Load .env
    set -a
    source .env 2>/dev/null || true
    set +a

    echo ""
    log_info "Starting STT server (port 8001)..."
    python stt-server/server_dev.py &
    STT_PID=$!
    sleep 1

    log_info "Starting TTS server (port 8002)..."
    python tts-server/server_dev.py &
    TTS_PID=$!
    sleep 1

    log_info "Starting Orchestrator (port 8090)..."
    FRONTEND_DIR="$PROJECT_DIR/frontend" python orchestrator/main.py &
    ORCH_PID=$!
    sleep 2

    echo ""
    echo -e "${CYAN}╔══════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║         🎙️  VaaniAI is Running!              ║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  ${GREEN}🌐 Demo UI:${NC}        http://localhost:8090"
    echo -e "  ${GREEN}👂 STT Server:${NC}     http://localhost:8001/health"
    echo -e "  ${GREEN}🗣️ TTS Server:${NC}     http://localhost:8002/health"
    echo ""

    # Check for Ollama
    if command -v ollama &>/dev/null; then
        echo -e "  ${GREEN}🧠 LLM:${NC}           Ollama detected — using local LLM"
    else
        echo -e "  ${YELLOW}🧠 LLM:${NC}           Ollama NOT found — install for full pipeline"
        echo -e "                    ${YELLOW}brew install ollama${NC}"
        echo -e "                    ${YELLOW}ollama pull qwen2.5:7b${NC}"
    fi
    echo ""
    echo -e "  ${YELLOW}Press Ctrl+C to stop all services${NC}"
    echo ""

    # Wait for all background jobs
    wait
}

# ─────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────
main() {
    print_banner
    cd "$PROJECT_DIR"
    check_ffmpeg
    setup_venv
    setup_env
    start_services
}

main "$@"
