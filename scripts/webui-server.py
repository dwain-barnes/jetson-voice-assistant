#!/usr/bin/env python3
"""Browser front end for the local voice assistant.

Serves webui/ as a static site and proxies the whole chain behind one origin,
so the page never has to talk to llama-server or llama-tts-server directly and
there is no CORS to argue with:

    browser --(WAV)--> /api/chat --> llama-server (streamed)
                                 --> llama-tts-server, one sentence at a time
    browser <--(SSE: deltas, audio urls, timings)--

The chain itself is the one in scripts/voice-chat.py; that module is imported
so the sentence splitter, the max_seconds scaling and the WAV handling stay in
one place.

Standard library only.

    python scripts/webui-server.py [--port 8123]
"""

import argparse
import base64
import http.client
import importlib.util
import json
import mimetypes
import os
import queue
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
WEBUI_DIR = os.path.join(REPO, "webui")
# The Jetson port keeps config.json at the repo root (setup.sh writes it)
# instead of under package/ as the Windows parent project does.
CONFIG_TEMPLATE = os.path.join(REPO, "config.json")
CONFIG_LOCAL = os.path.join(REPO, "config.local.json")

DEFAULT_SYSTEM_PROMPT = (
    "You are a helpful voice assistant. The user speaks to you; some of their "
    "messages arrive as audio. Answer the person directly, talking to them as "
    "\"you\" - never narrate what the speaker said. Your reply is read out "
    "loud. For ordinary conversation keep it to one or two short sentences. "
    "But when the user asks for a list, a story, steps, or an explanation, "
    "give the complete answer: every item they asked for, in full sentences, "
    "one per line - announcing a list and then stopping is wrong."
)
# Gemma wants a text part alongside the audio; this is the nudge that keeps it
# answering the speaker instead of describing the recording.
AUDIO_PROMPT = "Listen to this and reply to me directly."

# Keep this many turns (user+assistant messages) of history per session, and
# resend the raw audio for only the newest few turns - audio is expensive in
# context, but the model needs at least the current one to hear anything.
MAX_HISTORY_MESSAGES = 16
MAX_AUDIO_TURNS = 2
MAX_AUDIO_CLIPS = 96          # served /api/audio/<id> blobs kept in memory
MAX_UPLOAD_BYTES = 25 * 1024 * 1024

# What an old spoken turn looks like in the context once its audio has been
# dropped and nobody wrote down what was said.
SPOKEN_PLACEHOLDER = "(the user's earlier spoken message)"

# ------------------------------------------------- writing down spoken turns
#
# There is no speech-to-text anywhere in this chain and there is not about to
# be: the model hears the audio itself, which is the whole point. But that
# leaves the page showing "Spoken - 2.1s" where the words should be, and leaves
# the history holding a placeholder once a turn's audio has aged out.
#
# So after the reply is finished - never before, never in its way - the same
# model is asked one extra question: what did that clip say? The answer is
# pushed down the same stream as a `transcript` event and swapped into the
# stored turn. It is display and memory only; the reply the user heard was
# produced from the audio and is already on screen by the time this runs.
#
# The conversation always wins. If a newer turn has started by the time this is
# about to be sent, it is not sent; if one starts while it is in flight, the
# connection is closed under it and the GPU goes back to the person talking.
# That matters more here than on a desktop card: the Orin has one small GPU and
# llama-server runs it a request at a time, so a transcript still generating is
# a transcript standing in the next question's way. Set this to False to switch
# the whole thing off - the chip simply stays.
TRANSCRIBE_SPOKEN = True
TRANSCRIBE_PROMPT = (
    "Transcribe the speech in this audio exactly, word for word. Output only "
    "the spoken words, nothing else."
)
TRANSCRIBE_MAX_TOKENS = 96
TRANSCRIBE_TIMEOUT = 60.0     # network timeout on the transcription request
TRANSCRIBE_WAIT = 25.0        # how long the stream is held open waiting for it
TRANSCRIBE_MAX_CHARS = 600    # a runaway answer is not a transcript


