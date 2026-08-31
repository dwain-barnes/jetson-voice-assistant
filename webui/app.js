/* Local Voice Assistant - browser front end.
 *
 * Records the microphone with WebAudio, encodes 16-bit PCM WAV at 24 kHz mono
 * in the page (no libraries, no MediaRecorder container to unpick), posts it to
 * /api/chat, and renders the server-sent events as they arrive: text deltas
 * into the bubble, per-sentence WAVs into a playback queue.
 */
(function () {
  "use strict";

  var SAMPLE_RATE = 24000;
  var MIN_RECORD_MS = 350;

  var el = {
    transcript: document.getElementById("transcript"),
    welcome: document.getElementById("welcome"),
    mic: document.getElementById("mic"),
    meter: document.getElementById("meter"),
    meterLabel: document.getElementById("meter-label"),
    text: document.getElementById("text-input"),
    clear: document.getElementById("btn-clear"),
    mute: document.getElementById("mute"),
    pillLlm: document.getElementById("pill-llm"),
    pillTts: document.getElementById("pill-tts")
  };

  var sessionId = localStorage.getItem("va.session") || randomId();
  localStorage.setItem("va.session", sessionId);

  var state = {
    recording: false,
    held: false,          // true while a press-and-hold is in progress
    busy: false,
    muted: false,
    startedAt: 0
  };

  function randomId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "");
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  /* ------------------------------------------------------------ transcript */

  function dropWelcome() {
    if (el.welcome && el.welcome.parentNode) el.welcome.remove();
  }

  function atBottom() {
    return el.transcript.scrollHeight - el.transcript.scrollTop - el.transcript.clientHeight < 90;
  }

  function scroll(force) {
    if (force || atBottom()) el.transcript.scrollTop = el.transcript.scrollHeight;
  }

  function addTurn(role) {
    dropWelcome();
    var wrap = document.createElement("div");
    wrap.className = "turn " + role;
    var col = document.createElement("div");
    var bubble = document.createElement("div");
    bubble.className = "bubble";
    var meta = document.createElement("div");
    meta.className = "meta";
    col.appendChild(bubble);
    col.appendChild(meta);
    wrap.appendChild(col);
    el.transcript.appendChild(wrap);
    scroll(true);
    return { wrap: wrap, bubble: bubble, meta: meta };
  }

  function voiceTag(seconds) {
    var span = document.createElement("span");
    span.className = "voice-tag";
    var bars = document.createElement("span");
    bars.className = "bars";
    for (var i = 0; i < 9; i++) {
      var b = document.createElement("i");
      b.style.height = (4 + Math.round(Math.abs(Math.sin(i * 1.7)) * 10)) + "px";
      bars.appendChild(b);
    }
    span.appendChild(bars);
    span.appendChild(document.createTextNode("Voice message - " + seconds.toFixed(1) + "s"));
    return span;
  }

  function systemNote(text) {
    var t = addTurn("system");
    t.bubble.textContent = text;
    scroll(true);
  }

  /* --------------------------------------------------------------- health */

  function paintPill(pill, ok, label) {
    pill.classList.toggle("up", !!ok);
    pill.classList.toggle("down", !ok);
    pill.lastChild.nodeValue = label;
  }

  function pollHealth() {
    fetch("/api/health", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (h) {
        paintPill(el.pillLlm, h.llm && h.llm.ok, h.llm && h.llm.ok ? "thinking ready" : "thinking down");
        paintPill(el.pillTts, h.tts && h.tts.ok, h.tts && h.tts.ok ? "voice ready" : "voice down");
      })
      .catch(function () {
        paintPill(el.pillLlm, false, "no server");
        paintPill(el.pillTts, false, "no server");
      });
  }

  /* ------------------------------------------------------ audio playback */

  var playQueue = [];
  var playing = false;
  var current = null;

  function enqueueAudio(url, onStart) {
    playQueue.push({ url: url, onStart: onStart });
    pumpQueue();
  }

  function pumpQueue() {
    if (playing || !playQueue.length) return;
    if (state.muted) { playQueue.length = 0; return; }
    var item = playQueue.shift();
    playing = true;
    var audio = new Audio(item.url);
    current = audio;
    audio.addEventListener("ended", next);
    audio.addEventListener("error", next);
    if (item.onStart) item.onStart();
    audio.play().catch(function () { next(); });

    function next() {
      audio.removeEventListener("ended", next);
      audio.removeEventListener("error", next);
      playing = false;
      current = null;
      pumpQueue();
    }
  }

  function stopPlayback() {
    playQueue.length = 0;
    if (current) { try { current.pause(); } catch (e) {} }
    current = null;
    playing = false;
  }

  /* --------------------------------------------------------- wav encoding */

  function encodeWav(chunks, total, rate) {
    var buffer = new ArrayBuffer(44 + total * 2);
    var view = new DataView(buffer);
    function str(offset, s) {
      for (var i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
    }
    str(0, "RIFF");
    view.setUint32(4, 36 + total * 2, true);
    str(8, "WAVEfmt ");
    view.setUint32(16, 16, true);          // PCM header size
    view.setUint16(20, 1, true);           // format: PCM
    view.setUint16(22, 1, true);           // mono
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);    // byte rate
    view.setUint16(32, 2, true);           // block align
    view.setUint16(34, 16, true);          // bits per sample
    str(36, "data");
    view.setUint32(40, total * 2, true);

    var offset = 44;
    for (var c = 0; c < chunks.length; c++) {
      var chunk = chunks[c];
      for (var i = 0; i < chunk.length; i++) {
        var s = chunk[i];
        s = s < -1 ? -1 : (s > 1 ? 1 : s);
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        offset += 2;
      }
    }
    return buffer;
  }

  function toBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var out = "";
    for (var i = 0; i < bytes.length; i += 0x8000) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(out);
  }

  /* ------------------------------------------------------------ recording */

  // An AudioWorklet keeps capture off the main thread; ScriptProcessor is the
  // fallback for browsers that will not give us one (or a non-secure origin).
  var WORKLET_SRC =
    "class Cap extends AudioWorkletProcessor{" +
    "process(inputs){const ch=inputs[0]&&inputs[0][0];" +
    "if(ch&&ch.length){this.port.postMessage(new Float32Array(ch));}return true;}}" +
    "registerProcessor('cap',Cap);";

  var mic = {
    ctx: null, stream: null, node: null, source: null, analyser: null,
    chunks: [], total: 0, rate: SAMPLE_RATE
  };

  function startRecording() {
    if (state.recording || state.busy) return Promise.resolve();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      systemNote("This browser will not give the page a microphone. Type your question instead.");
      return Promise.resolve();
    }
    stopPlayback();
    state.recording = true;
    paintMic();
    setMeterLabel("listening", true);

    return navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    }).then(function (stream) {
      if (!state.recording) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      mic.stream = stream;
      var Ctx = window.AudioContext || window.webkitAudioContext;
      var ctx;
      try { ctx = new Ctx({ sampleRate: SAMPLE_RATE }); }
      catch (e) { ctx = new Ctx(); }
      mic.ctx = ctx;
      mic.rate = ctx.sampleRate;
      mic.chunks = [];
      mic.total = 0;

      mic.source = ctx.createMediaStreamSource(stream);
      mic.analyser = ctx.createAnalyser();
      mic.analyser.fftSize = 1024;
      mic.analyser.smoothingTimeConstant = 0.6;
      mic.source.connect(mic.analyser);
      drawMeter();

      if (ctx.audioWorklet) {
        var url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "text/javascript" }));
        return ctx.audioWorklet.addModule(url).then(function () {
          URL.revokeObjectURL(url);
          var node = new AudioWorkletNode(ctx, "cap");
          node.port.onmessage = function (ev) { collect(ev.data); };
          mic.source.connect(node);
          // Worklets need a destination to be pulled; a muted gain does it.
          var sink = ctx.createGain();
          sink.gain.value = 0;
          node.connect(sink).connect(ctx.destination);
          mic.node = node;
        }).catch(useScriptProcessor);
      }
      return useScriptProcessor();

      function useScriptProcessor() {
        var node = ctx.createScriptProcessor(4096, 1, 1);
        node.onaudioprocess = function (ev) {
          collect(new Float32Array(ev.inputBuffer.getChannelData(0)));
        };
        var sink = ctx.createGain();
        sink.gain.value = 0;
        mic.source.connect(node);
        node.connect(sink).connect(ctx.destination);
        mic.node = node;
      }
    }).catch(function (err) {
      state.recording = false;
      paintMic();
      setMeterLabel("ready", false);
      systemNote("The microphone is not available: " + (err && err.message ? err.message : err));
    });
  }

  function collect(frame) {
    if (!state.recording) return;
    mic.chunks.push(frame);
    mic.total += frame.length;
  }

  function teardownMic() {
    if (mic.node) { try { mic.node.disconnect(); mic.node.onaudioprocess = null; } catch (e) {} }
    if (mic.source) { try { mic.source.disconnect(); } catch (e) {} }
    if (mic.stream) mic.stream.getTracks().forEach(function (t) { t.stop(); });
    if (mic.ctx) { try { mic.ctx.close(); } catch (e) {} }
    mic.node = mic.source = mic.stream = mic.analyser = null;
    mic.ctx = null;
  }

  function stopRecording(send) {
    if (!state.recording) return;
    state.recording = false;
    var chunks = mic.chunks, total = mic.total, rate = mic.rate;
    var elapsed = Date.now() - state.startedAt;
    teardownMic();
    paintMic();
    setMeterLabel("ready", false);
    mic.chunks = [];
    mic.total = 0;

    if (!send) return;
    if (total === 0 || elapsed < MIN_RECORD_MS) {
      systemNote("That was too short to hear. Hold the button while you speak.");
      return;
    }
    var wav = encodeWav(chunks, total, rate);
    send_(toBase64(wav), null, total / rate);
  }

  /* ---------------------------------------------------------- level meter */

  var meterCtx = el.meter.getContext("2d");
  var meterRaf = null;
  var idlePhase = 0;

  function sizeMeter() {
    var dpr = window.devicePixelRatio || 1;
    var w = el.meter.clientWidth || 720;
    var h = el.meter.clientHeight || 46;
    el.meter.width = Math.round(w * dpr);
    el.meter.height = Math.round(h * dpr);
    meterCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function setMeterLabel(text, live) {
    el.meterLabel.textContent = text;
    el.meterLabel.classList.toggle("live", !!live);
  }

  function drawMeter() {
    cancelAnimationFrame(meterRaf);
    var data = mic.analyser ? new Uint8Array(mic.analyser.fftSize) : null;

    (function frame() {
      meterRaf = requestAnimationFrame(frame);
      var w = el.meter.clientWidth || 720;
      var h = el.meter.clientHeight || 46;
      meterCtx.clearRect(0, 0, w, h);

      var bars = Math.max(24, Math.floor(w / 9));
      var mid = h / 2;
      var grad = meterCtx.createLinearGradient(0, 0, w, 0);

      if (state.recording && mic.analyser) {
        mic.analyser.getByteTimeDomainData(data);
        grad.addColorStop(0, "rgba(139,123,255,0.85)");
        grad.addColorStop(0.5, "rgba(255,107,129,0.95)");
        grad.addColorStop(1, "rgba(53,214,196,0.85)");
      } else {
        idlePhase += 0.035;
        grad.addColorStop(0, "rgba(139,123,255,0.30)");
        grad.addColorStop(1, "rgba(53,214,196,0.30)");
      }
      meterCtx.fillStyle = grad;

      var step = w / bars;
      for (var i = 0; i < bars; i++) {
        var level;
        if (state.recording && data) {
          var from = Math.floor(i * data.length / bars);
          var to = Math.floor((i + 1) * data.length / bars);
          var peak = 0;
          for (var j = from; j < to; j++) {
            var v = Math.abs(data[j] - 128) / 128;
            if (v > peak) peak = v;
          }
          level = Math.min(1, Math.pow(peak, 0.7) * 1.7);
        } else {
          var wave = 0.5 + 0.5 * Math.sin(idlePhase + i * 0.28);
          level = 0.05 + 0.3 * wave * wave;
        }
        var barH = Math.max(2.5, level * (h - 6));
        var x = i * step + step * 0.22;
        var bw = Math.max(2, step * 0.56);
        roundRect(x, mid - barH / 2, bw, barH, Math.min(bw / 2, 3));
      }
    })();
  }

  function roundRect(x, y, w, h, r) {
    meterCtx.beginPath();
    if (meterCtx.roundRect) { meterCtx.roundRect(x, y, w, h, r); }
    else { meterCtx.rect(x, y, w, h); }
    meterCtx.fill();
  }

  /* ------------------------------------------------------------- the chain */

  function send_(audioB64, text, seconds) {
    if (state.busy) return;
    state.busy = true;
    paintMic();

    var userTurn = addTurn("user");
    if (audioB64) userTurn.bubble.appendChild(voiceTag(seconds || 0));
    else userTurn.bubble.textContent = text;

    var reply = addTurn("assistant");
    var thinking = document.createElement("span");
    thinking.className = "thinking";
    thinking.innerHTML = "<i></i><i></i><i></i>";
    reply.bubble.appendChild(thinking);

    var caret = document.createElement("span");
    caret.className = "caret";
    var textNode = document.createTextNode("");
    var firstTokenMs = null;
    var spoke = false;

    fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sessionId, audio: audioB64, text: text })
    }).then(function (resp) {
      if (!resp.ok || !resp.body) {
        return resp.text().then(function (t) { throw new Error(t || ("HTTP " + resp.status)); });
      }
      return readEvents(resp.body, onEvent);
    }).catch(function (err) {
      finish();
      reply.meta.textContent = "";
      systemNote("Something went wrong: " + (err && err.message ? err.message : err));
    });

    function beginText() {
      if (thinking.parentNode) thinking.remove();
      if (!textNode.parentNode) {
        reply.bubble.appendChild(textNode);
        reply.bubble.appendChild(caret);
      }
    }

    function onEvent(ev) {
      if (ev.type === "session" && ev.sessionId) {
        sessionId = ev.sessionId;
        localStorage.setItem("va.session", sessionId);
      } else if (ev.type === "start") {
        firstTokenMs = ev.firstTokenMs;
        beginText();
      } else if (ev.type === "delta") {
        beginText();
        textNode.nodeValue += ev.text;
        scroll();
      } else if (ev.type === "audio") {
        enqueueAudio(ev.url, null);
        if (!spoke) {
          spoke = true;
          stampMeta(reply.meta, firstTokenMs, ev.atMs, null);
        }
      } else if (ev.type === "error") {
        beginText();
        systemNote(ev.message);
      } else if (ev.type === "done") {
        finish();
        if (ev.text) textNode.nodeValue = ev.text;
        stampMeta(reply.meta, ev.firstTokenMs, ev.firstAudioMs, ev.totalMs);
        if (!ev.text) reply.bubble.textContent = "(no reply)";
      }
    }

    function finish() {
      if (caret.parentNode) caret.remove();
      if (thinking.parentNode) thinking.remove();
      state.busy = false;
      paintMic();
      scroll();
    }
  }

  function stampMeta(meta, firstTokenMs, firstAudioMs, totalMs) {
    var bits = [];
    if (firstTokenMs != null) bits.push("first word " + fmt(firstTokenMs));
    if (firstAudioMs != null) bits.push("first sound " + fmt(firstAudioMs));
    if (totalMs != null) bits.push("total " + fmt(totalMs));
    meta.textContent = bits.join("  -  ");
  }

  function fmt(ms) {
    return ms < 1000 ? ms + " ms" : (ms / 1000).toFixed(1) + " s";
  }

  // Server-sent events over fetch: split the stream on blank lines and hand
  // each `data:` payload to the caller as parsed JSON.
  function readEvents(body, onEvent) {
    var reader = body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";

    return reader.read().then(function step(result) {
      if (result.done) {
        flush(buffer);
        return;
      }
      buffer += decoder.decode(result.value, { stream: true });
      var parts = buffer.split("\n\n");
      buffer = parts.pop();
      parts.forEach(flush);
      return reader.read().then(step);
    });

    function flush(block) {
      block.split("\n").forEach(function (line) {
        if (line.indexOf("data:") !== 0) return;
        var payload = line.slice(5).trim();
        if (!payload) return;
        try { onEvent(JSON.parse(payload)); } catch (e) { /* partial or junk */ }
      });
    }
  }

  /* ------------------------------------------------------------- controls */

  function paintMic() {
    el.mic.classList.toggle("recording", state.recording);
    el.mic.classList.toggle("busy", state.busy && !state.recording);
    el.mic.disabled = state.busy && !state.recording;
    el.mic.setAttribute("aria-label", state.recording ? "Stop recording" : "Hold to talk");
    if (state.recording) setMeterLabel("listening", true);
    else setMeterLabel(state.busy ? "thinking" : "ready", false);
  }

  var pressTimer = null;
  var pressStart = 0;

  el.mic.addEventListener("pointerdown", function (ev) {
    if (state.busy) return;
    ev.preventDefault();
    el.mic.setPointerCapture && el.mic.setPointerCapture(ev.pointerId);
    if (state.recording) { stopRecording(true); return; }   // toggle off
    pressStart = Date.now();
    state.held = true;
    state.startedAt = Date.now();
    startRecording();
  });

  function release() {
    if (!state.held) return;
    state.held = false;
    // A quick tap means "keep recording until I tap again"; a real hold means
    // "I have finished speaking, send it".
    if (Date.now() - pressStart < 400) return;
    stopRecording(true);
  }

  el.mic.addEventListener("pointerup", release);
  el.mic.addEventListener("pointercancel", function () {
    state.held = false;
    if (state.recording) stopRecording(true);
  });

  document.addEventListener("keydown", function (ev) {
    if (ev.code !== "Space" || ev.repeat) return;
    if (document.activeElement === el.text) return;
    ev.preventDefault();
    if (state.recording) { stopRecording(true); return; }
    if (state.busy) return;
    state.startedAt = Date.now();
    startRecording();
  });

  el.text.addEventListener("keydown", function (ev) {
    if (ev.key !== "Enter") return;
    var value = el.text.value.trim();
    if (!value || state.busy) return;
    el.text.value = "";
    send_(null, value, 0);
  });

  el.clear.addEventListener("click", function () {
    stopPlayback();
    fetch("/api/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sessionId })
    }).catch(function () {}).then(function () {
      sessionId = randomId();
      localStorage.setItem("va.session", sessionId);
      el.transcript.innerHTML = "";
      if (el.welcome) el.transcript.appendChild(el.welcome);
      systemNote("New conversation. The assistant has forgotten what came before.");
    });
  });

  el.mute.addEventListener("click", function () {
    state.muted = !state.muted;
    el.mute.textContent = state.muted ? "Sound off" : "Sound on";
    if (state.muted) stopPlayback();
  });

  window.addEventListener("resize", sizeMeter);
  window.addEventListener("beforeunload", teardownMic);

  sizeMeter();
  drawMeter();
  setMeterLabel("ready", false);
  pollHealth();
  setInterval(pollHealth, 10000);
})();
