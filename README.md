# Jetson Voice Assistant

**A voice assistant that runs entirely on a $249 Jetson Orin Nano Super. No cloud, no API keys, no account.**

You talk. It hears you - not a transcript of you, the actual audio - thinks, and talks back, all on a
board that draws less power than a light bulb. Two GGUF models on llama.cpp:

- **Gemma 4 E2B** listens and answers. It is natively multimodal, so your recording goes straight to
  the model. There is no separate speech-to-text step to mishear you first.
- **Pocket TTS** speaks the reply, sentence by sentence as the model writes it, so the first words
  come out of the speaker long before the last ones have been thought of.

Nothing leaves the board. Unplug the network after setup and it still works.

This is a port of [dwain-barnes/llama-tts-server](https://github.com/dwain-barnes/llama-tts-server)
(the Windows/x86 parent project) to ARM64 JetPack. The chain, the web UI and the custom warm TTS
server are the same; the install and launch layer is what changed.

> **Status: running on real hardware.** Everything below was measured on a Jetson Orin Nano Super
> 8 GB on JetPack 6 (L4T R36.4.7). The numbers in
> [What it actually does](#what-it-actually-does-measured-on-an-orin-nano-super-8-gb) are measured,
> not estimated. The one honest disappointment is speech on the CPU, which is far slower than the
> x86 parent project - see that section before you plan a conversation around it.

---

## Read this first: two things that will otherwise waste your afternoon

Both of these cost real hours to find. They are handled for you by `start.sh`, but you should know
why they are there.

**1. The page cache has to be dropped before every model load.** NvMap, the Tegra GPU memory
allocator, will not reclaim the Linux page cache to satisfy an allocation. If `MemFree` is low, every
`cudaMalloc` fails with `NvMapMemAllocInternalTagged error 12` - *even when `free -m` is showing
several gigabytes "available"*. The kernel counts reclaimable cache as available; NvMap does not.
The fix is one line, immediately before the load:

```bash
sudo sh -c 'sync; echo 3 > /proc/sys/vm/drop_caches'
```

`start.sh` does this before the language model, and again before the speech model if you have put
that on the GPU. It needs sudo without a password prompt, so the easy way to start is:

```bash
sudo -v && ./start.sh
```

If it cannot get sudo it prints a warning and carries on, and the load will probably fail. See
[The page cache trap](#the-page-cache-trap-nvmap-and-memfree).

**2. Start the servers one at a time, and gate on `curl -sf`.** `llama-server` answers `/health`
with **503 while it is still loading**, and a plain `curl -s` treats a 503 as success. Get that wrong
and the speech server starts early, grabs GPU memory in the middle of the language model's load, and
kills it. The `-f` is the whole point. `start.sh` waits for a real 200 from the language model before
anything else is allowed to touch the GPU.

## Hardware

| | |
|---|---|
| Board | Jetson Orin Nano Super Developer Kit, 8 GB |
| Software | JetPack 6.x (Ubuntu 22.04, L4T R36), CUDA 12.x |
| Storage | 32 GB free - ~4.4 GB of models, the rest is the llama.cpp build tree (not needed if you take the prebuilt binaries) |
| Swap | 8 GB swap file **for the build**. See below; without it the build is likely to be OOM-killed. Not needed if you take the prebuilt binaries. |
| Power mode | 25W ("Super") profile: `sudo nvpmodel -m 2 && sudo jetson_clocks` |
| Network | Only for setup. After that it is optional. |

A microphone and speaker are optional - the usual way to use this is from a browser on your laptop
or phone, which uses *that* device's microphone and speakers.

The 4 GB Orin Nano will not fit this. See the memory budget.

## Quickstart

```bash
git clone https://github.com/dwain-barnes/jetson-voice-assistant
cd jetson-voice-assistant
./setup.sh          # offers prebuilt binaries, then downloads the models
sudo -v && ./start.sh   # sudo so it can free the page cache before each model load
```

`setup.sh` is idempotent: run it again after an interrupted download or a failed build and it picks
up where it stopped.

### The fast path: prebuilt binaries

On an aarch64 board running JetPack 6 (`/etc/nv_tegra_release` mentioning `R36`), `setup.sh` offers
to download binaries that are already built, instead of compiling for 30 to 60 minutes:

```
https://github.com/dwain-barnes/jetson-voice-assistant/releases/tag/v1.0.0
jetson-voice-assistant-orin-jp6-cuda-arm64.tar.gz
```

The tarball holds `llama-server`, `llama-tts-server` and the `libggml*.so`, `libllama*.so` and
`libmtmd.so` they need. It was built on JetPack 6 / L4T R36.4.7 for CUDA arch 87, from llama.cpp
`9f0d017` with this repo's `llama-tts-server.patch` applied - the same recipe the source build uses.

Everything lands in `llama.cpp/build/bin/`. The shared objects sit *next to* the binaries rather than
being installed, so anything running them needs the loader pointed there:

```bash
LD_LIBRARY_PATH=llama.cpp/build/bin llama.cpp/build/bin/llama-server --version
```

`setup.sh` runs exactly that as a check before accepting the download, and `start.sh` exports the
same `LD_LIBRARY_PATH` for you.

If the download fails, the architecture is wrong, or the binaries will not run, `setup.sh` says so
and falls back to building from source. You can also decide for yourself:

```bash
./setup.sh --build-from-source   # never download; compile everything
./setup.sh --prebuilt            # never compile; fail if the download is unusable
```

Compiling yourself is the honest option if you would rather not run someone else's binaries. It
costs an hour, not a day.

## Talking to it

`start.sh` prints something like `http://192.168.1.42:8123`. Open it on your laptop or phone.

![The web UI](webui/screenshot.png)

Type in the box and press enter, or hold the microphone button and speak. Replies stream in as text
and are spoken as each sentence finishes.

### The microphone needs one extra step over the LAN

Browsers only hand out microphone access on *secure origins* - https, or localhost. The Jetson serves
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

## What it actually does: measured on an Orin Nano Super 8 GB

JetPack 6 (L4T R36.4.7), 25W Super profile, nothing else on the GPU.

### Gemma 4 E2B, UD-Q4_K_XL, `-ngl 99`, `contextSize` 2048

| | |
|---|---|
| Model load | 30 to 60 seconds |
| Time to first token | 0.37 - 0.56 s |
| A short text answer, start to finish | under 1 second |

That part is genuinely good. Asking it a question and reading the answer feels immediate.

During the load `MemFree` dives to around **80 MB**. That is alarming and it is also normal - as long
as the page cache was dropped immediately beforehand, the load completes from there.

### Pocket TTS on the ARM CPU (the shipped default)

| | |
|---|---|
| Speed | ~0.16x realtime |
| A short sentence | ~19 seconds of compute for a couple of seconds of audio |
| 4 threads vs 6 threads | no measurable difference; it is not thread-bound |

This is the honest bad news. **Usable for testing, not for conversation.** The x86 parent project
gets about 5.8x realtime on a desktop CPU; the A78AE cores are a long way from that, and raising
`ttsThreads` does not help. Sentence-at-a-time streaming cannot hide something running at a sixth of
realtime.

The text answer still arrives in under a second, so if you read replies rather than listen to them,
none of this matters.

### Pocket TTS on the GPU

| | |
|---|---|
| Speed | ~30x faster than the CPU path |
| Measured | 0.64 s to produce ~3 s of audio |
| Fits alongside Gemma Q4 + a desktop session on 8 GB? | **No** |

Fast enough for real conversation, and it does not reliably fit. A second CUDA context costs about
0.6 GB before any compute buffers, and on an 8 GB board next to `UD-Q4_K_XL` and a desktop GUI it
runs out during CUDA graph capture and dies.

It is worth trying if you are either running a smaller quant (`UD-Q2_K_XL`, 2.24 GiB) or running the
board headless. See [Speech on the GPU](#speech-on-the-gpu-ttsongpu).

## The page cache trap: NvMap and MemFree

The symptom is a CUDA allocation failing like this:

```
NvMapMemAllocInternalTagged: error 12
ggml_cuda_host_malloc: failed to allocate ...
```

while `free -m` cheerfully reports gigabytes available. Both readings are correct. `MemAvailable`
includes page cache the kernel would happily reclaim; NvMap allocates out of `MemFree` and will not
trigger that reclaim itself. A Jetson that has been reading model files - which is to say, a Jetson
you have used for anything - has most of its memory in page cache, so `MemFree` is small and every
`cudaMalloc` fails.

The fix is to convert that cache into genuinely free memory, immediately before each CUDA model load:

```bash
sudo sh -c 'sync; echo 3 > /proc/sys/vm/drop_caches'
```

"Immediately before" is not superstition. Anything that reads files in between - including the
previous model load - refills the cache.

`start.sh` does this automatically:

- before starting `llama-server`, always;
- before starting `llama-tts-server`, if `ttsOnGpu` is true.

It needs passwordless sudo to do it. `sudo -v && ./start.sh` caches your sudo timestamp for the next
few minutes, which is enough. `sudo ./start.sh` works too. If neither is available, `start.sh` prints
a warning explaining what to run by hand and carries on - it does not silently pretend everything is
fine.

Pass `--no-drop-caches` if you have your own arrangement and would rather not be told about it.

## Sharing the board with other GPU workloads

Most Jetsons are not blank. This one arrived running NVIDIA's **NanoOWL** demo out of the box, from a
systemd unit, in Docker, holding about **2.4 GB** and a slice of the GPU. Yours probably has
something similar. Find it before you blame this project:

```bash
systemctl list-units --type=service --state=running
docker ps
sudo tegrastats          # watch RAM while you stop things
```

### Stop it properly, for the session

```bash
sudo systemctl stop <service>
```

**Do not `pkill` it.** Two ways that goes wrong, both learned the hard way:

- Units with `Restart=on-failure` come back within seconds. The respawn lands *in the middle of* the
  language model's load and kills it, and because the timing is variable it looks like a random
  intermittent failure rather than the obvious thing it is.
- If the workload is containerized, killing the process you can see does not release the GPU memory.
  The container is still there holding it. The container is what has to stop.

Stopping the service leaves it **enabled**, so it comes back on the next reboot and you have not
quietly broken the demo the board shipped with. If you want it gone for good that is
`sudo systemctl disable --now <service>`, but that is your decision to make deliberately.

### If you want to keep the other workload running

With roughly 2.4 GB resident elsewhere, **`gemma-4-E2B-it-UD-Q4_K_XL` does not fit.** Your options:

```bash
./setup.sh --quant UD-Q2_K_XL    # 2.24 GiB - fits, but it is tight and the answers are worse
```

or stop the other workload while you are using the assistant. There is no third answer on 8 GB.

`start.sh` will not kill anything on your behalf. It is not its business to decide what else on your
board matters. If the language model fails to load it prints a hint that something else may be
holding GPU memory, and the commands above to find out what.

## Memory budget

This is the whole design problem. The Orin Nano's 8 GB is **unified** - the GPU does not have its own
memory, it shares the system's. Every megabyte the language model takes is a megabyte Ubuntu does not
have, and when it runs out there is no swapping a CUDA allocation back in; something gets killed.

Of the 8 GB, roughly **7.4 GiB** is actually addressable after the carve-outs.

| What | Where | Size |
|---|---|---|
| `gemma-4-E2B-it-UD-Q4_K_XL.gguf` | GPU | 2.97 GiB |
| `mmproj-F16.gguf` (audio + vision projector) | GPU | 0.92 GiB |
| KV cache + compute buffers @ 2048 ctx | GPU | ~0.25 GiB |
| `pocket-tts-en.gguf` | CPU | 0.15 GiB |
| `mmproj-pocket-tts-en.gguf` | CPU | 0.06 GiB |
| Python web UI + proxy | CPU | ~0.10 GiB |
| Ubuntu, headless | CPU | ~1.20 GiB |
| **Total** | | **~5.65 GiB** |
| **Headroom** | | **~1.7 GiB** |

The headroom is not slack. It is the budget for a desktop session, a browser on the board, page cache
during model load, and the spike when Pocket TTS allocates its audio graph on the first request. On
the real board that headroom is entirely consumed during the load - `MemFree` bottoms out around
80 MB - which is why the page cache has to be dropped first.

**`contextSize` is 2048 by default**, lowered from 4096 after measuring this. 2048 is comfortable for
question-and-answer use. Raise it in `config.local.json` if you have room - if you are headless, on
a smaller quant, or you have stopped everything else - and watch `tegrastats` while you do.

If you are tight - running a desktop, or something else on the board - drop to a smaller quant:

```bash
./setup.sh --quant UD-Q3_K_XL      # 2.72 GiB, saves ~0.25 GiB, slightly worse
./setup.sh --quant UD-Q2_K_XL      # 2.24 GiB, noticeably worse; the one that fits next to other workloads
```

Going *up* is possible if you run truly headless and accept the risk: `--quant Q5_K_M` (3.13 GiB) or
`Q6_K` (4.19 GiB, which will not leave room for much else).

## Speech on the GPU: `ttsOnGpu`

`config.json` ships `"ttsOnGpu": false`. Setting it to `true` in `config.local.json` makes `start.sh`
launch `llama-tts-server` with `-ngl 99` and *without* hiding the GPU from it:

```json
{ "ttsOnGpu": true }
```

That buys roughly **30x**: 0.64 s for about three seconds of audio, against ~19 s on the CPU. It is
the difference between a demo and a conversation.

It also very often does not fit. The second CUDA context is ~0.6 GB before compute buffers, and the
failure arrives during CUDA graph capture, on the first request rather than at load. Try it only if:

- you are on `UD-Q2_K_XL` (2.24 GiB) rather than Q4, **or**
- the board is genuinely headless - no desktop session, no browser on the Jetson, nothing else on the
  GPU.

If the speech server dies at startup or on the first synthesis, put it back to `false`. `start.sh`
warns you about all of this at the point it launches, and again if the launch fails.

### Why CPU mode needs an empty `CUDA_VISIBLE_DEVICES`

`-ngl 0` is **not** enough to keep `llama-tts-server` off the GPU on a CUDA build. The mtmd audio
projector allocates CUDA buffers regardless of the layer count. When Gemma already owns the GPU, that
allocation fails and takes the speech server down with a ggml assert - a confusing crash, because you
asked for zero GPU layers and got a CUDA error anyway.

`start.sh` launches it with `CUDA_VISIBLE_DEVICES=""` (empty), which hides the device from that child
process entirely. The Windows parent project does the same thing with `CUDA_VISIBLE_DEVICES=-1`. If
you launch the speech server by hand, do this too.

## The models

Everything `setup.sh` downloads, with the sizes confirmed against the Hugging Face API:

| File | Repo | Bytes |
|---|---|---|
| `gemma-4-E2B-it-UD-Q4_K_XL.gguf` (default) | [unsloth/gemma-4-E2B-it-GGUF](https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF) | 3,184,496,736 (2.97 GiB) |
| `gemma-4-E2B-it-UD-Q2_K_XL.gguf` (`--quant UD-Q2_K_XL`) | unsloth/gemma-4-E2B-it-GGUF | 2.24 GiB |
| `mmproj-F16.gguf` | unsloth/gemma-4-E2B-it-GGUF | 985,654,080 |
| `pocket-tts-en.gguf` | [EryriLabs/pocket-tts-GGUF](https://huggingface.co/EryriLabs/pocket-tts-GGUF) | 159,390,816 |
| `mmproj-pocket-tts-en.gguf` | EryriLabs/pocket-tts-GGUF | 59,858,080 |
| `unmute-prod-website/default_voice.wav` | [kyutai/tts-voices](https://huggingface.co/kyutai/tts-voices) | 480,044 |
| | **default set** | **4,389,879,756 (~4.09 GiB)** |

`UD-Q2_K_XL` is the quant to reach for when something else on the board is holding ~2.4 GB. It is
noticeably worse than Q4 at following instructions, and it is the only thing that fits.

Two notes on those choices:

- **F16, not BF16, for the projector.** The repo ships both at almost the same size (985 MB vs
  986 MB). Ampere handles F16 in hardware, and llama.cpp's CUDA backend is best-trodden on F16, so
  there is nothing to gain from BF16 here.
- **Pocket TTS runs on the CPU by default**, on 4 of the 6 Cortex-A78AE cores, which keeps the entire
  GPU for the language model. That was the right call for reliability and the wrong one for speed:
  measured at ~0.16x realtime. See the performance section, and `ttsOnGpu` if you have the memory.

## Building

If you took the prebuilt binaries you can skip this entire section.

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
little - it compresses RAM rather than adding any - but for a CUDA build you want real swap:

```bash
sudo fallocate -l 8G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

`setup.sh` checks for this and, if swap is thin, quietly backs the build off to `-j4`. You can
`swapoff` afterwards - inference does not want swap, and a swapping Jetson is a slow Jetson.

## Starting on boot

```bash
sed -e "s/CHANGEME/$USER/g" -e "s#/home/CHANGEME/jetson-voice-assistant#$PWD#g" \
    voice-assistant.service | sudo tee /etc/systemd/system/voice-assistant.service
sudo systemctl daemon-reload
sudo systemctl enable --now voice-assistant
journalctl -u voice-assistant -f
```

Run `./setup.sh` and one successful `./start.sh` by hand first.

The unit runs as your user, not root, so it cannot free the page cache by itself. Two things bridge
that gap:

- `ExecStartPre=+/bin/sh -c 'sync; echo 3 > /proc/sys/vm/drop_caches'` in the unit. The leading `+`
  tells systemd to run that one step as root. This covers the first model load.
- A sudoers drop-in, if you want `start.sh` to be able to drop the cache again between the two
  models. The commands are in the comments at the top of `voice-assistant.service`. Optional.

If you have stopped another GPU service to make room, remember it is still *enabled* and will be back
after the reboot, competing with this one for the same memory. Boot order between two enabled
services is not something you want to be relying on for 8 GB of shared memory - disable one of them.

## Configuration

`setup.sh` writes `config.local.json`. Edit it to change ports, context size, TTS placement or model
paths; `config.json` is the shipped template and is never written to, so pulling an update will not
undo your settings.

```json
{
  "llmPort": 8090,
  "ttsPort": 8100,
  "webUiPort": 8123,
  "contextSize": 2048,
  "llmGpuLayers": 99,
  "ttsThreads": 4,
  "ttsOnGpu": false,
  "ttsGpuLayers": 99
}
```

| Key | Default | Notes |
|---|---|---|
| `contextSize` | 2048 | The safe value on 8 GB. Was 4096 before hardware testing. Raise it only with headroom to spare. |
| `llmGpuLayers` | 99 | All of them. Gemma E2B fits on the GPU; there is no reason to split it. |
| `ttsThreads` | 4 | 6 measured identical to 4 - the CPU speech path is not thread-bound. |
| `ttsOnGpu` | `false` | `true` is ~30x faster and usually does not fit. See above. |
| `ttsGpuLayers` | 99 | Only used when `ttsOnGpu` is `true`. |

Command line:

```bash
./start.sh --localhost         # bind the UI to 127.0.0.1 instead of every interface
./start.sh --no-warmup         # skip the warm-up requests
./start.sh --no-webui          # just the two model servers
./start.sh --no-drop-caches    # do not touch the page cache (and stop warning about it)
```

## How it fits together

```
browser --WAV--> webui-server.py (8123) --> llama-server (8090)    Gemma 4 E2B, GPU
                        |                        | streamed tokens
                        |<-----------------------+
                        | one finished sentence at a time
                        +------------------> llama-tts-server (8100)  Pocket TTS, CPU
browser <--SSE: text deltas + audio urls--+
```

Startup order is fixed and each step is gated on the one before it:

```
drop page cache -> llama-server -> wait for HTTP 200 on /health (curl -sf)
  -> [drop page cache again, if ttsOnGpu] -> llama-tts-server -> wait for /health
  -> warm-up request to each -> web UI
```

Nothing overlaps. Two CUDA allocations racing each other on this board means one of them loses.

`llama-tts-server` is the piece that is not in upstream llama.cpp. Upstream's `llama-tts` is a
one-shot CLI that loads the model, speaks, and exits - useless in a conversation, where you would pay
the model load on every sentence. The patch adds a server that keeps the model warm behind an
OpenAI-compatible `/v1/audio/speech` endpoint. That is what makes sentence-by-sentence streaming
possible at all.

`--reasoning off` on llama-server is not optional. Gemma 4 is a thinking model; left to reason, it
spends the entire token budget on it and returns empty content, which the speech server then refuses.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `NvMapMemAllocInternalTagged error 12`, or `cudaMalloc failed`, while `free -m` shows gigabytes available | The page cache. `sudo sh -c 'sync; echo 3 > /proc/sys/vm/drop_caches'` immediately before loading, or start with `sudo -v && ./start.sh`. |
| `start.sh` warns it cannot free the page cache | sudo wanted a password. `sudo -v && ./start.sh`, or `sudo ./start.sh`. |
| `MemFree` drops to ~80 MB during the load | Normal on this board. It completes if the cache was dropped first. |
| The language model dies partway through loading, unpredictably | Something else grabbed the GPU. Often a systemd service respawning after you `pkill`ed it. Use `sudo systemctl stop <service>`. |
| The language model will not load at all | Another GPU workload is resident. `systemctl list-units --state=running`, `docker ps`. With ~2.4 GB held elsewhere, use `--quant UD-Q2_K_XL`. |
| The speech server dies with a ggml assert about a CUDA buffer | The mtmd audio projector allocated on the GPU despite `-ngl 0`. It must run with `CUDA_VISIBLE_DEVICES=""`; `start.sh` does this, so check nothing in your environment overrides it. |
| Speech is fine but slow - ~19 s per sentence | Expected on the CPU (~0.16x realtime). Raising `ttsThreads` will not help. See `ttsOnGpu`. |
| GPU speech dies during CUDA graph capture | It does not fit next to Gemma Q4. Set `ttsOnGpu` back to `false`, or move to `UD-Q2_K_XL`, or run headless. |
| The speech server starts before the language model has finished loading | A health check without `-f`. `llama-server` returns 503 while loading and `curl -s` calls that success. |
| Build killed around 90% | Not enough swap. Add the swap file above and re-run `./setup.sh`. Or take the prebuilt binaries. |
| Prebuilt `llama-server` will not start | Missing `LD_LIBRARY_PATH`. The `.so` files sit beside it: `LD_LIBRARY_PATH=llama.cpp/build/bin`. If it still fails, `./setup.sh --force --build-from-source`. |
| `nvcc: not found` | JetPack puts it in `/usr/local/cuda/bin`. `export PATH=/usr/local/cuda/bin:$PATH`. |
| The mic button does nothing | Expected over http on the LAN - see the microphone section. Typing still works. |
| Everything is slow | `sudo nvpmodel -m 2 && sudo jetson_clocks` for the 25W profile. |
| A server dies shortly after "READY" | Out of memory. Check `dmesg -T \| grep -i oom` and drop to a smaller quant. |
| `port 8090 is already in use` | An earlier copy of *this* project is still running: `pkill -f llama-server`. (Only ever pkill your own processes - not a systemd service.) |

Logs from the last run are in `logs/`.

## Credits

- [llama.cpp](https://github.com/ggml-org/llama.cpp) - the runtime everything here stands on.
- [Kyutai](https://huggingface.co/kyutai) - Pocket TTS and the reference voices (CC-BY-4.0).
- [EryriLabs](https://huggingface.co/EryriLabs/pocket-tts-GGUF) - the Pocket TTS GGUF conversions.
- [Google DeepMind](https://huggingface.co/google) for Gemma 4, and
  [unsloth](https://huggingface.co/unsloth) for the dynamic quants.
- [dwain-barnes/llama-tts-server](https://github.com/dwain-barnes/llama-tts-server) - the parent
  project this is ported from, where the TTS server patch and the web UI come from.

MIT licensed. The models carry their own licences (Gemma Terms of Use; Pocket TTS CC-BY-4.0).