def _load_voice_chat():
    """Import scripts/voice-chat.py (the dash keeps it out of normal imports)."""
    path = os.path.join(HERE, "voice-chat.py")
    spec = importlib.util.spec_from_file_location("voice_chat", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


vc = _load_voice_chat()


# ------------------------------------------------------------------- config

def load_config():
    cfg = {"llmPort": 8090, "ttsPort": 8100, "webUiPort": 8123}
    for path in (CONFIG_TEMPLATE, CONFIG_LOCAL):
        if not os.path.isfile(path):
            continue
        try:
            with open(path, "r", encoding="utf-8-sig") as f:
                data = json.load(f)
        except (OSError, ValueError) as exc:
            print("[config] ignoring %s: %s" % (path, exc), file=sys.stderr)
            continue
        for key in ("llmPort", "ttsPort", "webUiPort"):
            if isinstance(data.get(key), int):
                cfg[key] = data[key]
    return cfg


# ------------------------------------------------------------- conversations

class Cancellable(object):
    """Somewhere for a background job to park the connection it is using.

    Whoever supersedes the job reaches in and hangs up. Closing the socket is
    what actually frees the language model: it stops generating for a client
    that has gone, so the next real question is not queued behind an answer
    nobody is waiting for any more.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._conn = None
        self._sock = None
        self.cancelled = False

    def attach(self, conn):
        """Hand over the connection, already dialled. Raises if the job was
        cancelled in the moment between the check and the dial.

        The socket is taken now rather than at cancel time because http.client
        lets go of it as soon as it decides the response will close the
        connection - and by then the only thing still holding it is the reader
        we are trying to interrupt.
        """
        with self._lock:
            if self.cancelled:
                raise Cancelled()
            self._conn = conn
            self._sock = getattr(conn, "sock", None)

    def cancel(self):
        with self._lock:
            self.cancelled = True
            conn, self._conn = self._conn, None
            sock, self._sock = self._sock, None
        # shutdown() before close(): the thread doing the reading is sitting in
        # recv() on this socket, and closing a socket out from under a blocked
        # reader does not reliably wake it. Shutting the connection down does,
        # which is the difference between the model being freed now and being
        # freed whenever it happens to finish.
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except Exception:
                pass
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


class Cancelled(Exception):
    """The job was superseded before it could finish. Not an error."""


class Session(object):
    def __init__(self):
        self.messages = []          # OpenAI-style, audio kept inline
        self.lock = threading.Lock()
        self.touched = time.time()

        # `lock` is held for the whole of a turn's chain, so it is no use for
        # asking "has a newer turn started?" from inside one. This second,
        # deliberately tiny lock is: it is never held across anything that
        # waits, so a request that has only just arrived can raise its hand
        # while the previous turn is still streaming.
        self.seq_lock = threading.Lock()
        self.seq = 0                # turns started, ever
        self.pending = None         # the Cancellable of the running after-work

    def begin_turn(self):
        """Claim the session for a new turn, and evict the last one's
        housekeeping. Returns this turn's sequence number."""
        with self.seq_lock:
            self.seq += 1
            seq = self.seq
            pending, self.pending = self.pending, None
        if pending is not None:
            pending.cancel()
        return seq

    def is_current(self, seq):
        with self.seq_lock:
            return seq == self.seq

    def claim_after_work(self, seq):
        """A handle for work that belongs to turn `seq`, or None if that turn
        has already been overtaken and the work should never start."""
        with self.seq_lock:
            if seq != self.seq:
                return None
            self.pending = Cancellable()
            return self.pending

    def release_after_work(self, handle):
        with self.seq_lock:
            if self.pending is handle:
                self.pending = None


class SessionStore(object):
    def __init__(self, limit=64):
        self._sessions = OrderedDict()
        self._lock = threading.Lock()
        self._limit = limit

    def get(self, sid):
        with self._lock:
            s = self._sessions.get(sid)
            if s is None:
                s = Session()
                self._sessions[sid] = s
                while len(self._sessions) > self._limit:
                    self._sessions.popitem(last=False)
            self._sessions.move_to_end(sid)
            s.touched = time.time()
            return s

    def clear(self, sid):
        with self._lock:
            gone = self._sessions.pop(sid, None)
        # A forgotten conversation has nothing left worth writing down, and the
        # card is better spent on whatever is asked next.
        if gone is not None:
            gone.begin_turn()
        return gone


class AudioStore(object):
    """Short-lived home for synthesised WAVs, fetched once by the page."""

    def __init__(self, limit=MAX_AUDIO_CLIPS):
        self._clips = OrderedDict()
        self._lock = threading.Lock()
        self._limit = limit

    def put(self, blob):
        clip_id = uuid.uuid4().hex
        with self._lock:
            self._clips[clip_id] = blob
            while len(self._clips) > self._limit:
                self._clips.popitem(last=False)
        return clip_id

    def get(self, clip_id):
        with self._lock:
            return self._clips.get(clip_id)


class TurnRegistry(object):
    """The turns currently streaming, so one can be stopped from outside.

    Barge-in needs a way to say "stop that reply" from a second HTTP request
    while the first is still inside its streaming loop. Each live turn parks a
    threading.Event here under (sessionId, turnId); POST /api/interrupt sets
    it, and the loop that is pulling tokens out of the language model checks it
    between deltas and between sentences and gives up.
    """

    def __init__(self, limit=64):
        self._turns = OrderedDict()
        self._lock = threading.Lock()
        self._limit = limit

    def open(self, sid, turn_id):
        stop = threading.Event()
        with self._lock:
            self._turns[(sid, turn_id)] = stop
            while len(self._turns) > self._limit:
                self._turns.popitem(last=False)
        return stop

    def close(self, sid, turn_id):
        with self._lock:
            self._turns.pop((sid, turn_id), None)

    def interrupt(self, sid, turn_id=None):
        """Stop one turn, or - with no turn id - whatever that session has
        running. Returns how many were actually stopped, so the caller can tell
        "too late, it had finished" from "stopped it"."""
        with self._lock:
            if turn_id:
                found = [self._turns.get((sid, turn_id))]
            else:
                found = [ev for (s, _), ev in self._turns.items() if s == sid]
        found = [ev for ev in found if ev is not None]
        for ev in found:
            ev.set()
        return len(found)


SESSIONS = SessionStore()
AUDIO = AudioStore()
TURNS = TurnRegistry()


# ------------------------------------------------------------------ backends

def _get(url, timeout=3):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return resp.status, resp.read()


def backend_health(llm_url, tts_url):
    out = {}
    for name, url in (("llm", llm_url), ("tts", tts_url)):
        t = time.time()
        entry = {"ok": False, "url": url}
        try:
            status, body = _get(url.rstrip("/") + "/health")
            entry["ok"] = status == 200
            entry["status"] = status
            try:
                entry["detail"] = json.loads(body.decode("utf-8"))
            except ValueError:
                pass
        except Exception as exc:
            entry["error"] = str(exc)
        entry["ms"] = int((time.time() - t) * 1000)
        out[name] = entry
    out["ok"] = out["llm"]["ok"] and out["tts"]["ok"]
    return out


def wav_seconds(blob):
    try:
        params, frames = vc.wav_params(blob)
        per_second = params.framerate * params.nchannels * params.sampwidth
        return round(len(frames) / float(per_second), 3) if per_second else 0.0
    except Exception:
        return 0.0


def build_messages(session, audio_b64, text):
    """Current history plus this turn, with old audio dropped to save context."""
    content = []
    if audio_b64:
        content.append({"type": "text", "text": text or AUDIO_PROMPT})
        content.append({
            "type": "input_audio",
            "input_audio": {"data": audio_b64, "format": "wav"},
        })
    else:
        content.append({"type": "text", "text": text or ""})
    turn = {"role": "user", "content": content}

    history = session.messages[-MAX_HISTORY_MESSAGES:]
    messages = [{"role": "system", "content": DEFAULT_SYSTEM_PROMPT}]

    audio_budget = MAX_AUDIO_TURNS - 1   # this turn always keeps its audio
    for msg in reversed(history):
        if msg["role"] == "user" and isinstance(msg["content"], list):
            keeps_audio = any(c.get("type") == "input_audio" for c in msg["content"])
            if keeps_audio and audio_budget <= 0:
                stripped = [c for c in msg["content"] if c.get("type") != "input_audio"]
                # Only stand a placeholder in for the audio if nothing else in
                # the turn says what was said. A turn that has since been
                # written down carries the real words here, and losing them to
                # "(the user's earlier spoken message)" would be a step
                # backwards - that placeholder exists because there was nothing
                # better, not because it is wanted.
                if not spoken_text(stripped):
                    stripped.append({"type": "text", "text": SPOKEN_PLACEHOLDER})
                msg = {"role": "user", "content": stripped}
            elif keeps_audio:
                audio_budget -= 1
        messages.insert(1, msg)
    messages.append(turn)
    return messages, turn


def spoken_text(content):
    """What a spoken turn's text parts actually say, if anything.

    The nudge that goes out alongside the audio is not a record of what the
    user said, and neither is the placeholder that replaces vanished audio, so
    neither counts.
    """
    said = []
    for part in content:
        if part.get("type") != "text":
            continue
        text = (part.get("text") or "").strip()
        if text and text != AUDIO_PROMPT and text != SPOKEN_PLACEHOLDER:
            said.append(text)
    return " ".join(said)


def stream_llm(llm_url, messages, timeout=300.0, max_tokens=640, temperature=0.7):
    """Yield content deltas from llama-server's OpenAI-compatible SSE stream."""
    payload = {
        "model": "gemma",
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": True,
    }
    req = urllib.request.Request(
        llm_url.rstrip("/") + "/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json",
                 "Accept": "text/event-stream"},
        method="POST",
    )
    resp = urllib.request.urlopen(req, timeout=timeout)
    try:
        for raw in resp:
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
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
    finally:
        resp.close()


