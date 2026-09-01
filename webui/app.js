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
    resumeDelayMs: 250,   // settle after the reply stops before listening
                          //   again, so the speaker's tail is not an utterance

    /* --- barge-in: the stricter gate used while the assistant holds the floor
     *
     * With barge-in on, the microphone is never switched off - so everything
     * the speakers play, everything the echo canceller failed to cancel, and
     * every chair creak is offered to the detector while the assistant is
     * talking. Answering all of that would cut the reply off constantly, so
     * interrupting needs both a much louder signal and a much longer one than
     * simply starting to talk into silence does.
     */
    interruptK:   6.4,    // interrupt threshold, as noiseFloor * k. Kept as a
                          //   ratio to thresholdK (2x) rather than an absolute
                          //   level, so tuning the room tunes both together
    interruptMs:  250,    // loud audio needed to cut the reply off, counted
                          //   net: a loud window adds, a quiet one takes the
                          //   same away. Real speech dips below any bar
                          //   between syllables, so an unbroken run of this
                          //   length simply never happens - but a bang or a
                          //   cough decays back to nothing while someone
                          //   genuinely talking climbs. Speech is loud about
                          //   two thirds of the time, so this lands roughly
                          //   half a second into a spoken interruption - a
                          //   little later if a new spoken chunk re-arms the
                          //   echo guard in the middle of it
    echoGuardMs:  300     // deaf to interruptions for this long after each
                          //   spoken chunk begins, while the echo canceller
                          //   converges on the new sound
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
    barge: document.getElementById("barge"),
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

  // The turn currently in flight, so a barge-in can abort it: its id (shared
  // with the server), its AbortController, and the bubble it is writing into.
  var active = null;

  // Transcripts that have landed, newest last. Only the tests read this; the
  // page itself patches the bubble and forgets.
  var transcripts = [];

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

  /* The one icon this file draws itself. Every other icon on the page is
   * inline in index.html; this one belongs to a bubble that only exists after
   * a transcript arrives, so there is nothing in the markup to clone. */
  function micIcon() {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    var p = document.createElementNS(ns, "path");
    p.setAttribute("d", "M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z"
                        + "M5 11a7 7 0 0 0 14 0M12 18v3");
    svg.appendChild(p);
    return svg;
  }

  /* A spoken turn's chip, once the server has sent back what was in it.
   *
   * There is no speech-to-text in the chain - the model listens to the audio
   * and answers it - so until the reply is finished all the page honestly
   * knows about a spoken turn is that it happened and how long it took. When
   * the words do arrive they take the bubble, and the chip is demoted rather
   * than thrown away: a mic and the duration stay underneath, so a glance
   * still says this was said out loud rather than typed.
   *
   * The height is animated from what it was to what it becomes. A bubble that
   * jumps from one line to five in a single frame drags everything below it,
   * and the reply below it is usually the thing being read at the time.
   */
  function morphSpokenBubble(turn, seconds, text, label) {
    var bubble = turn && turn.bubble;
    if (!bubble || bubble.dataset.transcribed === "1" || !text) return;
    bubble.dataset.transcribed = "1";

    var stuck = atBottom();
    var before = bubble.getBoundingClientRect().height;

    var swap = document.createElement("div");
    swap.className = "spoken-swap";

    var words = document.createElement("div");
    words.className = "spoken-text";
    words.textContent = text;
    swap.appendChild(words);

    var note = document.createElement("div");
    note.className = "spoken-note";
    note.appendChild(micIcon());
    note.appendChild(document.createTextNode(
      (label || "Spoken") + " - " + (seconds || 0).toFixed(1) + "s"));
    swap.appendChild(note);

    bubble.textContent = "";
    bubble.appendChild(swap);
    var after = bubble.getBoundingClientRect().height;

    // Detached (a "New chat" while the transcript was in flight) measures zero
    // both times, and there is nothing to animate.
    if (Math.abs(after - before) > 1) {
      bubble.style.overflow = "hidden";
      bubble.style.height = before + "px";
      void bubble.offsetHeight;             // make the browser believe that
      bubble.style.transition = "height 220ms cubic-bezier(.2,.7,.3,1)";
      bubble.style.height = after + "px";
      setTimeout(function () {
        bubble.style.transition = "";
        bubble.style.height = "";
        bubble.style.overflow = "";
        scroll(stuck);
      }, 240);
    }
    // The fade is a CSS animation, and a tab in the background freezes those on
    // their first frame - which is the invisible one. It thaws when the tab is
    // looked at again, but "the words are there unless something stopped the
    // animation" is not a good enough promise for the words. Timers do keep
    // running, so one of those takes the animation away shortly afterwards and
    // the bubble falls back to simply being visible.
    setTimeout(function () { swap.style.animation = "none"; }, 400);
    scroll(stuck);
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
    // Each chunk is a fresh sound for the echo canceller to lock onto, and it
    // needs a moment. Until it has, whatever leaks back into the microphone is
    // the assistant, not the user - so no interruption may be believed yet.
    audio.addEventListener("playing", echoGuard);
    if (item.onStart) item.onStart();
    if (conv.on) convPhase("speaking");
    echoGuard();
    audio.play().catch(function () { next(); });

    function echoGuard() {
      if (conv.on && conv.vad) conv.vad.blackout(VAD.echoGuardMs);
    }

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
   * Resolves with a handle: { rate, analyser, settings, close() }, where
   * `settings` is what the browser actually granted - asking for echo
   * cancellation is not the same as getting it, and barge-in depends on it.
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

      var track = stream.getAudioTracks()[0];
      var granted = {};
      try { granted = (track && track.getSettings) ? (track.getSettings() || {}) : {}; }
      catch (e) { granted = {}; }

      var handle = { rate: ctx.sampleRate, analyser: analyser,
                     settings: granted, close: close };

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
   * The gate decides how hard that idle -> speech step is. In the "normal"
   * gate it is `startMs` above `threshold`: someone talking into a quiet room.
   * In the "interrupt" gate - which is what barge-in switches on while the
   * assistant is thinking or talking - it is `interruptMs` above the much
   * higher `interruptThreshold`, and the event is "interrupt" rather than
   * "start", because cutting a reply off should cost more than beginning one.
   * A blackout window on top of that keeps the first moments of each spoken
   * chunk from being read as an interruption while the echo canceller settles.
   *
   * It holds no audio and touches no DOM, so a test can drive it with made-up
   * numbers and no microphone - see window.__voiceTest at the end of the file.
   */
  function makeVad(cfg) {
    var c = cfg || VAD;
    var s = {
      phase: "calibrate",
      gate: "normal",    // normal | interrupt
      blackoutMs: 0,     // interruptions are not believed while this is > 0
      floor: 0,          // measured room tone
      threshold: 0,      // floor * k, clamped
      interruptThreshold: 0,   // the same, at interruptK
      calMs: 0, calSum: 0, calN: 0,
      loudMs: 0,         // run of above-threshold windows while idle
      quietMs: 0,        // run of below-threshold windows while speaking
      utterMs: 0,        // wall time since speech started
      voicedMs: 0        // of which was actually above threshold
    };

    function retune() {
      s.threshold = Math.max(c.floorMin, Math.min(s.floor, c.floorMax) * c.thresholdK);
      // Derived from the speech threshold rather than clamped separately: in a
      // near-silent room `floorMin` would drag both to the same number and the
      // stricter gate would quietly stop being stricter.
      s.interruptThreshold = s.threshold * (c.interruptK / c.thresholdK);
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

      var interrupting = s.gate === "interrupt";
      if (s.blackoutMs > 0) {
        s.blackoutMs -= ms;
        // Inside the guard the microphone cannot be trusted either way, so
        // freeze rather than judge. Counting the guard as quiet would eat the
        // evidence of someone who began talking just before the chunk did, and
        // a reply in short sentences re-arms the guard every second or so -
        // enough between them to make interrupting nearly impossible.
        if (interrupting && s.phase === "idle") return null;
      }

      var loud = rms > (interrupting ? s.interruptThreshold : s.threshold);

      if (s.phase === "idle") {
        if (!loud) {
          if (interrupting) {
            // Decay rather than reset. Speech is not continuously loud at 20 ms
            // resolution - it stops between syllables - so demanding an
            // unbroken run this long would mean never interrupting at all.
            // Taking the same amount back for quiet still leaves a bang or a
            // cough fading to nothing while real talking climbs.
            s.loudMs = Math.max(0, s.loudMs - ms);
            return null;
          }
          s.loudMs = 0;
          // Follow the room while nothing is happening, so a fan spinning up
          // does not become a permanent false positive. Not while the
          // assistant is talking, though: that is its voice, not the room, and
          // learning it would leave the floor high once it stopped.
          s.floor = s.floor * (1 - c.adapt) + rms * c.adapt;
          retune();
          return null;
        }
        s.loudMs += ms;
        if (s.loudMs < (interrupting ? c.interruptMs : c.startMs)) return null;
        s.phase = "speech";
        s.utterMs = s.voicedMs = s.loudMs;
        s.loudMs = s.quietMs = 0;
        return interrupting ? "interrupt" : "start";
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
      s.blackoutMs = 0;
      if (recalibrate) {
        s.phase = "calibrate";
        s.calMs = s.calSum = s.calN = 0;
      } else if (s.phase !== "calibrate") {
        s.phase = "idle";
      }
    }

    // Changing the gate throws away the run of loud windows collected under
    // the old one: evidence gathered against one bar does not clear another.
    function setGate(name) {
      if (s.gate === name) return;
      s.gate = name;
      s.loudMs = 0;
      if (name === "normal") s.blackoutMs = 0;
    }

    function blackout(ms) {
      if (ms > s.blackoutMs) s.blackoutMs = ms;
    }

    return { state: s, push: push, reset: reset,
             setGate: setGate, blackout: blackout };
  }

  var CONV_LABELS = {
    calibrating: "listening to the room",
    listening:   "conversation - listening",
    hearing:     "hearing you",
    thinking:    "thinking",
    speaking:    "speaking"
  };
  // While barge-in is armed the two busy phases are not deaf, and the label
  // says so - it is the only visible difference between the two duplex modes.
  var BARGE_LABELS = {
    thinking: "thinking - talk over it",
    speaking: "speaking - talk over it"
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
    armed: false,           // barge-in: listening, but only for an interruption
    sealed: false,          // an utterance was just sent: ignore the rest of
                            //   the frame it happened in
    bargeIn: localStorage.getItem("va.bargein") !== "0",
    aec: null,              // what the browser said about echo cancellation
    settings: null,         // ...and the rest of what it granted, for the tip
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
    conv.sealed = false;
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
      // The event ended the turn: the rest of this frame belongs to whatever
      // comes next, not to the utterance that has just been sent.
      if (!conv.on || conv.suspended || conv.sealed) return;
    }
  }

  function onVadEvent(ev) {
    if (!ev) return;
    if (ev === "calibrated") {
      convPhase("listening");
    } else if (ev === "start" || ev === "interrupt") {
      // Cutting the assistant off has to happen before this becomes a normal
      // capture, so the audio it is still playing does not land in the
      // recording of the sentence that stopped it.
      if (ev === "interrupt") interruptTurn();
      // The ring holds the run-up, including the syllable that triggered us.
      conv.utter = conv.ring;
      conv.utterN = conv.ringN;
      conv.ring = []; conv.ringN = 0;
      conv.capturing = true;
      convPhase("hearing");
    } else if (ev === "end") {
      var chunks = conv.utter, total = conv.utterN, rate = conv.rate;
      resetCapture();
      conv.sealed = true;
      holdListening();
      convPhase("thinking");
      send_(toBase64(encodeWav(chunks, total, rate)), null, total / rate, true);
    } else if (ev === "tooshort") {
      resetCapture();
      convPhase(conv.armed ? conv.phase : "listening");
    }
  }

  /* True when the assistant may be talked over: the user wants it, and the
   * browser gave us an echo canceller to make it survivable. */
  function bargeInLive() {
    return conv.on && conv.bargeIn && conv.aec !== false;
  }

  /* The assistant has the floor. Either we go deaf until it is finished
   * (half duplex) or we keep listening under the stricter gate (barge-in). */
  function holdListening() {
    if (bargeInLive()) armInterrupt(); else suspendListening();
  }

  function suspendListening() {
    clearTimeout(resumeTimer);
    conv.suspended = true;
    conv.armed = false;
    resetCapture();
    conv.winSum = 0; conv.winN = 0;
    if (conv.vad) conv.vad.reset(false);
  }

  function armInterrupt() {
    clearTimeout(resumeTimer);
    conv.suspended = false;
    conv.armed = true;
    resetCapture();
    conv.winSum = 0; conv.winN = 0;
    if (conv.vad) {
      conv.vad.reset(false);
      conv.vad.setGate("interrupt");
    }
  }

  function resumeListening() {
    if (!conv.on) return;
    // Coming back from barge-in the ring is worth keeping: someone who starts
    // talking as the last sentence dies should not lose their first syllable
    // to a buffer being cleared behind them.
    var keepRing = conv.armed && !conv.suspended && !conv.capturing;
    conv.suspended = false;
    conv.armed = false;
    if (!keepRing) {
      resetCapture();
      conv.winSum = 0; conv.winN = 0;
    }
    if (conv.vad) {
      conv.vad.setGate("normal");
      if (!keepRing) conv.vad.reset(false);
    }
    convPhase(conv.vad && conv.vad.state.phase === "calibrate"
              ? "calibrating" : "listening");
  }

  /* Called from everywhere a turn can end - the stream finishing, the last
   * sentence playing out, muting, clearing. Listening only comes back when the
   * assistant has both stopped writing and stopped talking. */
  function maybeResumeListening() {
    if (!conv.on || (!conv.suspended && !conv.armed)) return;
    if (conv.capturing) return;      // mid barge-in: that is the next turn
    if (state.busy || playing || playQueue.length) return;
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(function () {
      if (conv.on && (conv.suspended || conv.armed) && !conv.capturing &&
          !state.busy && !playing && !playQueue.length) {
        resumeListening();
      }
    }, VAD.resumeDelayMs);
  }

  /* A confirmed interruption: stop the mouth, stop the stream, tell the server
   * to stop generating, and mark what is already on screen as cut off. The
   * speech that caused all this is already being captured by the caller and
   * becomes the next turn on its own. */
  function interruptTurn() {
    var mine = active;
    clearTimeout(resumeTimer);
    conv.armed = false;
    conv.suspended = false;
    if (conv.vad) conv.vad.setGate("normal");
    stopPlayback();
    if (!mine || mine.interrupted) return;
    mine.interrupted = true;
    markInterrupted(mine);
    if (mine.controller) { try { mine.controller.abort(); } catch (e) {} }
    // Aborting the fetch only closes our end. The server is still pulling
    // tokens out of the language model and pushing sentences at the speech
    // server; this is what stops that, and truncates the stored reply to what
    // was actually said so the next turn's history stays honest.
    fetch("/api/interrupt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sessionId, turnId: mine.id })
    }).catch(function () { /* the turn is dead either way */ });
    if (mine.finish) mine.finish();
  }

  function markInterrupted(t) {
    t.reply.wrap.classList.add("interrupted");
    // An em dash where the sentence was cut: the same mark the server puts in
    // the history, so the page and the model agree about what was said.
    if (t.text && t.text.nodeValue) t.text.nodeValue += "\u2014";
    else if (!t.reply.bubble.textContent) t.reply.bubble.textContent = "\u2014";
    var tag = document.createElement("span");
    tag.className = "cut-tag";
    tag.textContent = "interrupted";
    t.reply.bubble.appendChild(tag);
  }

  function enterConversation() {
    if (conv.on) return;
    if (state.recording) stopRecording(false);
    conv.on = true;
    conv.vad = makeVad(VAD);
    resetCapture();
    conv.suspended = false;
    conv.armed = false;
    conv.sealed = false;
    conv.winSum = 0; conv.winN = 0;
    convPhase("calibrating");
    paintMic();
    paintBarge();

    openCapture(convFrame).then(function (handle) {
      if (!conv.on) { handle.close(); return; }
      conv.handle = handle;
      conv.rate = handle.rate;
      conv.settings = handle.settings || {};
      // Asking for echo cancellation and being given it are different things,
      // and barge-in only works if we were given it: without it the microphone
      // hears the speakers and the assistant interrupts itself.
      conv.aec = conv.settings.echoCancellation === undefined
        ? null : !!conv.settings.echoCancellation;
      if (window.console && console.info) {
        console.info("[voice] microphone granted:", JSON.stringify(conv.settings));
      }
      paintBarge();
      drawMeter();
      // Entered mid-reply: hold the floor until it has finished speaking.
      if (state.busy || playing || playQueue.length) {
        holdListening();
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
    conv.armed = false;
    conv.aec = null;
    conv.settings = null;
    clearTimeout(resumeTimer);
    if (conv.handle) conv.handle.close();
    conv.handle = null;
    conv.vad = null;
    resetCapture();
    conv.winSum = 0; conv.winN = 0;
    convPhase("off");
    paintMic();
    paintBarge();
  }

  function toggleConversation() {
    if (conv.on) exitConversation(); else enterConversation();
    // Remembered, but never acted on at load: the mic must cost one click.
    localStorage.setItem("va.conversation", conv.on ? "1" : "0");
    el.conv.classList.remove("remembered");
  }

  /* ---- the barge-in sub-toggle
   *
   * Only meaningful while conversation mode is on, so it only appears then.
   * The preference survives a reload; conversation mode itself still does not. */
  function toggleBargeIn() {
    if (!conv.on || conv.aec === false) return;
    conv.bargeIn = !conv.bargeIn;
    localStorage.setItem("va.bargein", conv.bargeIn ? "1" : "0");
    // Switching sides mid-reply should take effect on this reply, not the next.
    if (state.busy || playing || playQueue.length) holdListening();
    else if (conv.vad) conv.vad.setGate("normal");
    paintBarge();
  }

  function aecWord() {
    if (conv.aec === true) return "on";
    if (conv.aec === false) return "off";
    return "not reported";
  }

  function paintBarge() {
    if (!el.barge) return;
    var live = bargeInLive();
    el.barge.hidden = !conv.on;
    el.barge.disabled = conv.aec === false;
    el.barge.classList.toggle("active", live);
    el.barge.setAttribute("aria-pressed", live ? "true" : "false");
    if (!conv.on) {
      el.barge.title = "Barge-in: talk over the reply and it stops";
    } else if (conv.aec === false) {
      el.barge.title =
        "Barge-in is unavailable: this browser gave the page a microphone with " +
        "no echo cancellation, so it would hear itself and interrupt its own " +
        "reply. Half duplex instead - it waits its turn.";
    } else {
      el.barge.title =
        (live ? "Barge-in on: talk over the reply and it stops mid-sentence."
              : "Barge-in off: half duplex, it stops listening while it talks.") +
        " Echo cancellation: " + aecWord() +
        (conv.settings && conv.settings.noiseSuppression !== undefined
          ? ", noise suppression: " + (conv.settings.noiseSuppression ? "on" : "off")
          : "") +
        (conv.settings && conv.settings.autoGainControl !== undefined
          ? ", auto gain: " + (conv.settings.autoGainControl ? "on" : "off")
          : "") + ".";
    }
  }

  function paintConv() {
    el.conv.classList.toggle("active", conv.on);
    el.conv.classList.toggle("hearing", conv.on && conv.phase === "hearing");
    el.conv.setAttribute("aria-pressed", conv.on ? "true" : "false");
    el.conv.title = conv.on
      ? "Hands-free: " + (CONV_LABELS[conv.phase] || "on") + " (Esc to stop)"
      : "Hands-free: it listens, you just talk";
    paintBarge();
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
        // Phase first, level second: with barge-in the microphone is live during
        // "speaking" too, and it would be a lie to paint that in the colour
        // that means "your turn".
        if (conv.phase === "hearing") {
          grad.addColorStop(0, "rgba(53,214,196,0.95)");
          grad.addColorStop(0.5, "rgba(139,123,255,0.95)");
          grad.addColorStop(1, "rgba(53,214,196,0.95)");
        } else if (conv.phase === "speaking") {
          grad.addColorStop(0, "rgba(139,123,255,0.60)");
          grad.addColorStop(1, "rgba(139,123,255,0.28)");
        } else if (conv.phase === "thinking") {
          grad.addColorStop(0, "rgba(139,123,255,0.26)");
          grad.addColorStop(1, "rgba(53,214,196,0.26)");
        } else if (live) {                          // listening / calibrating
          grad.addColorStop(0, "rgba(53,214,196,0.55)");
          grad.addColorStop(1, "rgba(74,222,128,0.55)");
        } else {
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

    // Whatever started this turn, the assistant now has the floor. The spoken
    // path has already taken it; a question typed while conversation mode is
    // on had not, which left the microphone listening at full speech
    // sensitivity while the speakers answered it.
    if (conv.on && !conv.suspended && !conv.armed) {
      holdListening();
      convPhase("thinking");
    }

    var userTurn = addTurn("user");
    var spokenLabel = spoken ? "Spoken" : "Voice message";
    if (audioB64) {
      userTurn.bubble.appendChild(voiceTag(seconds || 0, spokenLabel));
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
    var doneAt = 0;
    var spoke = false;

    // The turn gets an id the server also knows, so /api/interrupt can name
    // exactly which one to stop, and an AbortController so the browser can
    // drop the stream without waiting for the server to notice.
    var mine = {
      id: randomId(),
      controller: window.AbortController ? new AbortController() : null,
      reply: reply,
      text: textNode,
      interrupted: false,
      finish: null
    };
    active = mine;

    var init = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sessionId, turnId: mine.id,
                             audio: audioB64, text: text })
    };
    if (mine.controller) init.signal = mine.controller.signal;

    fetch("/api/chat", init).then(function (resp) {
      if (!resp.ok || !resp.body) {
        return resp.text().then(function (t) { throw new Error(t || ("HTTP " + resp.status)); });
      }
      return readEvents(resp.body, onEvent);
    }).catch(function (err) {
      // An interrupted turn ends by being aborted; that is the plan working,
      // not a failure, and it has already been marked on screen.
      if (mine.interrupted || (err && err.name === "AbortError")) return;
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
      // Events already in the buffer when the turn was cut off: the reply is
      // over, and none of it may reach the screen or the speakers.
      if (mine.interrupted) return;
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
        // The turn is over as far as the user is concerned - but the stream is
        // not: a spoken turn may still have its words to come, so nothing here
        // closes the reader.
        doneAt = Date.now();
        finish();
        if (ev.text) textNode.nodeValue = ev.text;
        stampMeta(reply.meta, ev.firstTokenMs, ev.firstAudioMs, ev.totalMs);
        if (!ev.text) reply.bubble.textContent = "(no reply)";
      } else if (ev.type === "transcript") {
        // Addressed by id rather than by "the turn on screen": in conversation
        // mode this can land several exchanges later, with two more bubbles
        // under it. The closure already holds the right one - the id is what
        // proves it.
        if (ev.turnId && ev.turnId !== mine.id) return;
        morphSpokenBubble(userTurn, seconds, ev.text, spokenLabel);
        transcripts.push({ turnId: mine.id, text: ev.text,
                           afterDoneMs: doneAt ? Date.now() - doneAt : null });
      }
    }

    mine.finish = finish;

    function finish() {
      if (caret.parentNode) caret.remove();
      if (thinking.parentNode) thinking.remove();
      if (active === mine) active = null;
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
      var label = (conv.armed && BARGE_LABELS[conv.phase]) ||
                  CONV_LABELS[conv.phase] || "conversation";
      setMeterLabel(label, conv.phase === "hearing");
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
  if (el.barge) el.barge.addEventListener("click", toggleBargeIn);

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
  paintBarge();
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
    transcripts: transcripts,
    conversation: function () {
      return {
        on: conv.on,
        phase: conv.phase,
        suspended: conv.suspended,
        armed: conv.armed,
        capturing: conv.capturing,
        bargeIn: conv.bargeIn,
        bargeLive: bargeInLive(),
        aec: conv.aec,
        settings: conv.settings,
        busy: state.busy,
        playing: playing,
        queued: playQueue.length,
        turnId: active ? active.id : null,
        vad: conv.vad ? {
          phase: conv.vad.state.phase,
          gate: conv.vad.state.gate,
          blackoutMs: conv.vad.state.blackoutMs,
          floor: conv.vad.state.floor,
          threshold: conv.vad.state.threshold,
          interruptThreshold: conv.vad.state.interruptThreshold
        } : null
      };
    },
    // Half-duplex is what happens when the browser refuses echo cancellation;
    // no fake microphone can refuse it, so the tests say so out loud instead.
    forceAec: function (value) {
      conv.aec = value;
      paintBarge();
    },
    setBargeIn: function (value) {
      if (conv.bargeIn !== !!value) toggleBargeIn();
      return conv.bargeIn;
    }
  };
})();
