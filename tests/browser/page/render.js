/* global window, OfflineAudioContext, WebAudioTinySynth */
/*
 * Offline render helper, inlined after the library by tests/browser/lib/pages.js.
 *
 * window.__t6.render(spec) constructs a synth, installs an OfflineAudioContext
 * with setAudioContext(), schedules every note and controller with an explicit
 * time, renders, and returns the PCM and some data about the run.
 *
 * Test control: the intervals the constructor started (its 60 ms scheduler)
 * are cleared before rendering, unless spec.keepScheduler is set. The
 * scheduler cannot play a song offline, but it still runs while the offline
 * context renders and prunes released voices whenever the context's
 * currentTime has passed their end, so the render position of each cut
 * depends on wall-clock timing and repeated renders differ (baseline finding,
 * #11/#12; the variation spec records it). spec:
 *   seed        Math.random seed (prelude.js); restarted before construction
 *               and again before setAudioContext(), so the generated buffers
 *               depend only on (seed, sr) and not on the realtime context.
 *   sr, duration, channels (default 2)
 *   options     constructor options, e.g. {quality: 0, useReverb: 0}
 *   masterVol, reverbLev   optional setters, applied after the install
 *   timbres     [[m, n, timbre], ...] passed to setTimbre (copied first)
 *   steps       [{t, send: [bytes]} | {call: "noteOn", args: [...]}, ...]
 *   pcm         true to return both channels as base64 Float32 data, "L" for the left one only
 *   slots       [[start, end], ...] seconds; per-slot summaries computed here
 *   threshold   magnitude threshold for the slot first/last sample indices
 *   keepScheduler  leave the library's interval running during the render
 */
(function () {
  "use strict";
  var t6 = window.__t6;

  function b64(f32) {
    var u8 = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
    var s = "";
    for (var i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }

  /* cyrb53-style 53-bit hash of Float32 data, as a hex string. */
  function hash(arrays) {
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var a = 0; a < arrays.length; ++a) {
      var f = arrays[a];
      var u = new Uint32Array(f.buffer, f.byteOffset, f.length);
      for (var i = 0; i < u.length; ++i) {
        h1 = Math.imul(h1 ^ u[i], 2654435761);
        h2 = Math.imul(h2 ^ u[i], 1597334677);
      }
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
  }

  function summarize(chs, sr, start, end, threshold) {
    var a = Math.max(0, Math.round(start * sr)), b = Math.min(chs[0].length, Math.round(end * sr));
    var s = 0, p = 0, nan = 0, inf = 0, first = -1, last = -1;
    for (var c = 0; c < chs.length; ++c) {
      var x = chs[c];
      for (var i = a; i < b; ++i) {
        var v = x[i];
        if (v !== v) { ++nan; continue; }
        if (v === Infinity || v === -Infinity) { ++inf; continue; }
        s += v * v;
        var m = v < 0 ? -v : v;
        if (m > p) p = m;
        if (m > threshold) {
          if (first < 0 || i - a < first) first = i - a;
          if (i - a > last) last = i - a;
        }
      }
    }
    return { rms: Math.sqrt(s / Math.max(1, (b - a) * chs.length)), peak: p, nan: nan, inf: inf,
      first: first < 0 ? null : first / sr, last: last < 0 ? null : last / sr };
  }

  /* Hashes of the generated buffers (#7). These are internal properties; absent ones are reported as null. */
  function bufferHashes(synth) {
    function h(buf) {
      if (!buf || !buf.getChannelData) return null;
      var chs = [];
      for (var c = 0; c < buf.numberOfChannels; ++c) chs.push(buf.getChannelData(c));
      return hash(chs);
    }
    return {
      convBuf: h(synth.convBuf),
      n0: synth.noiseBuf ? h(synth.noiseBuf.n0) : null,
      n1: synth.noiseBuf ? h(synth.noiseBuf.n1) : null,
    };
  }

  t6.render = function (spec) {
    var nch = spec.channels || 2;
    t6.seed(spec.seed);
    var rejectionsBefore = t6.rejections.length;
    var intervalsBefore = t6.intervals.length;
    var synth = new WebAudioTinySynth(spec.options || {});
    var schedulers = t6.intervals.slice(intervalsBefore).filter(function (r) { return r.active; });
    if (!spec.keepScheduler) schedulers.forEach(function (r) { window.clearInterval(r.id); });
    var internal = synth.getAudioContext();
    var off = new OfflineAudioContext(nch, Math.round(spec.duration * spec.sr), spec.sr);
    t6.seed(spec.seed);
    synth.setAudioContext(off);
    var randomCalls = t6.randomCalls;
    var buffers = bufferHashes(synth);
    var closing = internal && internal.close ? internal.close().catch(function () {}) : null;
    if (spec.masterVol !== undefined) synth.setMasterVol(spec.masterVol);
    if (spec.reverbLev !== undefined) synth.setReverbLev(spec.reverbLev);
    (spec.timbres || []).forEach(function (tb) {
      synth.setTimbre(tb[0], tb[1], JSON.parse(JSON.stringify(tb[2])));
    });
    (spec.steps || []).forEach(function (s) {
      if (s.send) synth.send(s.send, s.t);
      else synth[s.call].apply(null, s.args);
    });
    return off.startRendering().then(function (buf) {
      return Promise.resolve(closing).then(function () {
        // Let rejection events from the library's resume() calls be delivered first.
        return new Promise(function (r) { setTimeout(r, 50); });
      }).then(function () {
        var chs = [];
        for (var c = 0; c < buf.numberOfChannels; ++c) chs.push(buf.getChannelData(c));
        return {
          sr: buf.sampleRate,
          length: buf.length,
          randomCalls: randomCalls,
          schedulerIntervals: schedulers.map(function (r) { return r.ms; }),
          schedulerStopped: !spec.keepScheduler,
          buffers: buffers,
          hash: hash(chs),
          rejections: t6.rejections.slice(rejectionsBefore),
          pcm: spec.pcm === "L" ? [b64(chs[0])] : spec.pcm ? chs.map(b64) : null,
          slots: (spec.slots || []).map(function (s) { return summarize(chs, buf.sampleRate, s[0], s[1], spec.threshold || 1e-4); }),
          whole: summarize(chs, buf.sampleRate, 0, buf.length / buf.sampleRate, spec.threshold || 1e-4),
        };
      });
    });
  };
})();
