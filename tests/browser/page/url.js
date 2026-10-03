/* global window, WebAudioTinySynth */
/*
 * URL-loading test page script (#14), inlined after the library and served
 * from the controlled server, so relative URLs reach its /midi/... routes.
 * window.__t6url exposes the synth's observable state; the runner drives it
 * with page.evaluate (no gesture is involved in URL loading).
 *
 * Completion signal: page/xhr.js (inlined before this script) records each
 * request's loadend; the runner waits for it instead of a fixed delay.
 */
(function () {
  "use strict";
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
    done: function (url) { return window.__t6.xhr.done(url); },
    status: function () {
      var st = synth.getPlayStatus();
      return { maxTick: st.maxTick, play: st.play, events: synth.song ? synth.song.ev.length : null, rejections: window.__t6.rejections.slice() };
    },
  };
})();
