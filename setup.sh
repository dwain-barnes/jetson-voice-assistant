#!/usr/bin/env bash
# One-time setup for the Jetson Orin Nano Super voice assistant.
#
# Installs build dependencies, builds a patched llama.cpp for CUDA compute 8.7,
# downloads the models, and writes config.local.json.
#
# Safe to run more than once: anything already on disk is left alone.
#
#   ./setup.sh                 normal run
#   ./setup.sh --quant Q4_K_M  pick a different LLM quant
#   ./setup.sh --skip-build    only fetch models
#   ./setup.sh --skip-models   only build
#   ./setup.sh --force         re-resolve every path
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLAMA_DIR="$REPO/llama.cpp"
BUILD_DIR="$LLAMA_DIR/build"
MODELS_DIR="$REPO/models"
CONFIG_LOCAL="$REPO/config.local.json"

LLAMA_COMMIT="9f0d017"
CUDA_ARCH=87                      # Orin = Ampere, compute capability 8.7

LLM_REPO="unsloth/gemma-4-E2B-it-GGUF"
LLM_QUANT="UD-Q4_K_XL"            # 2.97 GiB - see the memory budget in README
LLM_MMPROJ="mmproj-F16.gguf"      # 0.92 GiB; CUDA on Orin runs F16 natively
TTS_REPO="EryriLabs/pocket-tts-en-GGUF"
TTS_FILES=(pocket-tts-en.gguf mmproj-pocket-tts-en.gguf)
VOICE_REPO="kyutai/tts-voices"
VOICE_FILE="unmute-prod-website/default_voice.wav"

SKIP_BUILD=0
SKIP_MODELS=0
FORCE=0

while [ $# -gt 0 ]; do
    case "$1" in
        --quant)       LLM_QUANT="$2"; shift 2 ;;
        --quant=*)     LLM_QUANT="${1#*=}"; shift ;;
        --skip-build)  SKIP_BUILD=1; shift ;;
        --skip-models) SKIP_MODELS=1; shift ;;
        --force)       FORCE=1; shift ;;
        -h|--help)     sed -n '2,13p' "$0" | sed 's/^# \?//'; exit 0 ;;
        *)             echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

LLM_FILE="gemma-4-E2B-it-${LLM_QUANT}.gguf"

# ------------------------------------------------------------------ output

if [ -t 1 ]; then
    C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'
    C_DIM=$'\033[90m'; C_HEAD=$'\033[1m'; C_OFF=$'\033[0m'
else
    C_OK=; C_WARN=; C_ERR=; C_DIM=; C_HEAD=; C_OFF=
fi
step() { printf '\n%s==> %s%s\n' "$C_HEAD" "$*" "$C_OFF"; }
ok()   { printf '    %s[ok]%s %s\n'   "$C_OK"   "$C_OFF" "$*"; }
info() { printf '    %s%s%s\n'        "$C_DIM"  "$*"     "$C_OFF"; }
warn() { printf '    %s[!]%s %s\n'    "$C_WARN" "$C_OFF" "$*"; }
die()  { printf '    %s[x]%s %s\n'    "$C_ERR"  "$C_OFF" "$*" >&2; exit 1; }

echo
printf '  %sJetson Voice Assistant - setup%s\n' "$C_HEAD" "$C_OFF"
info 'everything runs on this board; nothing is sent anywhere'

# ------------------------------------------------------------- is a Jetson?

step "Checking the board"

IS_JETSON=0
if [ -f /etc/nv_tegra_release ]; then
    IS_JETSON=1
    ok "$(head -n1 /etc/nv_tegra_release)"
elif [ -f /proc/device-tree/model ] && tr -d '\0' < /proc/device-tree/model | grep -qi 'jetson\|orin'; then
    IS_JETSON=1
    ok "$(tr -d '\0' < /proc/device-tree/model)"
elif command -v jetson_release >/dev/null 2>&1; then
    IS_JETSON=1
    ok "jetson_release found"
