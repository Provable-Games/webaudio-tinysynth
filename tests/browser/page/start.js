/* global window, document, WebAudioTinySynth */
/*
 * T4 start page script (#12, D-011), inlined after the library on a page built
 * with the lifecycle instrumentation and served over http://127.0.0.1, so the
 * default autoplay policy applies. Like page/gesture.js, nothing here is
 * triggered by page.evaluate: the synth is built at load, state is reported
 * from page-side timers through console.log ("T4STATE {...}"), and audio is
 * started only by a real click or key press.
 *
 * window.__T4_START__ = {variant, midi (base64)}:
 *   lazy-click     new WebAudioTinySynth({lazy: true}); click: resume(), then loadMIDI() and playMIDI()
 *   lazy-key       the same from a key press
 *   inject-click   the page's own AudioContext passed as `context`, song loaded at load; click: resume(), then playMIDI()
 *   readme-click   default construction, song loaded at load; click: playMIDI() only (the README pattern)
 *   closed-click   an injected context the page closes at load; click: resume() must reject AUDIO_CONTEXT_CLOSED
 *   timer-resume   default construction; resume() from a timer 200 ms after load, with no gesture
 */
(function () {
  "use strict";
  var cfg = window.__T4_START__;
  var L = window.__t6.lifecycle;
  var bin = atob(cfg.midi);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; ++i) bytes[i] = bin.charCodeAt(i);
  var events = [];
  var own = null;
  var synth;
  if (cfg.variant === "lazy-click" || cfg.variant === "lazy-key") {
    synth = new WebAudioTinySynth({ quality: 1, lazy: true });
  } else if (cfg.variant === "inject-click" || cfg.variant === "closed-click") {
    own = new window.AudioContext();
    synth = new WebAudioTinySynth({ quality: 1, context: own });
    if (cfg.variant === "closed-click") own.close().then(function () { events.push("page closed its context"); });
    else synth.loadMIDI(bytes.buffer);
  } else {
    synth = new WebAudioTinySynth({ quality: 1 });
    synth.loadMIDI(bytes.buffer);
  }
  var t0 = performance.now();
  function log(tag) {
    var ctx = synth.getAudioContext();
    var st = synth.getPlayStatus();
    var ua = navigator.userActivation;
    var edges = L.edges();
    window.console.log("T4STATE " + JSON.stringify({
      tag: tag, ms: Math.round(performance.now() - t0), contexts: L.contexts().length,
      state: ctx ? ctx.state : null, currentTime: ctx ? ctx.currentTime : null,
      play: st.play, curTick: st.curTick, hasBeenActive: ua ? ua.hasBeenActive : null,
      toDestination: edges.filter(function (k) { return k.indexOf(">c0.destination:") > 0; }).length,
      events: events.slice(), rejections: window.__t6.rejections.length,
    }));
  }
  function resume(then) {
    synth.resume().then(function () {
      events.push("resume resolved");
      if (then) then();
    }, function (e) { events.push("resume rejected: " + (e.code || e.name)); });
  }
  function start(how) {
    events.push(how);
    if (cfg.variant === "lazy-click" || cfg.variant === "lazy-key") resume(function () { synth.loadMIDI(bytes.buffer); synth.playMIDI(); });
    else if (cfg.variant === "inject-click" || cfg.variant === "closed-click") resume(function () { synth.playMIDI(); });
    else if (cfg.variant === "readme-click") synth.playMIDI();
    log("gesture");
  }
  var button = document.getElementById("start");
  if (cfg.variant === "lazy-key") document.addEventListener("keydown", function () { start("keydown"); });
  else button.addEventListener("click", function () { start("click"); });
  if (cfg.variant === "timer-resume") window.setTimeout(function () { events.push("timer resume()"); resume(); }, 200);
  log("load");
  window.setInterval(function () { log("tick"); }, 100);
})();
