#!/usr/bin/env bash
# Start the voice assistant: llama-server (Gemma 4 E2B, GPU) +
# llama-tts-server (Pocket TTS, CPU by default) + the browser front end.
#
# Startup is deliberately sequential: each model is loaded and confirmed
# healthy before the next process is allowed anywhere near the GPU. On a
# Jetson that ordering is not a nicety, it is the difference between working
# and an OOM kill halfway through a model load.
#
# Leave this running. Ctrl+C shuts all three down.
#
#   ./start.sh                   serve the UI on every interface (browse from your laptop)
#   ./start.sh --localhost       bind to 127.0.0.1 only
#   ./start.sh --no-warmup       skip the warm-up requests
#   ./start.sh --no-webui        just the two model servers
#   ./start.sh --no-drop-caches  do not free the page cache before each model load
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$REPO/logs"

BIND_ALL=1
WARMUP=1
WEBUI=1
DROP_CACHES=1
while [ $# -gt 0 ]; do
    case "$1" in
        --localhost)       BIND_ALL=0; shift ;;
        --no-warmup)       WARMUP=0; shift ;;
        --no-webui)        WEBUI=0; shift ;;
        --no-drop-caches)  DROP_CACHES=0; shift ;;
        -h|--help)         sed -n '2,16p' "$0" | sed 's/^# \?//'; exit 0 ;;
        *)                 echo "unknown option: $1" >&2; exit 2 ;;
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


def flag(value):
    if isinstance(value, str):
        return 1 if value.strip().lower() in ("1", "true", "yes", "on") else 0
    return 1 if value else 0


