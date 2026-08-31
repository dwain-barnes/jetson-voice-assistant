#!/usr/bin/env bash
# Start the voice assistant: llama-server (Gemma 4 E2B, GPU) +
# llama-tts-server (Pocket TTS, CPU) + the browser front end.
#
# Leave this running. Ctrl+C shuts all three down.
#
#   ./start.sh              serve the UI on every interface (browse from your laptop)
#   ./start.sh --localhost  bind to 127.0.0.1 only
#   ./start.sh --no-warmup  skip the warm-up requests
#   ./start.sh --no-webui   just the two model servers
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$REPO/logs"

BIND_ALL=1
WARMUP=1
WEBUI=1
while [ $# -gt 0 ]; do
    case "$1" in
        --localhost)  BIND_ALL=0; shift ;;
        --no-warmup)  WARMUP=0; shift ;;
        --no-webui)   WEBUI=0; shift ;;
        -h|--help)    sed -n '2,10p' "$0" | sed 's/^# \?//'; exit 0 ;;
        *)            echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

if [ -t 1 ]; then
    C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'
    C_DIM=$'\033[90m'; C_HEAD=$'\033[1m'; C_CYAN=$'\033[36m'; C_OFF=$'\033[0m'
else
    C_OK=; C_WARN=; C_ERR=; C_DIM=; C_HEAD=; C_CYAN=; C_OFF=
fi
step() { printf '\n%s==> %s%s\n' "$C_HEAD" "$*" "$C_OFF"; }
ok()   { printf '    %s[ok]%s %s\n'   "$C_OK"   "$C_OFF" "$*"; }
info() { printf '    %s%s%s\n'        "$C_DIM"  "$*"     "$C_OFF"; }
warn() { printf '    %s[!]%s %s\n'    "$C_WARN" "$C_OFF" "$*"; }
die()  { printf '    %s[x]%s %s\n'    "$C_ERR"  "$C_OFF" "$*" >&2; exit 1; }

mkdir -p "$LOG_DIR"

# ------------------------------------------------------------------ config

[ -f "$REPO/config.local.json" ] || die "config.local.json is missing. Run ./setup.sh first."

# Read the config once and eval it as shell assignments, so the rest of the
# script is plain variables rather than a jq/python call per field.
eval "$(python3 - "$REPO/config.json" "$REPO/config.local.json" <<'PY'
import json, shlex, sys
cfg = {}
for path in sys.argv[1:]:
    try:
        with open(path, encoding="utf-8-sig") as f:
            cfg.update(json.load(f))
    except FileNotFoundError:
        pass
flat = {
    "LLM_PORT": cfg.get("llmPort", 8090),
    "TTS_PORT": cfg.get("ttsPort", 8100),
    "WEB_PORT": cfg.get("webUiPort", 8123),
    "CTX": cfg.get("contextSize", 4096),
    "NGL": cfg.get("llmGpuLayers", 99),
    "TTS_THREADS": cfg.get("ttsThreads", 4),
    "BIN_LLM": cfg.get("bin", {}).get("llamaServer", ""),
    "BIN_TTS": cfg.get("bin", {}).get("llamaTtsServer", ""),
    "M_LLM": cfg.get("models", {}).get("llm", ""),
    "M_LLM_MMPROJ": cfg.get("models", {}).get("llmMmproj", ""),
    "M_TTS": cfg.get("models", {}).get("tts", ""),
    "M_TTS_MMPROJ": cfg.get("models", {}).get("ttsMmproj", ""),
    "M_VOICE": cfg.get("models", {}).get("voice", ""),
}
for k, v in flat.items():
    print("%s=%s" % (k, shlex.quote(str(v))))
PY
)"

LLM_URL="http://127.0.0.1:$LLM_PORT"
TTS_URL="http://127.0.0.1:$TTS_PORT"

echo
printf '  %sJetson Voice Assistant%s\n' "$C_HEAD" "$C_OFF"
info 'starting up - the first run takes a couple of minutes while the models load'

step "Checking everything is where it should be"
for pair in "llama-server:$BIN_LLM" "llama-tts-server:$BIN_TTS"; do
    [ -x "${pair#*:}" ] || die "${pair%%:*} is missing or not executable: ${pair#*:} - run ./setup.sh"
done
for pair in "language model:$M_LLM" "vision/audio projector:$M_LLM_MMPROJ" \
            "speech model:$M_TTS" "speech projector:$M_TTS_MMPROJ" \
            "reference voice:$M_VOICE"; do
    [ -s "${pair#*:}" ] || die "the ${pair%%:*} is missing: ${pair#*:} - run ./setup.sh"