def transcribe_audio(llm_url, audio_b64, handle=None, timeout=TRANSCRIBE_TIMEOUT):
    """Ask the model to write down what one clip of audio says.

    Streamed, even though nobody watches these tokens arrive. A streamed
    request hands the connection back before the answer exists, which is the
    only way to be able to hang up on it: with a plain request the socket does
    not come back until the model has finished, by which time the GPU time we
    wanted to give back has already been spent. `handle` is where the caller
    parks that connection so a newer turn can close it.

    Raw http.client rather than urllib for the same reason - urlopen() keeps
    the connection to itself until the response headers land.
    """
    payload = {
        "model": "gemma",
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": TRANSCRIBE_PROMPT},
                {"type": "input_audio",
                 "input_audio": {"data": audio_b64, "format": "wav"}},
            ],
        }],
        "temperature": 0.0,
        "max_tokens": TRANSCRIBE_MAX_TOKENS,
        "stream": True,
    }
    parts = urllib.parse.urlsplit(llm_url)
    opener = (http.client.HTTPSConnection if parts.scheme == "https"
              else http.client.HTTPConnection)
    conn = opener(parts.hostname, parts.port, timeout=timeout)
    try:
        # Dial first, then hand the live connection over: a handle holding a
        # socket that does not exist yet cannot hang up on anything.
        conn.connect()
        if handle is not None:
            handle.attach(conn)
        conn.request("POST", (parts.path.rstrip("/")) + "/v1/chat/completions",
                     body=json.dumps(payload).encode("utf-8"),
                     headers={"Content-Type": "application/json",
                              "Accept": "text/event-stream"})
        resp = conn.getresponse()
        if resp.status != 200:
            raise RuntimeError("llama-server answered %d" % resp.status)
        pieces = []
        for raw in resp:
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            if not line.startswith("data:"):
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
                    pieces.append(piece)
        return clean_transcript("".join(pieces))
    finally:
        try:
            conn.close()
        except Exception:
            pass


