#!/usr/bin/env python3
"""Audio in, spoken reply out: llama-server (multimodal LLM) -> llama-tts-server.

Sends a WAV to a llama-server that has an audio-capable mmproj loaded, takes the
text reply and speaks it with the TTS server, writing reply.wav.

By default the reply is streamed: the LLM is asked with stream=true and each
finished sentence is handed to the TTS server while the model is still writing
the rest, so speech starts long before the answer is complete. Pass --no-stream
for the old ask-everything-then-speak behaviour.

Only the standard library is required; `requests` is used when it is installed.

Example:
    python scripts/voice-chat.py I:\\models\\pocket-tts\\out.wav -o reply.wav
    python scripts/voice-chat.py --text "Tell me three facts about Wales."
"""

import argparse
import base64
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import wave

DEFAULT_LLM_URL = "http://127.0.0.1:8090"
DEFAULT_TTS_URL = "http://127.0.0.1:8100"
DEFAULT_SYSTEM_PROMPT = (
    "You are a helpful voice assistant. "
    "Reply in one or two short conversational sentences."
)

try:
    import requests  # type: ignore
except ImportError:  # pragma: no cover - exercised only without requests
    requests = None

try:
    import winsound  # type: ignore
except ImportError:  # pragma: no cover - non-Windows (the Jetson case)
    winsound = None

# On Linux there is no winsound, so shell out to whichever player is installed.
# JetPack images ship ALSA (aplay); desktop spins usually add PulseAudio
# (paplay); ffplay comes with the ffmpeg package setup.sh installs, so it is a
# reliable last resort. None of them present => playback is skipped, which is
# the normal case on a headless Jetson where the browser does the playing.
_LINUX_PLAYERS = (
    ("paplay", []),
    ("aplay", ["-q"]),
    ("ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet"]),
)


def _find_player():
    if winsound is not None:
        return None
    for name, flags in _LINUX_PLAYERS:
        path = shutil.which(name)
        if path:
            return [path] + flags
    return None


_PLAYER = _find_player()


def post_json(url, payload, timeout, want_bytes=False):
    """POST JSON. Returns parsed JSON, or raw bytes when want_bytes is set."""
    body = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if requests is not None:
        resp = requests.post(url, data=body, headers=headers, timeout=timeout)
        resp.raise_for_status()
        return resp.content if want_bytes else resp.json()
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read()
    return data if want_bytes else json.loads(data.decode("utf-8"))


def build_payload(args, audio_b64, stream=False):
    content = [{"type": "text", "text": args.prompt}]
    if audio_b64 is not None:
        content.append({
            "type": "input_audio",
            "input_audio": {"data": audio_b64, "format": "wav"},
        })
    payload = {
        "model": args.model,
        "messages": [
            {"role": "system", "content": args.system},
            {"role": "user", "content": content},
        ],
        "temperature": args.temperature,
        "max_tokens": args.max_tokens,
    }
    if stream:
        payload["stream"] = True
    return payload


def ask_llm(args, audio_b64):
    """Send the audio (and prompt text) to llama-server; return the reply text."""
    data = post_json(
        args.llm_url.rstrip("/") + "/v1/chat/completions",
        build_payload(args, audio_b64),
        args.timeout,
    )
    return data["choices"][0]["message"]["content"].strip()


def iter_llm_stream(args, audio_b64):
    """Yield content deltas from llama-server's SSE stream."""
    url = args.llm_url.rstrip("/") + "/v1/chat/completions"
    body = json.dumps(build_payload(args, audio_b64, stream=True)).encode("utf-8")
    headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}

    if requests is not None:
        resp = requests.post(url, data=body, headers=headers,
                             timeout=args.timeout, stream=True)
        resp.raise_for_status()
        lines = resp.iter_lines(decode_unicode=True)
    else:
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        resp = urllib.request.urlopen(req, timeout=args.timeout)

        def _lines():
            for raw in resp:
                yield raw.decode("utf-8", "replace").rstrip("\r\n")
        lines = _lines()

    for line in lines:
        if not line or not line.startswith("data:"):
            continue
        chunk = line[5:].strip()
        if chunk == "[DONE]":
            break
        try:
            obj = json.loads(chunk)
        except ValueError:
            continue
        for choice in obj.get("choices", []):
            piece = (choice.get("delta") or {}).get("content")
            if piece:
                yield piece


def speak(args, text, max_seconds=None):
    """Send text to the TTS server; return WAV bytes."""
    payload = {"input": text, "response_format": "wav"}
    cap = args.max_seconds if max_seconds is None else max_seconds
    if cap:
        payload["max_seconds"] = cap
    return post_json(
        args.tts_url.rstrip("/") + "/v1/audio/speech",
        payload,
        args.timeout,
        want_bytes=True,
    )


# --------------------------------------------------------------- sentences

