/* global window, WebAudioTinySynth */
/*
 * URL-loading test page script (#14), inlined after the library and served
 * from the controlled server, so relative URLs reach its /midi/... routes.
 * window.__t6url exposes the synth's observable state; the runner drives it
 * with page.evaluate (no gesture is involved in URL loading).
 *
 * Completion signal: XMLHttpRequest open/send are wrapped (behavior and
 * return values unchanged) to record each request's "loadend". loadend is
 * dispatched after "load", whose handlers (the library's onload, which parses
 * and installs the song) have then returned, so a recorded loadend means the
 * library has finished with that response. The runner waits for it instead
 * of a fixed delay.
 */
(function () {
  "use strict";
  var done = [];
  var XHR = window.XMLHttpRequest.prototype;
  var realOpen = XHR.open, realSend = XHR.send;
  XHR.open = function (method, url) {
    this.__t6url = String(url);
    return realOpen.apply(this, arguments);
  };
  XHR.send = function () {
    var xhr = this;
    var outcome = "pending";
    ["load", "error", "abort", "timeout"].forEach(function (type) { xhr.addEventListener(type, function () { outcome = type; }); });
    xhr.addEventListener("loadend", function () { done.push({ url: xhr.__t6url, outcome: outcome, status: xhr.status }); });
    return realSend.apply(this, arguments);
  };
  var synth = new WebAudioTinySynth({ quality: 1 });
  function bytes(b64) {
    var bin = window.atob(b64);
    var u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; ++i) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }
  window.__t6url = {
    load: function (url) {
      var r = synth.loadMIDIUrl(url);
      return { returned: r === undefined ? "undefined" : typeof r === "object" && r && typeof r.then === "function" ? "promise" : typeof r };
    },
    loadBytes: function (b64) { synth.loadMIDI(bytes(b64)); return this.status(); },
    done: function (url) {
      for (var i = 0; i < done.length; ++i) if (done[i].url === url) return done[i];
      return null;
    },
    status: function () {
      var st = synth.getPlayStatus();
      return { maxTick: st.maxTick, play: st.play, events: synth.song ? synth.song.ev.length : null, rejections: window.__t6.rejections.slice() };
    },
  };
})();