def clean_transcript(text):
    """Tidy the model's answer without rewriting it.

    Whitespace, a pair of quotation marks it decided to add, a runaway that is
    plainly no longer a transcript. Nothing else: the words are the point, and
    a transcript that quietly edits what someone said is worse than none.
    """
    text = " ".join((text or "").split())
    while len(text) > 1 and text[0] == text[-1] and text[0] in "\"'“”":
        text = text[1:-1].strip()
    if text.startswith("“") and text.endswith("”"):
        text = text[1:-1].strip()
    return text[:TRANSCRIBE_MAX_CHARS].strip()


# --------------------------------------------------------------- http server

class Handler(BaseHTTPRequestHandler):
    server_version = "VoiceWebUI/1.0"
    protocol_version = "HTTP/1.1"

    _dead = False        # the browser hung up mid-stream
    _stop = None         # this turn's interrupt flag, once it has one

    # --- plumbing -------------------------------------------------------
    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _send(self, code, body=b"", ctype="text/plain; charset=utf-8", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj), "application/json; charset=utf-8")

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_UPLOAD_BYTES:
            raise ValueError("request too large (%d bytes)" % length)
        return self.rfile.read(length) if length else b""

    # --- routes ---------------------------------------------------------
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/health":
            return self._json(200, backend_health(self.server.llm_url,
                                                  self.server.tts_url))
        if path.startswith("/api/audio/"):
            clip = AUDIO.get(path[len("/api/audio/"):])
            if clip is None:
                return self._send(404, "no such clip")
            return self._send(200, clip, "audio/wav")
        return self.serve_static(path)

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        try:
            if path == "/api/chat":
                return self.api_chat()
            if path == "/api/interrupt":
                # Deliberately tiny and deliberately not behind the session
                # lock: the turn being stopped is holding that lock, and this
                # has to answer while it does.
                body = json.loads(self._read_body() or b"{}") or {}
                sid = body.get("sessionId")
                turn_id = body.get("turnId")
                if not isinstance(sid, str) or not sid:
                    return self._json(400, {"error": "sessionId is required"})
                if turn_id is not None and not isinstance(turn_id, str):
                    return self._json(400, {"error": "turnId must be a string"})
                stopped = TURNS.interrupt(sid, turn_id or None)
                return self._json(200, {"ok": True, "sessionId": sid,
                                        "turnId": turn_id, "stopped": stopped})
            if path == "/api/clear":
                body = self._read_body()
                sid = (json.loads(body or b"{}") or {}).get("sessionId")
                if sid:
                    SESSIONS.clear(sid)
                    TURNS.interrupt(sid)
                return self._json(200, {"ok": True, "sessionId": sid})
        except Exception as exc:
            self.log_message("error handling %s: %s", path, exc)
            try:
                return self._json(500, {"error": str(exc)})
            except Exception:
                return
        return self._send(404, "not found")

    # --- static ---------------------------------------------------------
    def serve_static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        rel = os.path.normpath(path.lstrip("/")).replace("\\", "/")
        if rel.startswith("..") or os.path.isabs(rel):
            return self._send(403, "forbidden")
        full = os.path.join(WEBUI_DIR, *rel.split("/"))
        if not os.path.isfile(full):
            return self._send(404, "not found")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",
                                                  "application/json"):
            ctype += "; charset=utf-8"
        with open(full, "rb") as f:
            return self._send(200, f.read(), ctype)

    # --- the chat chain -------------------------------------------------
    def _event(self, obj):
        """Write one SSE event, tolerating a browser that has hung up.

        A barge-in aborts the fetch, so the socket can die at any point in the
        stream. That is not an error worth unwinding the chain for - the turn
        is over either way - so the first failed write marks the stream dead
        and the rest go nowhere.
        """
        if getattr(self, "_dead", False):
            return
        try:
            self.wfile.write(b"data: " + json.dumps(obj).encode("utf-8") + b"\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionError, OSError):
            self._dead = True
            if self._stop is not None:
                # The client is gone: stop generating for it.
                self._stop.set()

    def api_chat(self):
        raw = self._read_body()
        try:
            req = json.loads(raw.decode("utf-8")) if raw else {}
        except ValueError as exc:
            return self._json(400, {"error": "bad JSON: %s" % exc})

        audio_b64 = req.get("audio") or None
        text = (req.get("text") or "").strip()
        if not audio_b64 and not text:
            return self._json(400, {"error": "send audio, text, or both"})
        if audio_b64:
            try:
                base64.b64decode(audio_b64, validate=True)
            except Exception:
                return self._json(400, {"error": "audio is not valid base64"})

        sid = req.get("sessionId") or uuid.uuid4().hex
        # The page names its own turn so it can interrupt this exact one; a
        # client that does not bother still gets an id, it just cannot aim.
        turn_id = req.get("turnId")
        if not isinstance(turn_id, str) or not turn_id.strip():
            turn_id = uuid.uuid4().hex
        turn_id = turn_id.strip()[:64]
        session = SESSIONS.get(sid)
        # Claimed before a single event goes out: from here on this is the turn
        # the session belongs to, and any after-the-fact work the previous turn
        # left running is told so and hung up on.
        seq = session.begin_turn()

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.close_connection = True
        self.end_headers()

        # Registered before a single token is asked for: an interrupt that
        # arrives while the model is still warming up must still find it.
        self._dead = False
        self._stop = TURNS.open(sid, turn_id)
        self._event({"type": "session", "sessionId": sid, "turnId": turn_id})
        try:
            self._run_chain(session, audio_b64, text, self._stop, seq, turn_id)
        except Exception as exc:
            self.log_message("chat chain failed: %s", exc)
            try:
                self._event({"type": "error", "message": str(exc)})
            except Exception:
                pass
        finally:
            TURNS.close(sid, turn_id)
            self._stop = None

    def _run_chain(self, session, audio_b64, text, stop=None, seq=0,
                   turn_id=None):
        t0 = time.time()
        if stop is None:
            stop = threading.Event()
        tts_args = SimpleNamespace(tts_url=self.server.tts_url,
                                   max_seconds=30.0, timeout=300.0)

        with session.lock:
            messages, turn = build_messages(session, audio_b64, text)

            jobs = queue.Queue()
            results = queue.Queue()

            def tts_worker():
                # One sentence at a time: the speech server holds a single
                # mutex, so there is nothing to gain from firing in parallel.
                while True:
                    item = jobs.get()
                    if item is None:
                        results.put(None)
                        return
                    index, sentence = item
                    # The turn was cut off while this was queued: drain the
                    # queue without troubling the speech server. Nothing more
                    # is synthesised for a reply nobody is listening to.
                    if stop.is_set():
                        continue
                    started = time.time()
                    try:
                        wav = vc.speak(tts_args, sentence,
                                       vc.sentence_cap(tts_args, sentence))
                        if not wav.startswith(b"RIFF"):
                            raise ValueError("speech server did not return a WAV")
                    except Exception as exc:
                        results.put({"type": "error", "index": index,
                                     "message": "speech failed: %s" % exc})
                        continue
                    results.put({
                        "type": "audio",
                        "index": index,
                        "url": "/api/audio/" + AUDIO.put(wav),
                        "seconds": wav_seconds(wav),
                        "ttsMs": int((time.time() - started) * 1000),
                        "atMs": int((time.time() - t0) * 1000),
                    })

            worker = threading.Thread(target=tts_worker, daemon=True)
            worker.start()

            state = {"first_audio_ms": None}

            def drain(block=False):
                """Forward whatever the speech worker has finished."""
                while True:
                    try:
                        item = results.get(block=block, timeout=None if block else 0)
                    except queue.Empty:
                        return True
                    if item is None:
                        return False
                    if item["type"] == "audio" and state["first_audio_ms"] is None:
                        state["first_audio_ms"] = item["atMs"]
                    self._event(item)
                    block = False

            buffer = ""
            pieces = []
            index = 0
            first_token_ms = None
            failed = None

            # Bound rather than inlined into the for, so it can be closed the
            # moment we stop caring: closing the generator closes the socket to
            # llama-server, and llama-server stops generating for a client that
            # has gone. Otherwise a cut-off turn keeps a GPU busy writing an
            # answer to a question nobody is waiting on any more.
            tokens = stream_llm(self.server.llm_url, messages)
            try:
                for piece in tokens:
                    if stop.is_set():
                        break
                    if first_token_ms is None:
                        first_token_ms = int((time.time() - t0) * 1000)
                        self._event({"type": "start", "firstTokenMs": first_token_ms})
                    pieces.append(piece)
                    buffer += piece
                    self._event({"type": "delta", "text": piece})
                    sentences, buffer = vc.split_sentences(buffer)
                    for sentence in sentences:
                        if stop.is_set():
                            break
                        if not vc.is_speakable(sentence):
                            continue
                        index += 1
                        self._event({"type": "sentence", "index": index,
                                     "text": sentence})
                        jobs.put((index, sentence))
                    drain()
            except Exception as exc:
                failed = exc
            finally:
                try:
                    tokens.close()
                except Exception:
                    pass

            interrupted = stop.is_set()
            if failed is None and not interrupted:
                tail = buffer.strip()
                if tail and vc.is_speakable(tail):
                    index += 1
                    self._event({"type": "sentence", "index": index, "text": tail})
                    jobs.put((index, tail))

            llm_ms = int((time.time() - t0) * 1000)
            jobs.put(None)
            while drain(block=True):
                pass
            worker.join(timeout=5)

            reply = "".join(pieces).strip()
            interrupted = interrupted or stop.is_set()
            stored_turn = None
            if failed is not None:
                self._event({"type": "error",
                             "message": "the language model stream failed: %s" % failed})
            elif reply:
                stored_turn = turn
                session.messages.append(turn)
                # An interrupted reply is stored as what was actually said,
                # with an em dash where the user cut in. Storing the whole
                # thing would make the model believe it finished a sentence
                # nobody heard, and every later turn would be built on that.
                stored = (reply + " \u2014") if interrupted else reply
                session.messages.append({"role": "assistant", "content": stored})
                del session.messages[:-MAX_HISTORY_MESSAGES]

            self._event({
                "type": "done",
                "text": reply,
                "sentences": index,
                "firstTokenMs": first_token_ms,
                "firstAudioMs": state["first_audio_ms"],
                "llmMs": llm_ms,
                "totalMs": int((time.time() - t0) * 1000),
                "interrupted": interrupted,
                "ok": failed is None and not interrupted and bool(reply),
            })

        # Out of the session lock, and after the answer has been given: only
        # now is it anybody's business what the words were. An interrupted turn
        # gets nothing - the user was already talking again when it died, and
        # whatever they were saying is the turn that matters.
        if (TRANSCRIBE_SPOKEN and audio_b64 and stored_turn is not None
                and not interrupted and not self._dead):
            self._transcribe_turn(session, seq, turn_id, audio_b64, stored_turn)

    def _transcribe_turn(self, session, seq, turn_id, audio_b64, stored_turn):
        """Write down what the user said, if the conversation lets us.

        The asking happens on a worker thread so that no part of it can be
        holding the session lock while it waits on the language model; this
        thread does nothing but hold the stream open for the answer, and gives
        up on it well before anyone would notice a page that never finished.
        """
        handle = session.claim_after_work(seq)
        if handle is None:
            return                      # a newer turn already has the session
        result = {}
        finished = threading.Event()

        def work():
            said = None
            try:
                if session.is_current(seq):
                    said = transcribe_audio(self.server.llm_url, audio_b64, handle)
                if said and (handle.cancelled or not session.is_current(seq)):
                    said = None         # the conversation moved on while we asked
            except Cancelled:
                said = None
            except Exception as exc:
                said = None
                # Silent as far as the page is concerned: a transcript that did
                # not arrive leaves the chip exactly as it was, which is the
                # honest thing for it to look like.
                if not handle.cancelled:
                    self.log_message("transcription failed: %s", exc)
            session.release_after_work(handle)
            if said:
                result["text"] = said
            finished.set()
            # Deliberately after the page has been told. The swap wants the
            # session lock, and a turn that started in the meantime holds it for
            # as long as it streams - the words on screen must not wait on that.
            if said:
                adopt_transcript(session, stored_turn, said)

        threading.Thread(target=work, daemon=True).start()
        finished.wait(TRANSCRIBE_WAIT)
        said = result.get("text")
        if said and not self._dead:
            self._event({"type": "transcript", "turnId": turn_id, "text": said})


def adopt_transcript(session, turn, text):
    """Put the words where the nudge was.

    The turn keeps its audio - while it is still young enough to be resent the
    model should hear it, not read it - but its text part stops being the
    generic "listen to this" and becomes what was actually said. That is the
    whole point: when the audio ages out of the window the words stay behind,
    so the model remembers a question rather than the fact that one was asked.
    """
    if turn is None:
        return False
    with session.lock:
        # It can have been trimmed out of the history while we were asking;
        # identity, not position, says whether it is still there.
        if not any(msg is turn for msg in session.messages):
            return False
        content = turn.get("content")
        if not isinstance(content, list):
            return False
        for part in content:
            if part.get("type") == "text":
                part["text"] = text
                return True
        content.insert(0, {"type": "text", "text": text})
        return True


def main(argv=None):
    cfg = load_config()
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--port", type=int, default=cfg["webUiPort"])
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--llm-url", default="http://127.0.0.1:%d" % cfg["llmPort"])
    p.add_argument("--tts-url", default="http://127.0.0.1:%d" % cfg["ttsPort"])
    args = p.parse_args(argv)

    if not os.path.isdir(WEBUI_DIR):
        print("webui/ is missing next to scripts/ - nothing to serve", file=sys.stderr)
        return 1

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    httpd.llm_url = args.llm_url
    httpd.tts_url = args.tts_url
    print("Voice assistant web UI on http://%s:%d  (llm %s, tts %s)"
          % (args.host, args.port, args.llm_url, args.tts_url), file=sys.stderr)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