# Deliberately simple: split after . ! ? (optionally followed by quotes or
# brackets) when the next character is whitespace, and after newlines. It will
# split mid-sentence on "Dr. Jones" or "e.g. this"; the only guard is the
# abbreviation list below plus a rule that a single capital letter followed by a
# dot (initials) does not end a sentence. Worst case the TTS speaks a fragment
# and the next fragment right after, which sounds like a short pause.
_ABBREVIATIONS = {
    "mr", "mrs", "ms", "dr", "prof", "st", "sr", "jr", "vs", "etc", "e.g",
    "i.e", "approx", "no", "fig", "inc", "ltd", "co", "op", "al",
}
_BOUNDARY = re.compile(r'([.!?]+["\'\)\]]*)(\s)|(\n+)')


def _ends_with_abbreviation(text):
    m = re.search(r'([A-Za-z.]+)\.$', text.rstrip())
    if not m:
        return False
    word = m.group(1).lower().rstrip(".")
    if len(word) == 1:  # initials: "J. Smith"
        return True
    return word in _ABBREVIATIONS


def split_sentences(buffer):
    """Return (complete_sentences, remainder) for a growing text buffer."""
    out = []
    start = 0
    for m in _BOUNDARY.finditer(buffer):
        end = m.end(1) if m.group(1) else m.end(3)
        candidate = buffer[start:end]
        if m.group(1) and _ends_with_abbreviation(candidate):
            continue
        sentence = candidate.strip()
        if sentence:
            out.append(sentence)
        start = m.end()
    return out, buffer[start:]


def is_speakable(text):
    """Skip fragments with no letters or digits (stray punctuation, bullets)."""
    return bool(re.search(r"[0-9A-Za-z]", text))


def sentence_cap(args, text):
    """Scale the TTS runaway cap to the sentence, capped at --max-seconds."""
    if not args.max_seconds:
        return 0
    # ~13 characters per second of speech, plus slack, minimum 4 s.
    return max(4.0, min(args.max_seconds, len(text) / 13.0 + 3.0))


# ---------------------------------------------------------------- wav utils

def wav_params(data):
    import io
    with wave.open(io.BytesIO(data), "rb") as w:
        return w.getparams(), w.readframes(w.getnframes())


def concat_wavs(chunks, path):
    """Merge same-format WAV blobs into one file. Returns duration seconds."""
    params = None
    frames = []
    for blob in chunks:
        p, f = wav_params(blob)
        if params is None:
            params = p
        elif (p.nchannels, p.sampwidth, p.framerate) != \
             (params.nchannels, params.sampwidth, params.framerate):
            raise ValueError("TTS chunk format changed mid-stream: %s vs %s" % (p, params))
        frames.append(f)
    if params is None:
        return 0.0
    payload = b"".join(frames)
    with wave.open(path, "wb") as w:
        w.setnchannels(params.nchannels)
        w.setsampwidth(params.sampwidth)
        w.setframerate(params.framerate)
        w.writeframes(payload)
    return len(payload) / float(params.framerate * params.nchannels * params.sampwidth)