flat = {
    "LLM_PORT": cfg.get("llmPort", 8090),
    "TTS_PORT": cfg.get("ttsPort", 8100),
    "WEB_PORT": cfg.get("webUiPort", 8123),
    # 2048 is the safe default on an 8 GB Orin Nano. See the README before
    # raising it: the KV cache comes out of the same pool as the weights.
    "CTX": cfg.get("contextSize", 2048),
    "NGL": cfg.get("llmGpuLayers", 99),
    "TTS_THREADS": cfg.get("ttsThreads", 4),
    "TTS_ON_GPU": flag(cfg.get("ttsOnGpu", False)),
    "TTS_NGL": cfg.get("ttsGpuLayers", 99),
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

# The prebuilt tarball ships libggml*.so / libllama*.so / libmtmd.so beside the
# two binaries rather than installing them, so the loader has to be told where
# to look. Harmless for a source build, where the same files live there anyway.
BIN_DIR="$(dirname "$BIN_LLM")"
export LD_LIBRARY_PATH="$BIN_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

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

# ------------------------------------------------------- memory / page cache

meminfo_mb() {  # meminfo_mb <MemFree|MemAvailable|...>
    awk -v k="$1:" '$1 == k {v = $2/1024} END {printf "%d", v}' /proc/meminfo 2>/dev/null \
        || printf '0'
}

DROP_CACHES_WARNED=0

# Free the page cache immediately before a CUDA allocation.
#
# This is the single most important line in this script on a Jetson. NvMap,
# the Tegra GPU memory allocator, will not reclaim the Linux page cache to
# satisfy a request. If MemFree is low, cudaMalloc fails with
#   NvMapMemAllocInternalTagged error 12
# even when MemAvailable is showing several free gigabytes, because the kernel
# counts reclaimable cache as "available" and NvMap does not. Dropping the
# cache first turns that available memory into genuinely free memory.
#
# It is normal for MemFree to fall to ~80 MB while a model loads. As long as
# the cache was dropped just beforehand, the load still completes.
drop_caches() {  # drop_caches <what-is-about-to-load>
    local what="$1"
    [ "$DROP_CACHES" -eq 1 ] || return 0

    if [ "$(id -u)" -eq 0 ]; then
        sync
        echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true
    elif sudo -n true 2>/dev/null; then
        sudo -n sh -c 'sync; echo 3 > /proc/sys/vm/drop_caches' 2>/dev/null || true
    else
        if [ "$DROP_CACHES_WARNED" -eq 0 ]; then
            DROP_CACHES_WARNED=1
            warn "cannot free the page cache: sudo wants a password and nobody is here to type it."
            warn "on a Jetson this is how model loads fail with 'NvMapMemAllocInternalTagged"
            warn "error 12' even though free -m says there are gigabytes available."
            info "do one of these, then start again:"
            info "    sudo -v && ./start.sh          # cache the sudo timestamp first"
            info "    sudo ./start.sh                # or just run the whole thing as root"
            info "    sudo sh -c 'sync; echo 3 > /proc/sys/vm/drop_caches'   # by hand, right before this"
            info "or pass --no-drop-caches to stop being told about it."
        fi
        return 0
    fi

    ok "page cache freed before loading $what (MemFree now $(meminfo_mb MemFree) MB)"
}

step "Making room for the first model"
info "MemFree $(meminfo_mb MemFree) MB, MemAvailable $(meminfo_mb MemAvailable) MB"
info "NvMap allocates out of MemFree only, so MemAvailable is not the number that matters"

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

# What to say when the language model fails to load. Almost always memory, and
# almost always something else on the board is holding it.
llm_failure_hint() {
    local errlog="$LOG_DIR/llm.err.log"
    warn "something else may be holding GPU memory, or there was not enough free"
    warn "memory for NvMap at the moment of the allocation."
    if grep -qi 'NvMapMemAllocInternalTagged\|cudaMalloc failed\|out of memory' "$errlog" 2>/dev/null; then
        warn "the log says exactly that:"
        grep -i 'NvMapMemAllocInternalTagged\|cudaMalloc failed\|out of memory' "$errlog" \
            2>/dev/null | tail -n 3 | sed 's/^/        /'
    fi
    info "things worth checking, in order:"
    info "  1. free the page cache and try again:"
    info "         sudo sh -c 'sync; echo 3 > /proc/sys/vm/drop_caches'"
    info "  2. is another GPU workload running? many Jetsons ship with one."
    info "         systemctl list-units --type=service --state=running | grep -i 'nano\\|owl\\|docker\\|jetson'"
    info "         docker ps"
    info "     stop it for the session with 'sudo systemctl stop <service>'."
    info "     do NOT pkill it: services restart on failure and containers keep"
    info "     holding GPU memory after the visible process dies."
    info "  3. still tight? use a smaller quant: ./setup.sh --quant UD-Q2_K_XL"
    info "  4. close the desktop session, or run the board headless."
    info "see $errlog for the whole story."
}

wait_http() {   # wait_http <url> <timeout-s> <label> <pid>
    local url="$1" timeout="$2" label="$3" pid="$4" waited=0
    while [ "$waited" -lt "$timeout" ]; do
        if ! kill -0 "$pid" 2>/dev/null; then
            printf '    %s[x]%s %s\n' "$C_ERR" "$C_OFF" \
                "$label stopped while loading - see $LOG_DIR/" >&2
            return 1
        fi
        # -f is not decoration. llama-server answers /health with 503 while it
        # is still loading, and a bare `curl -s` treats a 503 as a success. Get
        # this wrong and the next server starts early, grabs GPU memory in the
        # middle of this one's load, and kills it.
        if curl -fs --max-time 2 "$url" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
        waited=$((waited + 1))
    done
    printf '    %s[x]%s %s\n' "$C_ERR" "$C_OFF" \
        "$label did not come up within ${timeout}s - see $LOG_DIR/" >&2
    return 1
}

# ----------------------------------------------------------- language model

step "Starting the part that listens and thinks"
info "Gemma 4 E2B on the GPU, $NGL layers, ${CTX} token context"

drop_caches "the language model"

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

T0=$(date +%s)
info "loading - expect 30 to 60 seconds. MemFree will dive to almost nothing"
info "on the way; that is fine as long as the cache was dropped first."
if ! wait_http "$LLM_URL/health" 600 "the thinking model" "$PID_LLM"; then
    llm_failure_hint
    exit 1
fi
ok "thinking model loaded ($(( $(date +%s) - T0 ))s), MemFree $(meminfo_mb MemFree) MB"

# ------------------------------------------------------------- speech model
#
# Nothing above this line is allowed to start until the language model is
# healthy. The whole point of the sequencing is that the GPU is handed over
# one model at a time.

step "Starting the part that speaks"

if [ "$TTS_ON_GPU" -eq 1 ]; then
    info "Pocket TTS on the GPU, $TTS_NGL layers - roughly 30x faster than the CPU path"
    warn "this needs a second CUDA context (~0.6 GB, plus compute buffers) next to"
    warn "Gemma. On an 8 GB board with a Q4 quant and a desktop session it usually"
    warn "does not fit, and fails during CUDA graph capture. If the speech model"
    warn "dies here, set ttsOnGpu back to false in config.local.json, or move to"
    warn "the UD-Q2_K_XL quant, or run headless."

    drop_caches "the speech model"

    "$BIN_TTS" \
        -m "$M_TTS" \
        --mmproj "$M_TTS_MMPROJ" \
        --tts-speaker-file "$M_VOICE" \
        -ngl "$TTS_NGL" \
        --threads "$TTS_THREADS" \
        --host 127.0.0.1 \
        --port "$TTS_PORT" \
        >"$LOG_DIR/tts.out.log" 2>"$LOG_DIR/tts.err.log" &
else
    info "Pocket TTS on the CPU, $TTS_THREADS of the 6 A78AE cores"
    info "the GPU stays entirely with the language model, which is the scarce thing here"
    info "expect about 0.16x realtime: a short sentence takes ~19s to speak."
    info "fine for testing, not for conversation. See 'ttsOnGpu' in the README."

    # An empty CUDA_VISIBLE_DEVICES hides the GPU from this child completely.
    #
    # -ngl 0 is NOT enough on its own. On a CUDA build the mtmd audio projector
    # allocates CUDA buffers regardless of the layer count, and when Gemma
    # already owns the GPU that allocation fails and takes the speech server
    # down with a ggml assert. Empty is what works here; the Windows parent
    # project uses CUDA_VISIBLE_DEVICES=-1 for the same purpose.
    CUDA_VISIBLE_DEVICES="" \
    "$BIN_TTS" \
        -m "$M_TTS" \
        --mmproj "$M_TTS_MMPROJ" \
        --tts-speaker-file "$M_VOICE" \
        -ngl 0 \
        --threads "$TTS_THREADS" \
        --host 127.0.0.1 \
        --port "$TTS_PORT" \
        >"$LOG_DIR/tts.out.log" 2>"$LOG_DIR/tts.err.log" &
fi
PID_TTS=$!
CHILDREN+=("$PID_TTS")

if ! wait_http "$TTS_URL/health" 600 "the speaking model" "$PID_TTS"; then
    if [ "$TTS_ON_GPU" -eq 1 ]; then
        warn "GPU speech did not fit alongside the language model. Set"
        warn "  \"ttsOnGpu\": false"
        warn "in config.local.json and start again."
    else
        warn "if the log ends in a ggml assert about a CUDA buffer, the binary was"
        warn "built with CUDA and the audio projector tried to allocate on the GPU"
        warn "anyway. This script already starts it with CUDA_VISIBLE_DEVICES empty;"
        warn "check nothing in your environment is overriding that."
    fi
    exit 1
fi
ok "speaking model loaded ($(( $(date +%s) - T0 ))s), MemFree $(meminfo_mb MemFree) MB"

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
        if wait_http "http://127.0.0.1:$WEB_PORT/api/health" 30 "the web UI" "$PID_WEB"; then
            ok "web UI on $WEB_SHOWN"
        else
            warn "carrying on without the web UI - see $LOG_DIR/webui.err.log"
            PID_WEB=""
        fi
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
if [ "$TTS_ON_GPU" -eq 0 ]; then
    info "Speech is on the CPU, which is slow (~19s for a short sentence). The text"
    info "answer itself arrives in well under a second."
fi
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
