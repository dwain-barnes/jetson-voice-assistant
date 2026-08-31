#!/usr/bin/env bash
# One-time setup for the Jetson Orin Nano Super voice assistant.
#
# Gets the two servers - either the prebuilt JetPack 6 binaries (fast) or a
# patched llama.cpp built here for CUDA compute 8.7 (30-60 minutes) - then
# downloads the models and writes config.local.json.
#
# Safe to run more than once: anything already on disk is left alone.
#
#   ./setup.sh                      normal run - offers the prebuilt binaries first
#   ./setup.sh --quant Q4_K_M       pick a different LLM quant
#   ./setup.sh --build-from-source  never download, always compile
#   ./setup.sh --prebuilt           never compile, insist on the download
#   ./setup.sh --skip-build         only fetch models
#   ./setup.sh --skip-models        only build
#   ./setup.sh --force              re-resolve every path
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLAMA_DIR="$REPO/llama.cpp"
BUILD_DIR="$LLAMA_DIR/build"
MODELS_DIR="$REPO/models"
CONFIG_LOCAL="$REPO/config.local.json"

LLAMA_COMMIT="9f0d017"
CUDA_ARCH=87                      # Orin = Ampere, compute capability 8.7

# Prebuilt binaries, so that most people never have to sit through the build.
# Built on JetPack 6 (L4T R36.4.7), CUDA arch 87, from llama.cpp at
# $LLAMA_COMMIT with llama-tts-server.patch applied. The tarball holds
# llama-server, llama-tts-server and the libggml*/libllama*/libmtmd shared
# objects they need.
RELEASE_TAG="v1.0.0"
PREBUILT_NAME="jetson-voice-assistant-orin-jp6-cuda-arm64.tar.gz"
PREBUILT_URL="https://github.com/dwain-barnes/jetson-voice-assistant/releases/download/$RELEASE_TAG/$PREBUILT_NAME"
PREBUILT_SHA256="a0cf9b0650bdaf1d72ad93c87ac8a900c9d612f2855929a050da665c6b5a0826"

LLM_REPO="unsloth/gemma-4-E2B-it-GGUF"
LLM_QUANT="UD-Q4_K_XL"            # 2.97 GiB - see the memory budget in README
LLM_MMPROJ="mmproj-F16.gguf"      # 0.92 GiB; CUDA on Orin runs F16 natively
TTS_REPO="EryriLabs/pocket-tts-GGUF"
TTS_FILES=(pocket-tts-en.gguf mmproj-pocket-tts-en.gguf)
VOICE_REPO="kyutai/tts-voices"
VOICE_FILE="unmute-prod-website/default_voice.wav"

SKIP_BUILD=0
SKIP_MODELS=0
FORCE=0
WANT_PREBUILT=auto            # auto | always | never

while [ $# -gt 0 ]; do
    case "$1" in
        --quant)             LLM_QUANT="$2"; shift 2 ;;
        --quant=*)           LLM_QUANT="${1#*=}"; shift ;;
        --build-from-source) WANT_PREBUILT=never; shift ;;
        --prebuilt)          WANT_PREBUILT=always; shift ;;
        --skip-build)        SKIP_BUILD=1; shift ;;
        --skip-models)       SKIP_MODELS=1; shift ;;
        --force)             FORCE=1; shift ;;
        -h|--help)           sed -n '2,15p' "$0" | sed 's/^# \?//'; exit 0 ;;
        *)                   echo "unknown option: $1" >&2; exit 2 ;;
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
L4T_R36=0
if [ -f /etc/nv_tegra_release ]; then
    IS_JETSON=1
    ok "$(head -n1 /etc/nv_tegra_release)"
    # The prebuilt binaries were compiled against JetPack 6 (L4T R36). Anything
    # older links a different CUDA runtime and will not load them.
    if grep -q 'R36' /etc/nv_tegra_release; then L4T_R36=1; fi
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

# The shared objects ship next to the binaries rather than being installed, so
# every attempt to run one needs the loader pointed at that directory. start.sh
# exports the same thing.
BIN_LD_PATH="$BUILD_DIR/bin"

binaries_present() {
    [ -x "$BUILD_DIR/bin/llama-server" ] && [ -x "$BUILD_DIR/bin/llama-tts-server" ]
}

# Actually run one of them. A file of the right name that cannot resolve its
# libraries is worse than no file at all, because start.sh would accept it.
verify_binaries() {
    LD_LIBRARY_PATH="$BIN_LD_PATH${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
        "$BUILD_DIR/bin/llama-server" --version >/dev/null 2>&1
}

# ---- the fast path: download what has already been built ------------------

prebuilt_eligible() {
    [ "$ARCH" = "aarch64" ] || { info "not aarch64 ($ARCH) - the prebuilt binaries would not run here" >&2; return 1; }
    [ "$L4T_R36" -eq 1 ] || { info "no 'R36' in /etc/nv_tegra_release - built for JetPack 6, so not this board" >&2; return 1; }
    return 0
}

