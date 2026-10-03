/* global window, document, WebAudioTinySynth */
/*
 * Gesture test page script (#12, D-011), inlined after the library. The page
 * is served over http://127.0.0.1 so the engine's default autoplay policy
 * applies. Nothing here may be triggered by the test runner's page.evaluate,
 * which would itself count as user activation: the synth is built at load,
 * state is reported from page-side timers through console.log, and audio is
 * started only by a real click or key press handled below.
 *
 * window.__T6_GESTURE__ = {variant, midi (base64)} selects the start path:
 *   resume        click: synth.getAudioContext().resume(), then playMIDI()
 *   key-resume    keydown: the same
 *   play          click: playMIDI() only (the README pattern)
 *   send          click: send([0x90, 60, 100]) only (the library's internal resume())
 *   timer-play    no gesture: playMIDI() from a timer 200 ms after load
 */
(function () {
  "use strict";
  var cfg = window.__T6_GESTURE__;
  var synth = new WebAudioTinySynth({ quality: 1 });
  var bin = atob(cfg.midi);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; ++i) bytes[i] = bin.charCodeAt(i);
  synth.loadMIDI(bytes.buffer);
  var events = [];
  var t0 = performance.now();
  function log(tag) {
    var ctx = synth.getAudioContext();
    var st = synth.getPlayStatus();
    var ua = navigator.userActivation;
    window.console.log("T6STATE " + JSON.stringify({
      tag: tag, ms: Math.round(performance.now() - t0), state: ctx.state, currentTime: ctx.currentTime,
      play: st.play, curTick: st.curTick, hasBeenActive: ua ? ua.hasBeenActive : null, isActive: ua ? ua.isActive : null,
      events: events.slice(), rejections: window.__t6.rejections.length,
    }));
  }
  function start(how) {
    events.push(how);
    if (cfg.variant === "resume" || cfg.variant === "key-resume") {
      synth.getAudioContext().resume().then(function () { events.push("resume resolved"); }, function (e) { events.push("resume rejected: " + e.name); });
      synth.playMIDI();
    } else if (cfg.variant === "play") {
      synth.playMIDI();
    } else if (cfg.variant === "send") {
      synth.send([0x90, 60, 100]);
    }
    log("gesture");
  }
  var button = document.getElementById("start");
  if (cfg.variant === "key-resume") document.addEventListener("keydown", function () { start("keydown"); });
  else button.addEventListener("click", function () { start("click"); });
  if (cfg.variant === "timer-play") window.setTimeout(function () { events.push("timer playMIDI"); synth.playMIDI(); }, 200);
  log("load");
  window.setInterval(function () { log("tick"); }, 100);
})();
