/* global window */
/*
 * Test-page prelude, inlined before the library by tests/browser/lib/pages.js.
 *
 * 1. Seeded Math.random. TEST INFRASTRUCTURE ONLY: it lets same-engine renders
 *    be compared sample for sample. It is not runtime policy; #7/D-004 give the
 *    library its own seeded generator (T8), with no Math.random override.
 *    The stream is mulberry32; window.__t6.seed(n) restarts it, and
 *    window.__t6.randomCalls counts the values drawn since the last restart.
 * 2. Interval timers are recorded (window.__t6.intervals: {id, ms, active}).
 *    setInterval and clearInterval keep their behavior and return values.
 *    Offline renders use this to stop the library's 60 ms scheduler, which
 *    otherwise keeps running against an installed OfflineAudioContext and
 *    prunes voices at render positions that depend on wall-clock timing
 *    (see render.js). The handle is not exposed by the library (#11).
 * 3. Unhandled promise rejections are recorded in window.__t6.rejections, with
 *    preventDefault() so the matrix runner classifies each one itself instead
 *    of failing on a console message. Errors are not intercepted: they still
 *    reach the runner as page errors.
 *
 * window.__T6_SEED__ (set by the page builder) is the initial seed.
 */
(function () {
  "use strict";
  var state = 0;
  var t6 = window.__t6 = window.__t6 || {};
  t6.randomCalls = 0;
  t6.seed = function (seed) {
    state = seed >>> 0;
    t6.randomCalls = 0;
    t6.currentSeed = seed >>> 0;
  };
  Math.random = function () {
    ++t6.randomCalls;
    state = (state + 0x6d2b79f5) | 0;
    var t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  t6.seed(Number(window.__T6_SEED__ || 1));

  var realSetInterval = window.setInterval, realClearInterval = window.clearInterval;
  t6.intervals = [];
  window.setInterval = function (fn, ms) {
    var id = realSetInterval.apply(window, arguments);
    t6.intervals.push({ id: id, ms: ms, active: true });
    return id;
  };
  window.clearInterval = function (id) {
    t6.intervals.forEach(function (r) { if (r.id === id) r.active = false; });
    return realClearInterval.apply(window, arguments);
  };

  t6.rejections = [];
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    t6.rejections.push({
      name: r && r.name ? String(r.name) : typeof r,
      message: r && r.message !== undefined ? String(r.message) : String(r),
    });
    e.preventDefault();
  });
})();