def play_wav_bytes(data):
    if winsound is None and _PLAYER is None:
        return
    fd, tmp = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        with open(tmp, "wb") as f:
            f.write(data)
        if winsound is not None:
            winsound.PlaySound(tmp, winsound.SND_FILENAME)
        else:
            # Blocking, like PlaySound, so queued sentences stay in order.
            subprocess.run(_PLAYER + [tmp], check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


# ------------------------------------------------------------ streaming run

class _Stop(object):
    pass


def run_streaming(args, audio_b64, t0):
    """Stream the reply, synthesising and playing it sentence by sentence."""
    tts_q = queue.Queue()
    play_q = queue.Queue()
    state = {"chunks": [], "first_audio": None, "timings": [], "errors": []}

    def tts_worker():
        # One at a time: the TTS server holds a single mutex anyway.
        while True:
            item = tts_q.get()
            if item is _Stop:
                play_q.put(_Stop)
                return
            index, sentence = item
            t = time.time()
            try:
                wav = speak(args, sentence, sentence_cap(args, sentence))
                if not wav.startswith(b"RIFF"):
                    raise ValueError("server did not return a WAV")
            except Exception as exc:
                state["errors"].append((index, sentence, exc))
                print("[tts %d failed: %s]" % (index, exc), file=sys.stderr)
                continue
            took = time.time() - t
            if state["first_audio"] is None:
                state["first_audio"] = time.time() - t0
            state["chunks"].append((index, wav))
            state["timings"].append((index, len(sentence), took))
            print("[tts %d: %.2fs, %d chars] %s"
                  % (index, took, len(sentence), sentence[:60]), file=sys.stderr)
            play_q.put(wav)

    def play_worker():
        while True:
            item = play_q.get()
            if item is _Stop:
                return
            if not args.no_play:
                try:
                    play_wav_bytes(item)
                except Exception as exc:
                    print("[playback failed: %s]" % exc, file=sys.stderr)

    tts_thread = threading.Thread(target=tts_worker, daemon=True)
    play_thread = threading.Thread(target=play_worker, daemon=True)
    tts_thread.start()
    play_thread.start()

    buffer = ""
    full = []
    index = 0
    t_first_token = None
    try:
        for piece in iter_llm_stream(args, audio_b64):
            if t_first_token is None:
                t_first_token = time.time() - t0
            full.append(piece)
            buffer += piece
            sentences, buffer = split_sentences(buffer)
            for s in sentences:
                if not is_speakable(s):
                    continue
                index += 1
                print("  -> [%d] %s" % (index, s))
                tts_q.put((index, s))
    except Exception as exc:
        print("LLM stream failed: %s" % exc, file=sys.stderr)
        tts_q.put(_Stop)
        tts_thread.join()
        play_thread.join()
        return 1, "".join(full)

    tail = buffer.strip()
    if tail and is_speakable(tail):
        index += 1
        print("  -> [%d] %s" % (index, tail))
        tts_q.put((index, tail))

    t_llm_done = time.time() - t0
    tts_q.put(_Stop)
    tts_thread.join()
    play_thread.join()

    reply = "".join(full).strip()
    chunks = [wav for _, wav in sorted(state["chunks"], key=lambda x: x[0])]
    if not chunks:
        print("No audio was produced.", file=sys.stderr)
        return 1, reply

    duration = concat_wavs(chunks, args.output)
    total = time.time() - t0
    if t_first_token is not None:
        print("[first token %.2fs]" % t_first_token, file=sys.stderr)
    print("[llm done %.2fs] [first audio %.2fs] [total %.2fs]"
          % (t_llm_done, state["first_audio"], total), file=sys.stderr)
    print("[wrote %s: %d chunks, %.2fs of audio, %d bytes]"
          % (args.output, len(chunks), duration, os.path.getsize(args.output)),
          file=sys.stderr)
    if state["errors"]:
        print("[%d sentence(s) failed to synthesise]" % len(state["errors"]),
              file=sys.stderr)
    return 0, reply


# --------------------------------------------------------------- classic run

def run_blocking(args, audio_b64, t0):
    try:
        reply = ask_llm(args, audio_b64)
    except Exception as exc:
        print("LLM request failed: %s" % exc, file=sys.stderr)
        return 1, ""
    t_llm = time.time() - t0

    print(reply)
    print("[llm %.2fs]" % t_llm, file=sys.stderr)

    if args.text_only:
        return 0, reply

    t1 = time.time()
    try:
        wav = speak(args, reply)
    except Exception as exc:
        print("TTS request failed: %s" % exc, file=sys.stderr)
        return 1, reply
    t_tts = time.time() - t1

    if not wav.startswith(b"RIFF"):
        print("TTS server did not return a WAV", file=sys.stderr)
        return 1, reply

    first_audio = time.time() - t0
    with open(args.output, "wb") as f:
        f.write(wav)
    if not args.no_play:
        try:
            play_wav_bytes(wav)
        except Exception as exc:
            print("[playback failed: %s]" % exc, file=sys.stderr)
    print("[tts %.2fs] [first audio %.2fs] wrote %s (%d bytes), total %.2fs"
          % (t_tts, first_audio, args.output, len(wav), time.time() - t0),
          file=sys.stderr)
    return 0, reply


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("wav", nargs="?",
                   help="input WAV to send to the model (omit for text-only)")
    p.add_argument("-p", "--prompt", default="What did the speaker say? Answer them.",
                   help="text prompt sent alongside the audio")
    p.add_argument("--text", help="ask this question as text (no audio input)")
    p.add_argument("-o", "--output", default="reply.wav", help="output WAV path")
    p.add_argument("--llm-url", default=DEFAULT_LLM_URL)
    p.add_argument("--tts-url", default=DEFAULT_TTS_URL)
    p.add_argument("--system", default=DEFAULT_SYSTEM_PROMPT)
    p.add_argument("--model", default="gemma", help="model name field (unused by llama-server)")
    p.add_argument("--max-seconds", type=float, default=30.0,
                   help="TTS runaway cap in seconds (0 disables)")
    p.add_argument("--max-tokens", type=int, default=192)
    p.add_argument("--temperature", type=float, default=0.7)
    p.add_argument("--timeout", type=float, default=300.0)
    p.add_argument("--text-only", action="store_true",
                   help="skip TTS, just print the reply")
    p.add_argument("--no-stream", action="store_true",
                   help="wait for the whole reply before speaking (old behaviour)")
    p.add_argument("--no-play", action="store_true",
                   help="write the WAV but do not play it")
    args = p.parse_args(argv)

    if args.text:
        args.prompt = args.text
        args.wav = None

    audio_b64 = None
    if args.wav:
        if not os.path.isfile(args.wav):
            p.error("no such file: %s" % args.wav)
        with open(args.wav, "rb") as f:
            audio_b64 = base64.b64encode(f.read()).decode("ascii")

    t0 = time.time()
    if args.no_stream or args.text_only:
        rc, reply = run_blocking(args, audio_b64, t0)
    else:
        rc, reply = run_streaming(args, audio_b64, t0)
        if reply:
            print("\n" + reply)
    return rc


if __name__ == "__main__":
    sys.exit(main())