fi

if [ "$IS_JETSON" -eq 0 ]; then
    warn "this does not look like a Jetson (no /etc/nv_tegra_release)."
    warn "the build flags below target CUDA compute 8.7 (Orin) and will not"
    warn "produce useful binaries elsewhere."
    if [ -t 0 ]; then
        read -r -p "    carry on anyway? [y/N] " reply
        case "$reply" in [Yy]*) ;; *) exit 1 ;; esac
    else
        die "refusing to run unattended on a non-Jetson; re-run from a terminal to override."
    fi
fi

ARCH="$(uname -m)"
[ "$ARCH" = "aarch64" ] || warn "architecture is $ARCH, not aarch64 - expect trouble"

TOTAL_MB=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)
info "RAM (shared with the GPU): ${TOTAL_MB} MB"
if [ "$TOTAL_MB" -lt 6500 ]; then
    warn "less than ~7 GB visible - the defaults here assume the 8 GB Orin Nano."
fi

if command -v nvcc >/dev/null 2>&1; then
    ok "$(nvcc --version | tail -n1 | sed 's/^ *//')"
elif [ -x /usr/local/cuda/bin/nvcc ]; then
    export PATH="/usr/local/cuda/bin:$PATH"
    ok "found nvcc at /usr/local/cuda/bin/nvcc (added to PATH for this run)"
else
    warn "nvcc is not on PATH. JetPack usually puts it in /usr/local/cuda/bin."
    warn "install it with:  sudo apt install nvidia-cuda-dev  (or reflash JetPack 6)"
fi

# ----------------------------------------------------------- swap / memory

step "Checking swap"

SWAP_MB=$(awk '/SwapTotal/ {printf "%d", $2/1024}' /proc/meminfo)
if [ "$SWAP_MB" -ge 4096 ]; then
    ok "${SWAP_MB} MB of swap - plenty for the build"
else
    warn "only ${SWAP_MB} MB of swap. Compiling the CUDA kernels can peak well"
    warn "past 8 GB and the OOM killer will end the build hours in."
    info "JetPack ships zram (compressed RAM swap), which does not help much here."
    info "Add a real swap file on the NVMe/SD card before building:"
    info "    sudo fallocate -l 8G /swapfile && sudo chmod 600 /swapfile"
    info "    sudo mkswap /swapfile && sudo swapon /swapfile"
    info "    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab"
    info "It is only needed for the build; you can swapoff afterwards."
fi

if command -v nvpmodel >/dev/null 2>&1; then
    info "tip: 'sudo nvpmodel -m 2 && sudo jetson_clocks' selects the 25W"
    info "     Super profile, which roughly halves both build and inference time."
fi

# ------------------------------------------------------------ dependencies

step "Installing build dependencies"

APT_PKGS=(build-essential cmake git curl ca-certificates pkg-config
          python3 python3-pip ffmpeg alsa-utils libgomp1)
MISSING=()
for p in "${APT_PKGS[@]}"; do
    dpkg -s "$p" >/dev/null 2>&1 || MISSING+=("$p")
done

