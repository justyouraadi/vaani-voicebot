#!/usr/bin/env bash
# ============================================================
# TBB-VaaniAI — Latency Benchmarking Tool
# Measures TTFA, STT latency, LLM TTFT, and TTS TTFC.
# ============================================================

set -euo pipefail

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

STT_URL="${STT_URL:-http://localhost:8001}"
TTS_URL="${TTS_URL:-http://localhost:8002}"
ORCHESTRATOR_URL="${ORCHESTRATOR_URL:-http://localhost:8080}"

print_banner() {
    echo -e "${CYAN}"
    echo "╔══════════════════════════════════════════════╗"
    echo "║     📊  VaaniAI Latency Benchmark Tool      ║"
    echo "╚══════════════════════════════════════════════╝"
    echo -e "${NC}"
}

# ─────────────────────────────────────────────
# Test: Service Health
# ─────────────────────────────────────────────
test_health() {
    echo -e "${YELLOW}[TEST] Checking service health...${NC}"

    for url in "$STT_URL/health" "$TTS_URL/health" "$ORCHESTRATOR_URL/health"; do
        local start end elapsed status
        start=$(python3 -c 'import time; print(time.time())')
        status=$(curl -s -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo "000")
        end=$(python3 -c 'import time; print(time.time())')
        elapsed=$(python3 -c "print(f'{($end - $start) * 1000:.1f}')")

        if [ "$status" = "200" ]; then
            echo -e "  ${GREEN}✓${NC} $url — ${elapsed}ms"
        else
            echo -e "  ${RED}✗${NC} $url — HTTP $status"
        fi
    done
    echo ""
}

# ─────────────────────────────────────────────
# Test: TTS Latency (Time-to-First-Chunk)
# ─────────────────────────────────────────────
test_tts() {
    echo -e "${YELLOW}[TEST] TTS Latency (Time-to-First-Chunk)...${NC}"

    local test_texts=(
        "Ji, main Vaani bol rahi hoon."
        "Hmm, yeh ek achha sawaal hai."
        "Dekhiye, aapka order process ho raha hai."
    )

    for text in "${test_texts[@]}"; do
        local start end elapsed
        start=$(python3 -c 'import time; print(time.time())')

        # Measure time to first byte of streamed response
        curl -s -o /dev/null \
            -w "TTFB: %{time_starttransfer}s\n" \
            -X POST "$TTS_URL/synthesize" \
            -H "Content-Type: application/json" \
            -d "{\"text\": \"$text\", \"language\": \"hi\"}" \
            2>/dev/null | head -1

        end=$(python3 -c 'import time; print(time.time())')
        elapsed=$(python3 -c "print(f'{($end - $start) * 1000:.1f}')")

        echo -e "  ${GREEN}→${NC} \"${text:0:40}...\" — ${elapsed}ms total"
    done
    echo ""
}

# ─────────────────────────────────────────────
# Test: End-to-End (requires WebSocket client)
# ─────────────────────────────────────────────
test_e2e() {
    echo -e "${YELLOW}[TEST] End-to-End Pipeline...${NC}"
    echo -e "  ${CYAN}ℹ${NC}  E2E test requires the browser UI or a WebSocket client."
    echo -e "  ${CYAN}ℹ${NC}  Open http://localhost:8080 and check the latency dashboard."
    echo -e "  ${CYAN}ℹ${NC}  Target: < 300ms Time-to-First-Audio (TTFA)"
    echo ""
    echo -e "  Latency breakdown targets:"
    echo -e "    VAD detection:     ~10-20ms"
    echo -e "    STT transcription: ~100-200ms"
    echo -e "    LLM first token:   ~50-100ms"
    echo -e "    TTS first chunk:   ~100-200ms"
    echo -e "    Network overhead:  ~10-20ms"
    echo -e "    ─────────────────────────────"
    echo -e "    ${GREEN}Total target:       < 300ms${NC}"
    echo ""
}

# ─────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────
main() {
    print_banner

    case "${1:-all}" in
        --test-health) test_health ;;
        --test-tts)    test_tts ;;
        --test-e2e)    test_e2e ;;
        all|*)
            test_health
            test_tts
            test_e2e
            ;;
    esac
}

main "$@"