done
ok "all files present"

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1; }
for port in "$LLM_PORT" "$TTS_PORT"; do
    ! port_busy "$port" || die "port $port is already in use - another copy may still be running"
done
ok "ports $LLM_PORT and $TTS_PORT are free"

# ---------------------------------------------------------------- shutdown

CHILDREN=()
SHUTTING_DOWN=0

shutdown() {
    [ "$SHUTTING_DOWN" -eq 0 ] || return
    SHUTTING_DOWN=1
    printf '\n  %sShutting down...%s\n' "$C_WARN" "$C_OFF"
    for pid in "${CHILDREN[@]:-}"; do
        [ -n "$pid" ] || continue
        kill -TERM "$pid" 2>/dev/null || true
    done
    # Give them a moment to close their sockets, then insist.
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        local alive=0
        for pid in "${CHILDREN[@]:-}"; do
            [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && alive=1
        done
        [ "$alive" -eq 1 ] || break
        sleep 0.5
    done
    for pid in "${CHILDREN[@]:-}"; do
        [ -n "$pid" ] && kill -KILL "$pid" 2>/dev/null || true
    done
    printf '  %sStopped.%s\n\n' "$C_DIM" "$C_OFF"
}
trap 'shutdown; exit 0' INT TERM
trap 'shutdown' EXIT

wait_http() {   # wait_http <url> <timeout-s> <label> <pid>
    local url="$1" timeout="$2" label="$3" pid="$4" waited=0
    while [ "$waited" -lt "$timeout" ]; do
        if ! kill -0 "$pid" 2>/dev/null; then
            die "$label stopped while loading - see $LOG_DIR/"
        fi
        if curl -fs --max-time 2 "$url" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
        waited=$((waited + 1))
    done
    die "$label did not come up within ${timeout}s - see $LOG_DIR/"
}

# ----------------------------------------------------------- language model

step "Starting the part that listens and thinks"
info "Gemma 4 E2B on the GPU, $NGL layers, ${CTX} token context"

# --reasoning off is not optional. Gemma 4 is a thinking model; left on, it
# spends the whole token budget reasoning and returns empty content, which the
# speech server then refuses.
"$BIN_LLM" \
    -m "$M_LLM" \
    --mmproj "$M_LLM_MMPROJ" \
    -ngl "$NGL" \
    -c "$CTX" \
    --reasoning off \
    --host 127.0.0.1 \
    --port "$LLM_PORT" \
    >"$LOG_DIR/llm.out.log" 2>"$LOG_DIR/llm.err.log" &
PID_LLM=$!
CHILDREN+=("$PID_LLM")

# ------------------------------------------------------------- speech model

step "Starting the part that speaks"
info "Pocket TTS on the CPU, $TTS_THREADS of the 6 A78AE cores"
info "the GPU stays entirely with the language model, which is the scarce thing here"

# CUDA_VISIBLE_DEVICES=-1 hides the iGPU from this child. On a Jetson the GPU
# and the CPU share one pool of memory, so this does not save RAM - it saves
# contention, and keeps the LLM's KV cache from being squeezed mid-sentence.
CUDA_VISIBLE_DEVICES=-1 \
"$BIN_TTS" \
    -m "$M_TTS" \
    --mmproj "$M_TTS_MMPROJ" \
    --tts-speaker-file "$M_VOICE" \
    -ngl 0 \
    --threads "$TTS_THREADS" \
    --host 127.0.0.1 \
    --port "$TTS_PORT" \
    >"$LOG_DIR/tts.out.log" 2>"$LOG_DIR/tts.err.log" &
PID_TTS=$!
CHILDREN+=("$PID_TTS")

# ------------------------------------------------------------------ health

step "Waiting for both to finish loading"
T0=$(date +%s)
wait_http "$LLM_URL/health" 600 "the thinking model" "$PID_LLM"
ok "thinking model loaded ($(( $(date +%s) - T0 ))s)"
wait_http "$TTS_URL/health" 600 "the speaking model" "$PID_TTS"
ok "speaking model loaded ($(( $(date +%s) - T0 ))s)"

# ----------------------------------------------------------------- warm-up

if [ "$WARMUP" -eq 1 ]; then
    step "Warming up"
    info "the first request of each kind allocates buffers and is much slower than"
    info "the rest; we pay that cost now rather than in the middle of a conversation"

    W=$(date +%s)
    if curl -fs --max-time 300 -X POST "$LLM_URL/v1/chat/completions" \
        -H 'Content-Type: application/json' \
        -d '{"model":"gemma","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}' \
        >/dev/null; then
        ok "thinking model warm ($(( $(date +%s) - W ))s)"
    else
        warn "warm-up question failed - see $LOG_DIR/llm.err.log"
    fi

    # The TTS warm-up matters more than the LLM one: the first synthesis
    # allocates the whole audio graph, and on ARM cores that is tens of seconds.
    W=$(date +%s)
    WARM_WAV="$LOG_DIR/warmup.wav"
    if curl -fs --max-time 300 -X POST "$TTS_URL/v1/audio/speech" \
        -H 'Content-Type: application/json' \
        -d '{"input":"Ready.","response_format":"wav","max_seconds":5}' \
        -o "$WARM_WAV" && [ "$(stat -c%s "$WARM_WAV" 2>/dev/null || echo 0)" -gt 44 ]; then
        ok "speaking model warm ($(( $(date +%s) - W ))s)"
    else
        warn "warm-up speech failed - the first real reply will be slow"
        warn "see $LOG_DIR/tts.err.log"
    fi
    rm -f "$WARM_WAV"
fi

# ------------------------------------------------------------------ web UI

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$LAN_IP" ] || LAN_IP="127.0.0.1"
if [ "$BIND_ALL" -eq 1 ]; then
    WEB_HOST=0.0.0.0
    WEB_SHOWN="http://$LAN_IP:$WEB_PORT"
else
    WEB_HOST=127.0.0.1
    WEB_SHOWN="http://localhost:$WEB_PORT"
fi

PID_WEB=""
if [ "$WEBUI" -eq 1 ]; then
    step "Starting the browser front end"
    if port_busy "$WEB_PORT"; then
        warn "port $WEB_PORT is already in use, so the web UI is skipped"
    else
        python3 "$REPO/scripts/webui-server.py" \
            --host "$WEB_HOST" --port "$WEB_PORT" \
            --llm-url "$LLM_URL" --tts-url "$TTS_URL" \
            >"$LOG_DIR/webui.out.log" 2>"$LOG_DIR/webui.err.log" &
        PID_WEB=$!
        CHILDREN+=("$PID_WEB")
        wait_http "http://127.0.0.1:$WEB_PORT/api/health" 30 "the web UI" "$PID_WEB"
        ok "web UI on $WEB_SHOWN"
    fi
fi

# ------------------------------------------------------------------- ready

TOTAL=$(( $(date +%s) - T0 ))
echo
printf '  %s======================================================%s\n' "$C_OK" "$C_OFF"
printf '  %s READY%s\n' "$C_OK" "$C_OFF"
printf '  %s======================================================%s\n' "$C_OK" "$C_OFF"
echo
printf '   Both models are loaded and warm (%ss).\n' "$TOTAL"
echo
if [ -n "$PID_WEB" ]; then
    printf '   Open this from any device on your network:\n'
    printf '       %s%s%s\n' "$C_CYAN" "$WEB_SHOWN" "$C_OFF"
    echo
    if [ "$BIND_ALL" -eq 1 ]; then
        info "Typing works anywhere. The microphone button will not: browsers only"
        info "grant mic access to secure origins, and this is plain http over the LAN."
        info "Either browse from the Jetson itself at http://localhost:$WEB_PORT, or in"
        info "Chrome add $WEB_SHOWN to:"
        info "    chrome://flags/#unsafely-treat-insecure-origin-as-secure"
        echo
    fi
fi
printf '   Or from a terminal on the Jetson:\n'
printf '       %spython3 scripts/voice-chat.py --text "Tell me a joke."%s\n' "$C_CYAN" "$C_OFF"
echo
info "Leave this running. Ctrl+C here stops everything."
info "Logs: $LOG_DIR/"
echo

# Watch the children rather than blocking on wait, so a crashed server is
# reported instead of silently leaving a half-dead assistant behind.
while true; do
    kill -0 "$PID_LLM" 2>/dev/null || { die "the thinking model stopped - see $LOG_DIR/llm.err.log"; }
    kill -0 "$PID_TTS" 2>/dev/null || { die "the speaking model stopped - see $LOG_DIR/tts.err.log"; }
    if [ -n "$PID_WEB" ] && ! kill -0 "$PID_WEB" 2>/dev/null; then
        warn "the web UI stopped - see $LOG_DIR/webui.err.log"
        PID_WEB=""
    fi
    sleep 2
done
