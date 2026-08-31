# Jetson Voice Assistant

**A voice assistant that runs entirely on a $249 Jetson Orin Nano Super. No cloud, no API keys, no account.**

You talk. It hears you — not a transcript of you, the actual audio — thinks, and talks back, all on a
board that draws less power than a light bulb. Two GGUF models on llama.cpp:

- **Gemma 4 E2B** listens and answers. It is natively multimodal, so your recording goes straight to
  the model. There is no separate speech-to-text step to mishear you first.
- **Pocket TTS** speaks the reply, sentence by sentence as the model writes it, so the first words
  come out of the speaker long before the last ones have been thought of.

Nothing leaves the board. Unplug the network after setup and it still works.

This is a port of [dwain-barnes/llama-tts-server](https://github.com/dwain-barnes/llama-tts-server)
(the Windows/x86 parent project) to ARM64 JetPack. The chain, the web UI and the custom warm TTS
server are the same; the install and launch layer is what changed.

> **Status: built and verified on x86, not yet on real Jetson hardware.** Everything here is checked
> as far as a non-Jetson machine allows — the scripts parse, the patch applies to llama.cpp at the
> pinned commit, and every model file is confirmed to exist at the exact name and size quoted below.
> What is *not* verified is the CUDA 8.7 build, the load times, and the tokens per second. If you run
> it on a real Orin Nano, **please open an issue with what happened** — good or bad. First hardware
> report is genuinely welcome.

---

## Hardware

| | |
|---|---|
| Board | Jetson Orin Nano Super Developer Kit, 8 GB |
| Software | JetPack 6.x (Ubuntu 22.04, L4T r36), CUDA 12.x |
| Storage | 32 GB free — ~4.4 GB of models, the rest is the llama.cpp build tree |
| Swap | 8 GB swap file **for the build**. See below; without it the build is likely to be OOM-killed. |
| Power mode | 25W ("Super") profile: `sudo nvpmodel -m 2 && sudo jetson_clocks` |
| Network | Only for setup. After that it is optional. |

A microphone and speaker are optional — the usual way to use this is from a browser on your laptop
or phone, which uses *that* device's microphone and speakers.

The 4 GB Orin Nano will not fit this. See the memory budget.

## Quickstart

```bash
git clone https://github.com/dwain-barnes/jetson-voice-assistant
cd jetson-voice-assistant
./setup.sh      # deps, build, models. Go and do something else - 30-60 minutes.
./start.sh      # prints a URL to open from any device on your network
```

`setup.sh` is idempotent: run it again after an interrupted download or a failed build and it picks
up where it stopped.

## Talking to it

`start.sh` prints something like `http://192.168.1.42:8123`. Open it on your laptop or phone.

![The web UI](webui/screenshot.png)

Type in the box and press enter, or hold the microphone button and speak. Replies stream in as text
and are spoken as each sentence finishes.

### The microphone needs one extra step over the LAN

Browsers only hand out microphone access on *secure origins* — https, or localhost. The Jetson serves
plain http on your LAN, so the mic button will be refused there. **Typing always works**, on any
device, with no workaround.

Three ways to get the microphone:

1. **Browse from the Jetson itself.** `http://localhost:8123` counts as secure. If you have a monitor
   on the board, this is the easy answer.
2. **Tell Chrome to trust it.** Open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add
   `http://192.168.1.42:8123` (your actual URL), and restart the browser. Fine on a home network;
   the flag is called "unsafely" for a reason, so undo it when you are done.
3. **Put https in front of it.** A Tailscale/Caddy/nginx reverse proxy with a real certificate.
   Beyond the scope of this README, but it is the clean answer.

There is also a terminal path that needs no browser at all:

```bash
python3 scripts/voice-chat.py --text "Tell me three facts about Wales."
python3 scripts/voice-chat.py question.wav -o reply.wav
```

On Linux it plays through `paplay`, `aplay` or `ffplay`, whichever is installed. On a headless board
with no sound card it just writes the WAV and says nothing.

## Memory budget

This is the whole design problem. The Orin Nano's 8 GB is **unified** — the GPU does not have its own
memory, it shares the system's. Every megabyte the language model takes is a megabyte Ubuntu does not
have, and when it runs out there is no swapping a CUDA allocation back in; something gets killed.

Of the 8 GB, roughly **7.4 GiB** is actually addressable after the carve-outs. The defaults aim to
leave over a gigabyte of that unused.

| What | Where | Size |
|---|---|---|
| `gemma-4-E2B-it-UD-Q4_K_XL.gguf` | GPU | 2.97 GiB |
| `mmproj-F16.gguf` (audio + vision projector) | GPU | 0.92 GiB |
| KV cache + compute buffers @ 4096 ctx | GPU | ~0.45 GiB |
| `pocket-tts-en.gguf` | CPU | 0.15 GiB |
| `mmproj-pocket-tts-en.gguf` | CPU | 0.06 GiB |
| Python web UI + proxy | CPU | ~0.10 GiB |
| Ubuntu, headless | CPU | ~1.20 GiB |
| **Total** | | **~5.85 GiB** |
| **Headroom** | | **~1.5 GiB** |

The headroom is not slack, it is the budget for a desktop session, a browser on the board, page cache
during model load, and the spike when Pocket TTS allocates its audio graph on the first request.

If you are tight — running a desktop, or something else on the board — drop to a smaller quant:

```bash
./setup.sh --quant UD-Q3_K_XL      # 2.72 GiB, saves ~0.25 GiB, slightly worse
./setup.sh --quant UD-Q2_K_XL      # 2.24 GiB, noticeably worse; last resort
```

Or shrink the context in `config.local.json` (`contextSize`: 4096 → 2048).

Going *up* is possible if you run truly headless and accept the risk: `--quant Q5_K_M` (3.13 GiB) or
`Q6_K` (4.19 GiB, which will not leave room for much else).

## The models

Everything `setup.sh` downloads, with the sizes confirmed against the Hugging Face API:

| File | Repo | Bytes |
|---|---|---|
| `gemma-4-E2B-it-UD-Q4_K_XL.gguf` | [unsloth/gemma-4-E2B-it-GGUF](https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF) | 3,184,496,736 |
| `mmproj-F16.gguf` | unsloth/gemma-4-E2B-it-GGUF | 985,654,080 |
| `pocket-tts-en.gguf` | [EryriLabs/pocket-tts-en-GGUF](https://huggingface.co/EryriLabs/pocket-tts-en-GGUF) | 159,390,816 |
| `mmproj-pocket-tts-en.gguf` | EryriLabs/pocket-tts-en-GGUF | 59,858,080 |
| `unmute-prod-website/default_voice.wav` | [kyutai/tts-voices](https://huggingface.co/kyutai/tts-voices) | 480,044 |
| | | **4,389,879,756 (~4.09 GiB)** |

Two notes on those choices:

- **F16, not BF16, for the projector.** The repo ships both at almost the same size (985 MB vs
  986 MB). Ampere handles F16 in hardware, and llama.cpp's CUDA backend is best-trodden on F16, so
  there is nothing to gain from BF16 here.
- **Pocket TTS runs on the CPU**, on 4 of the 6 Cortex-A78AE cores. It is a ~160 MB model, so this
  is affordable, and it keeps the entire GPU for the language model — which is the resource actually
  under pressure. Expect it to be slower than the ~5.8x realtime the x86 parent project sees; as long
  as it stays comfortably above 1x realtime, the sentence-at-a-time streaming hides it completely.
  **This ratio is the main thing that wants measuring on real hardware.** If it comes out below
  realtime, raise `ttsThreads` to 6 in `config.local.json` and tell us what you saw.

## Building

`setup.sh` clones llama.cpp at exactly **`9f0d017`**, applies `llama-tts-server.patch`, and builds:

```
cmake -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=87 -DLLAMA_CURL=OFF \
      --target llama-server llama-tts-server
```

The commit is pinned because the patch is a real diff against that tree; a later master will very
likely reject it.

**The build takes 30 to 60 minutes** and is the slowest part of the whole exercise. The CUDA kernels
are what take the time.

### Swap, and why the build dies without it

`nvcc` can want well over a gigabyte per translation unit. Six of those at once, on a board with
8 GB shared with everything else, is how a build gets OOM-killed at 90%. JetPack's zram helps a
little — it compresses RAM rather than adding any — but for a CUDA build you want real swap:

```bash
sudo fallocate -l 8G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

`setup.sh` checks for this and, if swap is thin, quietly backs the build off to `-j4`. You can
`swapoff` afterwards — inference does not want swap, and a swapping Jetson is a slow Jetson.

## Starting on boot

```bash
sed -e "s/CHANGEME/$USER/g" -e "s#/home/CHANGEME/jetson-voice-assistant#$PWD#g" \
    voice-assistant.service | sudo tee /etc/systemd/system/voice-assistant.service
sudo systemctl daemon-reload
sudo systemctl enable --now voice-assistant
journalctl -u voice-assistant -f
```

Run `./setup.sh` and one successful `./start.sh` by hand first.

## Configuration

`setup.sh` writes `config.local.json`. Edit it to change ports, context size, TTS thread count or
model paths; `config.json` is the shipped template and is never written to, so pulling an update
will not undo your settings.

```json
{
  "llmPort": 8090,
  "ttsPort": 8100,
  "webUiPort": 8123,
  "contextSize": 4096,
  "llmGpuLayers": 99,
  "ttsThreads": 4
}
```

`./start.sh --localhost` binds the UI to 127.0.0.1 instead of every interface.

## How it fits together

```
browser ──WAV──> webui-server.py (8123) ──> llama-server (8090)   Gemma 4 E2B, GPU
                        │                        │ streamed tokens
                        │<───────────────────────┘
                        │ one finished sentence at a time
                        └──────────────> llama-tts-server (8100)  Pocket TTS, CPU
browser <──SSE: text deltas + audio urls──┘
```

`llama-tts-server` is the piece that is not in upstream llama.cpp. Upstream's `llama-tts` is a
one-shot CLI that loads the model, speaks, and exits — useless in a conversation, where you would pay
the model load on every sentence. The patch adds a server that keeps the model warm behind an
OpenAI-compatible `/v1/audio/speech` endpoint. That is what makes sentence-by-sentence streaming
possible at all.

`--reasoning off` on llama-server is not optional. Gemma 4 is a thinking model; left to reason, it
spends the entire token budget on it and returns empty content, which the speech server then refuses.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Build killed around 90% | Not enough swap. Add the swap file above and re-run `./setup.sh`. |
| `nvcc: not found` | JetPack puts it in `/usr/local/cuda/bin`. `export PATH=/usr/local/cuda/bin:$PATH`. |
| The mic button does nothing | Expected over http on the LAN — see the microphone section. Typing still works. |
| Everything is slow | `sudo nvpmodel -m 2 && sudo jetson_clocks` for the 25W profile. |
| A server dies shortly after "READY" | Out of memory. Check `dmesg -T \| grep -i oom` and drop to a smaller quant. |
| `port 8090 is already in use` | An earlier copy is still running: `pkill -f llama-server`. |

Logs from the last run are in `logs/`.

## Credits

- [llama.cpp](https://github.com/ggml-org/llama.cpp) — the runtime everything here stands on.
- [Kyutai](https://huggingface.co/kyutai) — Pocket TTS and the reference voices (CC-BY-4.0).
- [EryriLabs](https://huggingface.co/EryriLabs/pocket-tts-en-GGUF) — the Pocket TTS GGUF conversions.
- [Google DeepMind](https://huggingface.co/google) for Gemma 4, and
  [unsloth](https://huggingface.co/unsloth) for the dynamic quants.
- [dwain-barnes/llama-tts-server](https://github.com/dwain-barnes/llama-tts-server) — the parent
  project this is ported from, where the TTS server patch and the web UI come from.

MIT licensed. The models carry their own licences (Gemma Terms of Use; Pocket TTS CC-BY-4.0).