if [ ${#MISSING[@]} -eq 0 ]; then
    ok "all apt packages already installed"
else
    info "installing: ${MISSING[*]}"
    sudo apt-get update
    sudo apt-get install -y "${MISSING[@]}"
    ok "apt packages installed"
fi

if ! python3 -c 'import huggingface_hub' >/dev/null 2>&1; then
    info "installing huggingface_hub for the downloads"
    python3 -m pip install --user --upgrade huggingface_hub || \
        warn "pip install failed; setup will fall back to plain curl downloads"
else
    ok "huggingface_hub already installed"
fi

# ------------------------------------------------------------------- build

if [ "$SKIP_BUILD" -eq 1 ]; then
    step "Skipping the build (--skip-build)"
elif [ "$FORCE" -eq 0 ] && [ -x "$BUILD_DIR/bin/llama-server" ] && [ -x "$BUILD_DIR/bin/llama-tts-server" ]; then
    step "Both servers are already built"
    ok "$BUILD_DIR/bin/llama-server"
    ok "$BUILD_DIR/bin/llama-tts-server"
    info "pass --force to rebuild"
else
    step "Fetching llama.cpp at $LLAMA_COMMIT"

    if [ ! -d "$LLAMA_DIR/.git" ]; then
        git clone https://github.com/ggml-org/llama.cpp "$LLAMA_DIR"
    fi
    git -C "$LLAMA_DIR" fetch --all --tags
    # Reset hard so a re-run after a half-applied patch starts clean.
    git -C "$LLAMA_DIR" checkout --force "$LLAMA_COMMIT"
    git -C "$LLAMA_DIR" reset --hard "$LLAMA_COMMIT"
    git -C "$LLAMA_DIR" clean -fd -e build
    ok "at $(git -C "$LLAMA_DIR" rev-parse --short HEAD)"

    step "Applying the llama-tts-server patch"
    if git -C "$LLAMA_DIR" apply --check "$REPO/llama-tts-server.patch" 2>/dev/null; then
        git -C "$LLAMA_DIR" apply "$REPO/llama-tts-server.patch"
        ok "patch applied"
    elif [ -f "$LLAMA_DIR/tools/tts/tts-server.cpp" ]; then
        ok "patch already applied"
    else
        die "the patch did not apply - is llama.cpp/ modified? delete it and re-run."
    fi

    step "Building (this is the slow part)"
    warn "expect 30-60 minutes on an Orin Nano. Do not let the board sleep."
    info "the CUDA kernels are what take the time; the C++ is quick by comparison"

    cmake -S "$LLAMA_DIR" -B "$BUILD_DIR" \
        -DCMAKE_BUILD_TYPE=Release \
        -DGGML_CUDA=ON \
        -DCMAKE_CUDA_ARCHITECTURES=$CUDA_ARCH \
        -DLLAMA_CURL=OFF \
        -DLLAMA_BUILD_TESTS=OFF \
        -DLLAMA_BUILD_EXAMPLES=OFF

    JOBS=$(nproc)
    # Each nvcc job can want well over 1 GB. On a 6-core 8 GB board, -j6 with
    # thin swap is how builds die at 90%; back off unless there is swap to spare.
    if [ "$SWAP_MB" -lt 4096 ] && [ "$JOBS" -gt 4 ]; then
        JOBS=4
        info "using -j4 rather than -j$(nproc) because swap is thin"
    fi
    cmake --build "$BUILD_DIR" --config Release -j"$JOBS" \
        --target llama-server llama-tts-server

    [ -x "$BUILD_DIR/bin/llama-server" ]     || die "llama-server was not produced"
    [ -x "$BUILD_DIR/bin/llama-tts-server" ] || die "llama-tts-server was not produced"
    ok "built both servers"
fi

# --------------------------------------------------------------- downloads

mkdir -p "$MODELS_DIR"

# fetch <repo> <path-in-repo> -> prints the local path
fetch() {
    local repo="$1" path="$2"
    local leaf dest
    leaf="$(basename "$path")"
    dest="$MODELS_DIR/$leaf"

    # Everything chatty goes to stderr: stdout is the returned path.
    if [ -s "$dest" ]; then
        ok "$leaf - already here ($(du -h "$dest" | cut -f1))" >&2
        printf '%s' "$dest"
        return
    fi

    info "downloading $leaf from $repo ..." >&2
    if python3 -c 'import huggingface_hub' >/dev/null 2>&1; then
        python3 - "$repo" "$path" "$MODELS_DIR" <<'PY' >&2
import os, shutil, sys
from huggingface_hub import hf_hub_download
repo, path, dest_dir = sys.argv[1:4]
src = hf_hub_download(repo_id=repo, filename=path)
dest = os.path.join(dest_dir, os.path.basename(path))
# Copy rather than symlink: the HF cache may sit on a different filesystem
# from models/, and llama.cpp opens these by path at every start.
shutil.copyfile(src, dest)
PY
    else
        curl -fL --retry 3 --progress-bar \
            -o "$dest.part" \
            "https://huggingface.co/$repo/resolve/main/$path?download=true" >&2
        mv "$dest.part" "$dest"
    fi
    [ -s "$dest" ] || die "download did not produce $dest"
    ok "$leaf - $(du -h "$dest" | cut -f1)" >&2
    printf '%s' "$dest"
}

if [ "$SKIP_MODELS" -eq 1 ]; then
    step "Skipping the downloads (--skip-models)"
    M_LLM="$MODELS_DIR/$LLM_FILE"
    M_LLM_MMPROJ="$MODELS_DIR/$LLM_MMPROJ"
    M_TTS="$MODELS_DIR/${TTS_FILES[0]}"
    M_TTS_MMPROJ="$MODELS_DIR/${TTS_FILES[1]}"
    M_VOICE="$MODELS_DIR/$(basename "$VOICE_FILE")"
else
    step "Fetching the models (about 4.2 GB in total)"
    info "into $MODELS_DIR"
    AVAIL_MB=$(df -Pm "$MODELS_DIR" | awk 'NR==2 {print $4}')
    info "free space there: ${AVAIL_MB} MB"
    [ "$AVAIL_MB" -gt 6000 ] || warn "that is tight - the models need about 4.2 GB"

    M_LLM="$(fetch "$LLM_REPO" "$LLM_FILE")"
    M_LLM_MMPROJ="$(fetch "$LLM_REPO" "$LLM_MMPROJ")"
    M_TTS="$(fetch "$TTS_REPO" "${TTS_FILES[0]}")"
    M_TTS_MMPROJ="$(fetch "$TTS_REPO" "${TTS_FILES[1]}")"
    M_VOICE="$(fetch "$VOICE_REPO" "$VOICE_FILE")"
fi

# ------------------------------------------------------------------ config

step "Writing config.local.json"

python3 - "$REPO/config.json" "$CONFIG_LOCAL" <<PY
import json, sys
template, out = sys.argv[1:3]
with open(template, encoding="utf-8") as f:
    cfg = json.load(f)
cfg.pop("_comment", None)
cfg["quant"] = "$LLM_QUANT"
cfg["modelsDir"] = "$MODELS_DIR"
cfg["bin"] = {
    "llamaServer": "$BUILD_DIR/bin/llama-server",
    "llamaTtsServer": "$BUILD_DIR/bin/llama-tts-server",
}
cfg["models"] = {
    "llm": "$M_LLM",
    "llmMmproj": "$M_LLM_MMPROJ",
    "tts": "$M_TTS",
    "ttsMmproj": "$M_TTS_MMPROJ",
    "voice": "$M_VOICE",
}
with open(out, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
PY
ok "written to $CONFIG_LOCAL"

# ----------------------------------------------------------------- summary

step "Checking what is in place"

MISSING=0
for f in "$M_LLM" "$M_LLM_MMPROJ" "$M_TTS" "$M_TTS_MMPROJ" "$M_VOICE"; do
    if [ -s "$f" ]; then ok "$(basename "$f")"; else warn "missing: $f"; MISSING=1; fi
done
for b in "$BUILD_DIR/bin/llama-server" "$BUILD_DIR/bin/llama-tts-server"; do
    if [ -x "$b" ]; then ok "$(basename "$b")"; else warn "missing: $b"; MISSING=1; fi
done

echo
if [ "$MISSING" -eq 0 ]; then
    printf '  %sSetup finished.%s Start it with:  ./start.sh\n' "$C_OK" "$C_OFF"
else
    printf '  %sSetup is not finished%s - see the warnings above, then re-run.\n' "$C_WARN" "$C_OFF"
    exit 1
fi
echo
