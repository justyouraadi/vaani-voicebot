#!/usr/bin/env bash
# ============================================================
# TBB-VaaniAI — One-Command Setup Script
# Validates prerequisites, downloads models, and starts services.
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

print_banner() {
    echo -e "${CYAN}"
    echo "╔══════════════════════════════════════════════╗"
    echo "║        🎙️  TBB-VaaniAI Setup Script         ║"
    echo "║   Ultra-Low Latency Voice AI Agent           ║"
    echo "╚══════════════════════════════════════════════╝"
    echo -e "${NC}"
}

log_info()    { echo -e "${BLUE}[INFO]${NC}  $1"; }
log_success() { echo -e "${GREEN}[OK]${NC}    $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC}  $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

check_command() {
    if command -v "$1" &> /dev/null; then
        log_success "$1 found: $(command -v "$1")"
        return 0
    else
        log_error "$1 not found. Please install it first."
        return 1
    fi
}

# ─────────────────────────────────────────────
# Step 1: Validate Prerequisites
# ─────────────────────────────────────────────
validate_prerequisites() {
    log_info "Checking prerequisites..."
    local errors=0

    # Docker
    if ! check_command docker; then
        ((errors++))
    fi

    # Docker Compose
    if docker compose version &> /dev/null; then
        log_success "Docker Compose found (plugin mode)"
    elif check_command docker-compose; then
        log_warn "Using standalone docker-compose. Consider upgrading to Docker Compose v2 plugin."
    else
        log_error "Docker Compose not found."
        ((errors++))
    fi

    # NVIDIA Driver
    if command -v nvidia-smi &> /dev/null; then
        local gpu_info
        gpu_info=$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null || echo "unknown")
        log_success "NVIDIA GPU detected: $gpu_info"
    else
        log_warn "nvidia-smi not found. GPU acceleration may not be available."
        log_warn "The system will attempt to run on CPU (significantly slower)."
    fi

    # NVIDIA Container Toolkit
    if docker info 2>/dev/null | grep -q "nvidia"; then
        log_success "NVIDIA Container Toolkit detected"
    else
        log_warn "NVIDIA Container Toolkit not detected in Docker."
        log_warn "GPU passthrough in containers may not work."
        log_warn "Install: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html"
    fi

    if [ "$errors" -gt 0 ]; then
        log_error "$errors critical prerequisite(s) missing. Please fix and retry."
        exit 1
    fi

    log_success "All prerequisites validated!"
}

# ─────────────────────────────────────────────
# Step 2: Setup Environment
# ─────────────────────────────────────────────
setup_environment() {
    log_info "Setting up environment..."

    cd "$PROJECT_DIR"

    if [ ! -f .env ]; then
        cp .env.example .env
        log_success "Created .env from .env.example"
        log_warn "Review and edit .env with your vLLM endpoint before starting."
    else
        log_success ".env already exists, skipping."
    fi
}

# ─────────────────────────────────────────────
# Step 3: Build & Start Services
# ─────────────────────────────────────────────
build_and_start() {
    log_info "Building Docker images (this may take a while on first run)..."
    cd "$PROJECT_DIR"

    docker compose build --parallel

    log_info "Starting services..."
    docker compose up -d

    log_info "Waiting for services to become healthy..."

    local max_wait=300
    local elapsed=0
    local interval=5

    while [ $elapsed -lt $max_wait ]; do
        local healthy=0
        local total=3

        for service in stt-server tts-server orchestrator; do
            local status
            status=$(docker compose ps --format json "$service" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('Health',''))" 2>/dev/null || echo "")
            if [ "$status" = "healthy" ]; then
                ((healthy++))
            fi
        done

        if [ "$healthy" -eq "$total" ]; then
            log_success "All services are healthy!"
            return 0
        fi

        echo -ne "\r${BLUE}[INFO]${NC}  Waiting... ($elapsed/${max_wait}s) — $healthy/$total healthy"
        sleep $interval
        ((elapsed += interval))
    done

    echo ""
    log_warn "Some services may not be healthy yet. Check with: docker compose ps"
}

# ─────────────────────────────────────────────
# Step 4: Print Summary
# ─────────────────────────────────────────────
print_summary() {
    echo ""
    echo -e "${CYAN}╔══════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║         🎙️  VaaniAI is Ready!               ║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  ${GREEN}🌐 Demo UI:${NC}        http://localhost:8080"
    echo -e "  ${GREEN}👂 STT Server:${NC}     http://localhost:8001/health"
    echo -e "  ${GREEN}🗣️ TTS Server:${NC}     http://localhost:8002/health"
    echo -e "  ${GREEN}🎛️ Orchestrator:${NC}   http://localhost:8080/health"
    echo ""
    echo -e "  ${YELLOW}📋 Logs:${NC}           docker compose logs -f"
    echo -e "  ${YELLOW}🛑 Stop:${NC}           docker compose down"
    echo -e "  ${YELLOW}📊 Benchmark:${NC}      ./scripts/benchmark.sh --test-e2e"
    echo ""
    echo -e "  ${RED}⚠️  Make sure your vLLM server is running at the URL in .env${NC}"
    echo ""
}

# ─────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────
main() {
    print_banner
    validate_prerequisites
    setup_environment
    build_and_start
    print_summary
}

main "$@"
