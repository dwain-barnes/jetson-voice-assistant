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

  /* ------------------------------------------- conversation mode tunables
   *
   * Hands-free listening. The microphone stays open, an energy VAD decides
   * where each utterance starts and stops, and every finished one is sent on
   * its own. Times are milliseconds; levels are linear RMS of the -1..1 float
   * frames the capture node hands us (roughly: 0.001 is a quiet room, 0.05 is
   * someone talking a foot from a laptop mic).
   *
   * These are the values that behave on a quiet desk with the browser's own
   * noise suppression on. Edit them here - nothing below hard-codes a number.
   */
  var VAD = {
    windowMs:     20,     // RMS is measured over windows this long, whatever
                          //   block size the capture node happens to deliver
    calibrateMs:  1000,   // listen to the room this long before arming
    thresholdK:   3.2,    // speech when RMS climbs past noiseFloor * k
    floorMin:     0.004,  // ...but never below this, so a near-silent room
                          //   cannot arm the VAD on its own hiss
    floorMax:     0.06,   // and a roaring room is clamped rather than going
                          //   deaf: above this we stop trusting the floor
    adapt:        0.02,   // EMA weight for following the floor while idle
    startMs:      120,    // continuous speech-level audio that means "began"
    endMs:        700,    // continuous quiet that means "finished"
    minSpeechMs:  350,    // less voiced audio than this is a cough, not a turn
    prerollMs:    300,    // audio kept from before the start, so the first
                          //   syllable survives the startMs decision delay
    maxUtterMs:   30000,  // hard stop: a stuck mic must not record forever
    resumeDelayMs: 250    // settle after the reply stops before listening
                          //   again, so the speaker's tail is not an utterance
  };

  var el = {
    transcript: document.getElementById("transcript"),
    welcome: document.getElementById("welcome"),
    mic: document.getElementById("mic"),
    meter: document.getElementById("meter"),
    meterLabel: document.getElementById("meter-label"),
    text: document.getElementById("text-input"),
    clear: document.getElementById("btn-clear"),
    mute: document.getElementById("mute"),
    conv: document.getElementById("conv"),
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

  function voiceTag(seconds, label) {
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
    span.appendChild(document.createTextNode(
      (label || "Voice message") + " - " + seconds.toFixed(1) + "s"));
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
    if (conv.on) convPhase("speaking");
    audio.play().catch(function () { next(); });

    function next() {
      audio.removeEventListener("ended", next);
      audio.removeEventListener("error", next);
      playing = false;
      current = null;
      pumpQueue();
      // Nothing left to say: hands-free listening can have its ears back.
      maybeResumeListening();
    }
  }

  function stopPlayback() {
    playQueue.length = 0;
    if (current) { try { current.pause(); } catch (e) {} }
    current = null;
    playing = false;
    maybeResumeListening();
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

  var WORKLET_TIMEOUT_MS = 1500;   // give up on the worklet and use the fallback

  /* Open the microphone and hand every frame of samples to `onFrame`.
   * Push-to-talk and hands-free listening both go through here, so the
   * worklet/ScriptProcessor dance and the teardown live in one place.
   * Resolves with a handle: { rate, analyser, close() }.
   */
  function openCapture(onFrame) {
    var parts = { ctx: null, stream: null, node: null, source: null };

    function close() {
      if (parts.node) {
        try { parts.node.disconnect(); parts.node.onaudioprocess = null; } catch (e) {}
      }
      if (parts.source) { try { parts.source.disconnect(); } catch (e) {} }
      if (parts.stream) parts.stream.getTracks().forEach(function (t) { t.stop(); });
      if (parts.ctx) { try { parts.ctx.close(); } catch (e) {} }
      parts.node = parts.source = parts.stream = parts.ctx = null;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error(
        "This browser will not give the page a microphone."));
    }

    return navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    }).then(function (stream) {
      parts.stream = stream;
      var Ctx = window.AudioContext || window.webkitAudioContext;
      var ctx;
      try { ctx = new Ctx({ sampleRate: SAMPLE_RATE }); }
      catch (e) { ctx = new Ctx(); }
      parts.ctx = ctx;

      parts.source = ctx.createMediaStreamSource(stream);
      var analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.6;
      parts.source.connect(analyser);

      // Worklets need a destination to be pulled; a muted gain does it.
      function attach(node) {
        var sink = ctx.createGain();
        sink.gain.value = 0;
        parts.source.connect(node);
        node.connect(sink).connect(ctx.destination);
        parts.node = node;
      }

      function useScriptProcessor() {
        var node = ctx.createScriptProcessor(4096, 1, 1);
        node.onaudioprocess = function (ev) {
          onFrame(new Float32Array(ev.inputBuffer.getChannelData(0)));
        };
        attach(node);
      }

      var handle = { rate: ctx.sampleRate, analyser: analyser, close: close };

      if (ctx.audioWorklet) {
        var url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "text/javascript" }));
        // Some builds (headless Chromium among them) neither resolve nor
        // reject addModule. Without a deadline the microphone would simply
        // never start and nothing would say why, so the wait is capped and the
        // ScriptProcessor takes over.
        return Promise.race([
          ctx.audioWorklet.addModule(url),
          new Promise(function (_, reject) {
            setTimeout(function () {
              reject(new Error("the audio worklet did not load"));
            }, WORKLET_TIMEOUT_MS);
          })
        ]).then(function () {
          URL.revokeObjectURL(url);
          var node = new AudioWorkletNode(ctx, "cap");
          node.port.onmessage = function (ev) { onFrame(ev.data); };
          attach(node);
          return handle;
        }).catch(function () {
          URL.revokeObjectURL(url);
          useScriptProcessor();
          return handle;
        });
      }
      useScriptProcessor();
      return handle;
    }).catch(function (err) {
      close();
      throw err;
    });
  }

  var mic = {
    handle: null, analyser: null,
    chunks: [], total: 0, rate: SAMPLE_RATE
  };

  function startRecording() {
    if (state.recording || state.busy) return Promise.resolve();
    stopPlayback();
    state.recording = true;
    mic.chunks = [];
    mic.total = 0;
    paintMic();
    setMeterLabel("listening", true);

    return openCapture(collect).then(function (handle) {
      if (!state.recording) { handle.close(); return; }
      mic.handle = handle;
      mic.analyser = handle.analyser;
      mic.rate = handle.rate;
      drawMeter();
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
    if (mic.handle) mic.handle.close();
    mic.handle = null;
    mic.analyser = null;
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

  /* ----------------------------------------------------- conversation mode */

  /* The VAD proper: a state machine fed one RMS window at a time.
   *
   *   calibrate --(calibrateMs of room tone)---> idle
   *   idle      --(startMs above threshold)----> speech    emits "start"
   *   speech    --(endMs below threshold, or maxUtterMs)--> idle
   *                                             emits "end", or "tooshort"
   *                                             if too little of it was voiced
   *
   * It holds no audio and touches no DOM, so a test can drive it with made-up
   * numbers and no microphone - see window.__voiceTest at the end of the file.
   */
  function makeVad(cfg) {
    var c = cfg || VAD;
    var s = {
      phase: "calibrate",
      floor: 0,          // measured room tone
      threshold: 0,      // floor * k, clamped
      calMs: 0, calSum: 0, calN: 0,
      loudMs: 0,         // run of above-threshold windows while idle
      quietMs: 0,        // run of below-threshold windows while speaking
      utterMs: 0,        // wall time since speech started
      voicedMs: 0        // of which was actually above threshold
    };

    function retune() {
      s.threshold = Math.max(c.floorMin, Math.min(s.floor, c.floorMax) * c.thresholdK);
    }

    function push(rms, ms) {
      if (s.phase === "calibrate") {
        s.calSum += rms;
        s.calN += 1;
        s.calMs += ms;
        if (s.calMs < c.calibrateMs) return null;
        s.floor = s.calN ? s.calSum / s.calN : 0;
        retune();
        s.phase = "idle";
        return "calibrated";
      }

      var loud = rms > s.threshold;

      if (s.phase === "idle") {
        if (!loud) {
          s.loudMs = 0;
          // Follow the room while nothing is happening, so a fan spinning up
          // does not become a permanent false positive.
          s.floor = s.floor * (1 - c.adapt) + rms * c.adapt;
          retune();
          return null;
        }
        s.loudMs += ms;
        if (s.loudMs < c.startMs) return null;
        s.phase = "speech";
        s.utterMs = s.voicedMs = s.loudMs;
        s.loudMs = s.quietMs = 0;
        return "start";
      }

      s.utterMs += ms;
      if (loud) { s.voicedMs += ms; s.quietMs = 0; }
      else { s.quietMs += ms; }

      if (s.quietMs < c.endMs && s.utterMs < c.maxUtterMs) return null;
      var enough = s.voicedMs >= c.minSpeechMs;
      s.phase = "idle";
      s.loudMs = s.quietMs = 0;
      return enough ? "end" : "tooshort";
    }

    // `recalibrate` throws the measured floor away and listens to the room
    // again; without it the floor survives and only the counters are cleared.
    function reset(recalibrate) {
      s.loudMs = s.quietMs = s.utterMs = s.voicedMs = 0;
      if (recalibrate) {
        s.phase = "calibrate";
        s.calMs = s.calSum = s.calN = 0;
      } else if (s.phase !== "calibrate") {
        s.phase = "idle";
      }
    }

    return { state: s, push: push, reset: reset };
  }

  var CONV_LABELS = {
    calibrating: "listening to the room",
    listening:   "conversation - listening",
    hearing:     "hearing you",
    thinking:    "thinking",
    speaking:    "speaking"
  };

  var conv = {
    on: false,
    phase: "off",        // off | calibrating | listening | hearing | thinking | speaking
    vad: null,
    handle: null,
    rate: SAMPLE_RATE,
    ring: [], ringN: 0,     // pre-roll: the last prerollMs+startMs of frames
    utter: [], utterN: 0,   // the utterance being captured
    capturing: false,
    suspended: false,       // half-duplex: deaf while the assistant talks
    winSum: 0, winN: 0      // part-built RMS window, carried between frames
  };

  var resumeTimer = null;

  function resetCapture() {
    conv.ring = []; conv.ringN = 0;
    conv.utter = []; conv.utterN = 0;
    conv.capturing = false;
  }

  function convPhase(phase) {
    conv.phase = phase;
    paintMeterLabel();
    paintConv();
  }

  /* Every captured frame in conversation mode passes through here: it feeds
   * the pre-roll ring (or the utterance), and grinds the samples into
   * fixed-length RMS windows so the VAD's timing does not depend on whether we
   * got 128-sample worklet quanta or 4096-sample ScriptProcessor blocks. */
  function convFrame(frame) {
    if (!conv.on || conv.suspended) return;
    var rate = conv.rate || SAMPLE_RATE;

    if (conv.capturing) {
      conv.utter.push(frame);
      conv.utterN += frame.length;
    } else {
      conv.ring.push(frame);
      conv.ringN += frame.length;
      // Keep enough run-up to cover the pre-roll plus the startMs it takes to
      // decide someone is talking.
      var keep = Math.round(rate * (VAD.prerollMs + VAD.startMs) / 1000);
      while (conv.ring.length > 1 && conv.ringN - conv.ring[0].length >= keep) {
        conv.ringN -= conv.ring.shift().length;
      }
    }

    var per = Math.max(1, Math.round(rate * VAD.windowMs / 1000));
    for (var i = 0; i < frame.length; i++) {
      conv.winSum += frame[i] * frame[i];
      conv.winN += 1;
      if (conv.winN < per) continue;
      var rms = Math.sqrt(conv.winSum / conv.winN);
      var ms = conv.winN * 1000 / rate;
      conv.winSum = 0;
      conv.winN = 0;
      onVadEvent(conv.vad.push(rms, ms));
      if (!conv.on || conv.suspended) return;   // the event ended the turn
    }
  }

  function onVadEvent(ev) {
    if (!ev) return;
    if (ev === "calibrated") {
      convPhase("listening");
    } else if (ev === "start") {
      // The ring holds the run-up, including the syllable that triggered us.
      conv.utter = conv.ring;
      conv.utterN = conv.ringN;
      conv.ring = []; conv.ringN = 0;
      conv.capturing = true;
      convPhase("hearing");
    } else if (ev === "end") {
      var chunks = conv.utter, total = conv.utterN, rate = conv.rate;
      resetCapture();
      suspendListening();
      convPhase("thinking");
      send_(toBase64(encodeWav(chunks, total, rate)), null, total / rate, true);
    } else if (ev === "tooshort") {
      resetCapture();
      convPhase("listening");
    }
  }

  function suspendListening() {
    clearTimeout(resumeTimer);
    conv.suspended = true;
    resetCapture();
    conv.winSum = 0; conv.winN = 0;
    if (conv.vad) conv.vad.reset(false);
  }

  function resumeListening() {
    if (!conv.on) return;
    conv.suspended = false;
    resetCapture();
    conv.winSum = 0; conv.winN = 0;
    conv.vad.reset(false);
    convPhase(conv.vad.state.phase === "calibrate" ? "calibrating" : "listening");
  }

  /* Called from everywhere a turn can end - the stream finishing, the last
   * sentence playing out, muting, clearing. Listening only comes back when the
   * assistant has both stopped writing and stopped talking. */
  function maybeResumeListening() {
    if (!conv.on || !conv.suspended) return;
    if (state.busy || playing || playQueue.length) return;
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(function () {
      if (conv.on && conv.suspended && !state.busy && !playing && !playQueue.length) {
        resumeListening();
      }
    }, VAD.resumeDelayMs);
  }

  function enterConversation() {
    if (conv.on) return;
    if (state.recording) stopRecording(false);
    conv.on = true;
    conv.vad = makeVad(VAD);
    resetCapture();
    conv.suspended = false;
    conv.winSum = 0; conv.winN = 0;
    convPhase("calibrating");
    paintMic();

    openCapture(convFrame).then(function (handle) {
      if (!conv.on) { handle.close(); return; }
      conv.handle = handle;
      conv.rate = handle.rate;
      drawMeter();
      // Entered mid-reply: stay deaf until it has finished speaking.
      if (state.busy || playing || playQueue.length) {
        suspendListening();
        convPhase(state.busy ? "thinking" : "speaking");
      }
    }).catch(function (err) {
      exitConversation();
      // Do not remember a mode that could not start.
      localStorage.setItem("va.conversation", "0");
      systemNote("The microphone is not available: " +
                 (err && err.message ? err.message : err));
    });
  }

  function exitConversation() {
    if (!conv.on) return;
    conv.on = false;
    conv.suspended = false;
    clearTimeout(resumeTimer);
    if (conv.handle) conv.handle.close();
    conv.handle = null;
    conv.vad = null;
    resetCapture();
    conv.winSum = 0; conv.winN = 0;
    convPhase("off");
    paintMic();
  }

  function toggleConversation() {
    if (conv.on) exitConversation(); else enterConversation();
    // Remembered, but never acted on at load: the mic must cost one click.
    localStorage.setItem("va.conversation", conv.on ? "1" : "0");
    el.conv.classList.remove("remembered");
  }

  function paintConv() {
    el.conv.classList.toggle("active", conv.on);
    el.conv.classList.toggle("hearing", conv.on && conv.phase === "hearing");
    el.conv.setAttribute("aria-pressed", conv.on ? "true" : "false");
    el.conv.title = conv.on
      ? "Hands-free: " + (CONV_LABELS[conv.phase] || "on") + " (Esc to stop)"
      : "Hands-free: it listens, you just talk";
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

  // Whichever capture is open owns the meter: push-to-talk or hands-free.
  function activeAnalyser() {
    if (conv.on && conv.handle) return conv.handle.analyser;
    return state.recording ? mic.analyser : null;
  }

  function drawMeter() {
    cancelAnimationFrame(meterRaf);
    var data = null;

    (function frame() {
      meterRaf = requestAnimationFrame(frame);
      var w = el.meter.clientWidth || 720;
      var h = el.meter.clientHeight || 46;
      meterCtx.clearRect(0, 0, w, h);

      var bars = Math.max(24, Math.floor(w / 9));
      var mid = h / 2;
      var grad = meterCtx.createLinearGradient(0, 0, w, 0);

      var analyser = activeAnalyser();
      var live = !!analyser && (state.recording || (conv.on && !conv.suspended));
      if (live) {
        if (!data || data.length !== analyser.fftSize) {
          data = new Uint8Array(analyser.fftSize);
        }
        analyser.getByteTimeDomainData(data);
      } else {
        idlePhase += 0.035;
      }

      // Conversation mode gets its own palette, so a glance at the dock says
      // which of the two ways of talking is switched on, and which phase of
      // the loop it is in.
      if (conv.on) {
        if (conv.phase === "hearing") {
          grad.addColorStop(0, "rgba(53,214,196,0.95)");
          grad.addColorStop(0.5, "rgba(139,123,255,0.95)");
          grad.addColorStop(1, "rgba(53,214,196,0.95)");
        } else if (live) {                          // listening / calibrating
          grad.addColorStop(0, "rgba(53,214,196,0.55)");
          grad.addColorStop(1, "rgba(74,222,128,0.55)");
        } else if (conv.phase === "speaking") {
          grad.addColorStop(0, "rgba(139,123,255,0.60)");
          grad.addColorStop(1, "rgba(139,123,255,0.28)");
        } else {                                    // thinking
          grad.addColorStop(0, "rgba(139,123,255,0.26)");
          grad.addColorStop(1, "rgba(53,214,196,0.26)");
        }
      } else if (live) {
        grad.addColorStop(0, "rgba(139,123,255,0.85)");
        grad.addColorStop(0.5, "rgba(255,107,129,0.95)");
        grad.addColorStop(1, "rgba(53,214,196,0.85)");
      } else {
        grad.addColorStop(0, "rgba(139,123,255,0.30)");
        grad.addColorStop(1, "rgba(53,214,196,0.30)");
      }
      meterCtx.fillStyle = grad;

      var step = w / bars;
      for (var i = 0; i < bars; i++) {
        var level;
        if (live && data) {
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

  function send_(audioB64, text, seconds, spoken) {
    if (state.busy) return;
    state.busy = true;
    paintMic();

    var userTurn = addTurn("user");
    if (audioB64) {
      userTurn.bubble.appendChild(
        voiceTag(seconds || 0, spoken ? "Spoken" : "Voice message"));
    } else {
      userTurn.bubble.textContent = text;
    }

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
      // Nothing more to write; if nothing is queued to speak either, hands-free
      // listening resumes from here rather than waiting on an audio element.
      maybeResumeListening();
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
    // Push-to-talk stands down while hands-free has the microphone: two
    // captures of the same device is one too many.
    el.mic.disabled = conv.on || (state.busy && !state.recording);
    el.mic.setAttribute("aria-label",
      conv.on ? "Conversation mode is listening" :
      state.recording ? "Stop recording" : "Hold to talk");
    paintMeterLabel();
  }

  function paintMeterLabel() {
    el.meterLabel.classList.toggle("conv", conv.on);
    if (conv.on) {
      setMeterLabel(CONV_LABELS[conv.phase] || "conversation",
                    conv.phase === "hearing");
      return;
    }
    if (state.recording) setMeterLabel("listening", true);
    else setMeterLabel(state.busy ? "thinking" : "ready", false);
  }

  var pressTimer = null;
  var pressStart = 0;

  el.mic.addEventListener("pointerdown", function (ev) {
    if (state.busy || conv.on) return;
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
    if (conv.on) return;                 // hands-free already has the mic
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
    else maybeResumeListening();
  });

  el.conv.addEventListener("click", toggleConversation);

  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Escape" || !conv.on) return;
    exitConversation();
    localStorage.setItem("va.conversation", "0");
  });

  window.addEventListener("resize", sizeMeter);
  window.addEventListener("beforeunload", function () {
    teardownMic();
    exitConversation();
  });

  sizeMeter();
  drawMeter();
  setMeterLabel("ready", false);
  paintConv();
  // The preference is remembered, but the microphone never opens by itself:
  // all a remembered "on" earns is a hint on the button.
  if (localStorage.getItem("va.conversation") === "1") {
    el.conv.classList.add("remembered");
    el.conv.title = "Conversation mode was on last time - click to start listening";
  }
  pollHealth();
  setInterval(pollHealth, 10000);

  /* Exposed for tests, not for the page: drive the VAD with synthetic RMS
   * windows and no microphone, and read back which phase the mode is in. */
  window.__voiceTest = {
    makeVad: makeVad,
    vadConfig: VAD,
    conversation: function () {
      return {
        on: conv.on,
        phase: conv.phase,
        suspended: conv.suspended,
        capturing: conv.capturing,
        vad: conv.vad ? {
          phase: conv.vad.state.phase,
          floor: conv.vad.state.floor,
          threshold: conv.vad.state.threshold
        } : null
      };
    }
  };
})();