try_prebuilt() {
    local tmp tgz
    tmp="$(mktemp -d)" || return 1
    tgz="$tmp/$PREBUILT_NAME"

    info "downloading $PREBUILT_NAME"
    info "from $PREBUILT_URL"
    if ! curl -fL --retry 3 --progress-bar -o "$tgz" "$PREBUILT_URL"; then
        warn "the download failed"
        rm -rf "$tmp"
        return 1
    fi

    # We are about to execute what we just downloaded - verify it first.
    local got
    got="$(sha256sum "$tgz" | awk '{print $1}')"
    if [ "$got" != "$PREBUILT_SHA256" ]; then
        warn "checksum mismatch (got $got) - refusing the download, will build instead"
        rm -rf "$tmp"
        return 1
    fi

    mkdir -p "$BUILD_DIR/bin"
    if ! tar -xzf "$tgz" -C "$tmp"; then
        warn "the tarball did not extract - it may be a truncated download"
        rm -rf "$tmp"
        return 1
    fi

    # Flatten whatever shape the archive has: the binaries and the .so files all
    # have to end up side by side in build/bin.
    local moved=0 f
    while IFS= read -r f; do
        if cp -f "$f" "$BUILD_DIR/bin/"; then
            moved=$((moved + 1))
        fi
    done < <(find "$tmp" -type f \( -name 'llama-server' -o -name 'llama-tts-server' \
                                    -o -name '*.so' -o -name '*.so.*' \))
    rm -rf "$tmp"

    if [ "$moved" -eq 0 ]; then
        warn "the tarball did not contain anything recognisable"
        return 1
    fi
    info "unpacked $moved files into $BUILD_DIR/bin"

    chmod +x "$BUILD_DIR/bin/llama-server" "$BUILD_DIR/bin/llama-tts-server" 2>/dev/null || true
    binaries_present || { warn "llama-server or llama-tts-server was not in the tarball"; return 1; }

    if ! verify_binaries; then
        warn "the downloaded llama-server will not run on this board"
        info "(tried: LD_LIBRARY_PATH=$BIN_LD_PATH $BUILD_DIR/bin/llama-server --version)"
        return 1
    fi

    ok "$(LD_LIBRARY_PATH="$BIN_LD_PATH" "$BUILD_DIR/bin/llama-server" --version 2>&1 | head -n1)"
    return 0
}

# ---- the slow path: compile ------------------------------------------------

build_from_source() {
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
}

# ---- decide which path to take ---------------------------------------------

if [ "$SKIP_BUILD" -eq 1 ]; then
    step "Skipping the build (--skip-build)"
elif [ "$FORCE" -eq 0 ] && binaries_present; then
    step "Both servers are already here"
    ok "$BUILD_DIR/bin/llama-server"
    ok "$BUILD_DIR/bin/llama-tts-server"
    info "pass --force to fetch or build them again"
else
    GOT_BINARIES=0

    if [ "$WANT_PREBUILT" = "never" ]; then
        info "building from source because you asked for it (--build-from-source)"
    elif prebuilt_eligible; then
        step "Prebuilt binaries are available for this board"
        info "$PREBUILT_NAME - built on JetPack 6 (R36), CUDA arch 87,"
        info "llama.cpp $LLAMA_COMMIT with this repo's llama-tts-server patch."
        info "Taking them saves the 30-60 minute build. Compiling yourself is the"
        info "honest option if you would rather not trust someone else's binaries;"
        info "pass --build-from-source for that."

        TAKE_PREBUILT=1
        if [ "$WANT_PREBUILT" != "always" ] && [ -t 0 ]; then
            read -r -p "    download the prebuilt binaries? [Y/n] " reply
            case "$reply" in [Nn]*) TAKE_PREBUILT=0 ;; esac
        fi

        if [ "$TAKE_PREBUILT" -eq 1 ]; then
            if try_prebuilt; then
                GOT_BINARIES=1
                ok "prebuilt binaries in place - no build needed"
            else
                warn "falling back to building from source"
            fi
        else
            info "building from source instead"
        fi
    else
        info "no prebuilt binaries for this board, so building from source"
    fi

    if [ "$GOT_BINARIES" -eq 0 ]; then
        if [ "$WANT_PREBUILT" = "always" ]; then
            die "--prebuilt was given but the download could not be used. See above."
        fi
        build_from_source
    fi
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

if [ "$MISSING" -eq 0 ] && [ "$SKIP_BUILD" -eq 0 ]; then
    if verify_binaries; then
        ok "llama-server runs: $(LD_LIBRARY_PATH="$BIN_LD_PATH" "$BUILD_DIR/bin/llama-server" --version 2>&1 | head -n1)"
    else
        warn "llama-server will not start. If these came from the prebuilt tarball,"
        warn "re-run with --build-from-source to compile against your own CUDA."
        MISSING=1
    fi
fi

echo
if [ "$MISSING" -eq 0 ]; then
    printf '  %sSetup finished.%s Start it with:  ./start.sh\n' "$C_OK" "$C_OFF"
    echo
    info "One thing worth knowing before you start it: on a Jetson the page cache"
    info "has to be freed immediately before each model load, or the CUDA allocation"
    info "fails with 'NvMapMemAllocInternalTagged error 12'. start.sh does that for"
    info "you if it can use sudo without a password prompt. The easy way:"
    info "    sudo -v && ./start.sh"
else
    printf '  %sSetup is not finished%s - see the warnings above, then re-run.\n' "$C_WARN" "$C_OFF"
    exit 1
fi
echo
