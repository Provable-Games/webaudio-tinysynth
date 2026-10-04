/*
 * T5 (#14): the loadMIDIUrl() promise contract against the controlled server
 * (scripts/browser-server.js), in real XMLHttpRequest implementations.
 *
 * Asserted per build: success resolves with the response bytes after one GET;
 * statuses outside 200-299 reject HTTP_STATUS (a redirect is followed); an
 * empty, non-MIDI or truncated body rejects with loadMIDI()'s code; a reset or
 * refused connection rejects NETWORK_ERROR; opts.signal aborts the request;
 * an already aborted signal sends nothing; an abort with a falsy reason
 * (abort(0)) still rejects with an AbortError; a newer URL or a direct loadMIDI()
 * wins a race; dispose() during a load settles it and installs nothing; every
 * failure keeps the last valid song; and fire-and-forget calls cause no
 * unhandled rejection, while a control rejection made on purpose is seen.
 *
 * The page script below is inlined after page/xhr.js, which records each
 * request's loadend (the library's onload has returned by then).
 *
 * "api-url guard" (T5.2, #13 follow-up) asserts per build, on an
 * OfflineAudioContext whose create* methods are counted:
 *   - setTimbre rejects a, h, d, r and q that are not finite as float32
 *     (RangeError) and installs nothing;
 *   - a note whose AudioParam values overflow float32 (an FM chain, FM depth,
 *     a large k, 0 times an overflow, a pitch envelope, a sustain level, AM, a
 *     noise operator's rate) does not throw, creates no node and takes no
 *     voice, and a valid note afterwards plays;
 *   - with tsmode 1, performance.now() times from before the context's time 0
 *     (negative once converted) play at once and do not throw;
 *   - the render is finite and audible;
 *   - an empty array-like SysEx creates no lazy context, and loadMIDIUrl()
 *     with a throwing opts.signal getter returns a promise that rejects with
 *     that error and sends nothing.
 * It also records, as observations, which out-of-range WebAudio calls the
 * engine itself rejects (why the guard matters per engine).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const pages = require("../lib/pages");
const smf = require("../lib/smf");
const { refusedOrigin } = require("../../../scripts/browser-server");

/* eslint-disable no-undef -- runs in the page */
function pageScript() {
  var synth = new WebAudioTinySynth({ quality: 1 });
  var loads = [];
  window.__t5 = {
    bytes: function (b64) {
      var bin = window.atob(b64), u = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; ++i) u[i] = bin.charCodeAt(i);
      return u.buffer;
    },
    // Start a load; the outcome is read with outcome(id). abort: "later" (abort(id)) or "before".
    load: function (url, abort) {
      var ac = abort ? new AbortController() : null, rec = { state: "pending", ac: ac };
      if (abort === "before") ac.abort();
      var p = synth.loadMIDIUrl(url, ac ? { signal: ac.signal } : undefined);
      rec.isPromise = !!p && typeof p.then === "function";
      p.then(function (v) {
        rec.state = "resolved"; rec.byteLength = v.byteLength;
      }, function (e) {
        rec.state = "rejected"; rec.name = e && e.name; rec.code = e && typeof e.code === "string" ? e.code : null; rec.status = e && e.status;
      });
      loads.push(rec);
      return loads.length - 1;
    },
    abort: function (id) { loads[id].ac.abort(); },
    abortWith: function (id, reason) { loads[id].ac.abort(reason); },
    outcome: function (id) {
      var r = loads[id];
      return { state: r.state, isPromise: r.isPromise, byteLength: r.byteLength, name: r.name, code: r.code, status: r.status };
    },
    loadBytes: function (b64) { synth.loadMIDI(this.bytes(b64)); return this.status(); },
    forget: function (url) { synth.loadMIDIUrl(url); }, // fire and forget: nothing handles the result
    dispose: function () { synth.dispose(); },
    control: function () { Promise.reject(new Error("control")); },
    done: function (url) { return window.__t6.xhr.done(url); },
    status: function () {
      var st = synth.getPlayStatus();
      return { maxTick: st.maxTick, events: synth.song ? synth.song.ev.length : null, rejections: window.__t6.rejections.slice() };
    },
  };
}
/* eslint-enable no-undef */

/* eslint-disable no-undef -- runs in the page (T5.2) */
const GUARD = async (url) => {
  const err = (fn) => { try { fn(); return null; } catch (e) { return e.name + ": " + e.message; } };
  const out = {};
  // What the engine itself rejects (observed, not asserted).
  {
    const c = new OfflineAudioContext(1, 128, 44100), g = c.createGain().gain, o = c.createOscillator();
    out.engine = {
      "frequency.value = 1e39": err(() => { o.frequency.value = 1e39; }),
      "setValueAtTime(NaN, 0)": err(() => g.setValueAtTime(NaN, 0)),
      "setValueAtTime(0, -1)": err(() => g.setValueAtTime(0, -1)),
      "setTargetAtTime(0, 0, 1e39)": err(() => g.setTargetAtTime(0, 0, 1e39)),
      "start(-1)": err(() => o.start(-1)),
    };
  }
  const ctx = new OfflineAudioContext(1, 44100, 44100);
  const made = { n: 0 };
  for (const m of ["createOscillator", "createBufferSource", "createGain", "createBiquadFilter"]) {
    const f = ctx[m].bind(ctx);
    ctx[m] = () => { ++made.n; return f(); };
  }
  const synth = new WebAudioTinySynth({ quality: 1, useReverb: 0, voices: 64, context: ctx });
  const before = JSON.stringify(synth.program[5].p);
  out.timbre = ["a", "h", "d", "r", "q"].map((k) => err(() => synth.setTimbre(0, 5, [{}, { g: 1, [k]: 1e39 }])));
  out.timbreKept = JSON.stringify(synth.program[5].p) === before;
  const T = [
    ["an FM chain", [{}, ...Array.from({ length: 10 }, (_, i) => ({ g: i + 1, t: 1e4, v: 1 }))], 60],
    ["FM depth", [{}, { g: 1, v: 1e37 }], 60],
    ["a large k", [{ k: 30 }], 127],
    ["0 times an overflow", [{ v: 0, k: 1000 }], 127],
    ["the pitch envelope", [{ p: 1e37 }], 60],
    ["the sustain level", [{ v: 1, s: 1e39 }], 60],
    ["AM", [{}, { g: 11, v: 1e39 }], 60],
    ["a noise operator's rate", [{ w: "n0", t: 1e39 }], 60],
  ];
  out.notes = T.map(([label, timbre, note], i) => {
    synth.setTimbre(0, 10 + i, timbre);
    synth.setProgram(i, 10 + i);
    const n = made.n, v = synth.notetab.length;
    const error = err(() => synth.noteOn(i, note, 100, 0.1));
    return { label, error, made: made.n - n, voices: synth.notetab.length - v };
  });
  synth.setProgram(0, 0);
  let n = made.n;
  out.valid = err(() => { synth.noteOn(0, 69, 100, 0.2); synth.noteOff(0, 69, 0.5); });
  out.validMade = made.n - n;
  // performance.now() times 1 and 2 ms after the page's time origin, before this context's time 0 (it was made
  // later): negative once converted.
  synth.setTsMode(1);
  n = made.n;
  out.ts = err(() => {
    synth.noteOn(1, 72, 100, 1);
    synth.setChVol(1, 110, 1);
    synth.setBend(1, 9000, 1);
    synth.noteOff(1, 72, 2);
    synth.noteOn(9, 38, 100, 1);
  });
  out.tsMade = made.n - n;
  synth.setTsMode(0);
  const d = (await ctx.startRendering()).getChannelData(0);
  let peak = 0, finite = true;
  for (let i = 0; i < d.length; ++i) {
    if (!Number.isFinite(d[i])) finite = false;
    else peak = Math.max(peak, Math.abs(d[i]));
  }
  out.render = { finite, peak };
  await synth.dispose();
  const lazy = new WebAudioTinySynth({ lazy: true });
  out.sysex = err(() => lazy.send({ 0: 0xf0, length: 0 }));
  out.sysexNoContext = lazy.getAudioContext() === null;
  let p = null;
  out.urlThrow = err(() => { p = lazy.loadMIDIUrl(url, { get signal() { throw new Error("getter"); } }); });
  out.url = p && typeof p.then === "function" ? await p.then(() => "resolved", (e) => "rejected: " + e.message) : null;
  await lazy.dispose();
  out.rejections = window.__t6.rejections.slice();
  return out;
};
/* eslint-enable no-undef */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WAIT_MS = 15000;
async function until(fn, what) {
  for (const end = Date.now() + WAIT_MS; ;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
    await sleep(25);
  }
}

/* eslint-disable no-undef -- page.evaluate callbacks run in the page */
const ev = {
  load: (p, url, abort) => p.page.evaluate(([u, a]) => window.__t5.load(u, a), [url, abort || null]),
  outcome: (p, id) => p.page.evaluate((i) => window.__t5.outcome(i), id),
  abort: (p, id) => p.page.evaluate((i) => window.__t5.abort(i), id),
  abortWith: (p, id, reason) => p.page.evaluate(([i, r]) => window.__t5.abortWith(i, r), [id, reason]),
  bytes: (p, b64) => p.page.evaluate((b) => window.__t5.loadBytes(b), b64),
  status: (p) => p.page.evaluate(() => window.__t5.status()),
  done: (p, url) => p.page.evaluate((u) => window.__t5.done(u), url),
  forget: (p, url) => p.page.evaluate((u) => window.__t5.forget(u), url),
  dispose: (p) => p.page.evaluate(() => window.__t5.dispose()),
  control: (p) => p.page.evaluate(() => window.__t5.control()),
};
/* eslint-enable no-undef */

const settled = (p, id) => until(async () => { const o = await ev.outcome(p, id); return o.state !== "pending" && o; }, "load " + id + " to settle");
const loadend = (p, url) => until(() => ev.done(p, url), "the loadend of " + url);

// The "previous" song, installed directly before each scenario: one note, 960 ticks.
const PREVIOUS = smf.write({ format: 0, division: 480, tracks: [[{ dt: 0, bytes: [0x90, 60, 100] }, { dt: 960, bytes: [0x80, 60, 0] }]] });
const DIRECT = smf.write({ format: 0, division: 480, tracks: [[{ dt: 0, bytes: [0x90, 64, 100] }, { dt: 720, bytes: [0x80, 64, 0] }]] });

function cases(shared) {
  const { matrix, options, server } = shared;
  const file = (f) => fs.readFileSync(path.join(pages.ROOT, f));
  const WS = smf.read(file("ws.mid")).endTick, WS_BYTES = file("ws.mid").length;
  const GM = smf.read(file("test-midi/all-gm-sounds.mid")).endTick;
  const prevTicks = smf.read(PREVIOUS).endTick, directTicks = smf.read(DIRECT).endTick;
  return matrix.builds.map((build) => ({
    id: "api-url " + build,
    dims: { build },
    deadline: 180,
    run: async (t) => {
      const pageId = "api-url-" + build;
      server.registerPage(pageId, pages.inlinePage({
        library: pages.readLibrary(build, options.overrides), seed: options.seed,
        after: [pages.pageScript("xhr.js"), "(" + pageScript.toString() + ")();"],
      }));
      let n = 0;
      const tag = (route) => route + "?t5=" + build + "-" + (++n) + "-" + Date.now();
      const reached = (url) => server.requests.filter((r) => r.path === url);
      const open = async () => {
        const p = await t.newPage();
        await p.page.goto(server.origin + "/html/" + pageId);
        return p;
      };
      const fresh = async (p) => {
        const st = await ev.bytes(p, PREVIOUS.toString("base64"));
        t.check("previous song installed directly", st.maxTick === prevTicks, JSON.stringify(st));
        return st;
      };
      const kept = (label, before, after) => t.check(label + ": the previous song is kept", after.maxTick === before.maxTick && after.events === before.events,
        JSON.stringify([before, after]));

      const p = await open();

      // Success.
      {
        await fresh(p);
        const url = tag("/midi/ok/ws.mid");
        const id = await ev.load(p, url);
        const o = await settled(p, id);
        const st = await ev.status(p);
        t.check("200: returns a promise that resolves with the response bytes", o.isPromise && o.state === "resolved" && o.byteLength === WS_BYTES, JSON.stringify(o));
        t.check("200: the song is installed (ws.mid end tick " + WS + ")", st.maxTick === WS, "maxTick " + st.maxTick);
        t.check("200: exactly one GET", reached(url).length === 1 && reached(url)[0].status === 200, JSON.stringify(reached(url)));
      }
      // Status policy and malformed bodies: rejected, previous song kept.
      for (const [label, route, expect] of [
        ["404", "/midi/status/404/ws.mid", { code: "HTTP_STATUS", status: 404 }],
        ["500", "/midi/status/500/ws.mid", { code: "HTTP_STATUS", status: 500 }],
        ["204 (no body)", "/midi/status/204/ws.mid", { code: "SMF_INVALID_HEADER" }],
        ["200 empty body", "/midi/empty", { code: "SMF_INVALID_HEADER" }],
        ["200 non-MIDI bytes", "/midi/garbage", { code: "SMF_INVALID_HEADER" }],
        ["200 truncated MIDI", "/midi/truncated/100/ws.mid", { code: "SMF_TRUNCATED" }],
        ["connection reset", "/midi/reset", { code: "NETWORK_ERROR" }],
      ]) {
        const before = await fresh(p);
        const url = tag(route);
        const o = await settled(p, await ev.load(p, url));
        t.check(label + ": rejects " + expect.code + (expect.status ? " with status " + expect.status : ""),
          o.state === "rejected" && o.code === expect.code && (expect.status === undefined || o.status === expect.status), JSON.stringify(o));
        kept(label, before, await ev.status(p));
      }
      {
        const before = await fresh(p);
        const o = await settled(p, await ev.load(p, (await refusedOrigin()) + "/midi/ok/ws.mid"));
        t.check("connection refused: rejects NETWORK_ERROR", o.state === "rejected" && o.code === "NETWORK_ERROR", JSON.stringify(o));
        kept("connection refused", before, await ev.status(p));
      }
      {
        await fresh(p);
        const o = await settled(p, await ev.load(p, tag("/midi/redirect/test-midi/all-gm-sounds.mid")));
        t.check("302: the redirect is followed and its target installed", o.state === "resolved" && (await ev.status(p)).maxTick === GM, JSON.stringify(o));
      }
      // Cancellation.
      {
        const before = await fresh(p);
        const key = "t5-abort-" + build + "-" + Date.now();
        server.hold(key);
        const url = tag("/midi/hold/" + key + "/ws.mid");
        const id = await ev.load(p, url, "later");
        await until(() => reached(url).length, "the held request to reach the server");
        await ev.abort(p, id);
        const o = await settled(p, id);
        const end = await loadend(p, url);
        server.release(key);
        await sleep(300);
        t.check("abort: rejects with the signal's AbortError", o.state === "rejected" && o.name === "AbortError", JSON.stringify(o));
        t.check("abort: the request is aborted", end.outcome === "abort", JSON.stringify(end));
        kept("abort", before, await ev.status(p));
      }
      {
        const before = await fresh(p);
        const key = "t5-abort0-" + build + "-" + Date.now();
        server.hold(key);
        const url = tag("/midi/hold/" + key + "/ws.mid");
        const id = await ev.load(p, url, "later");
        await until(() => reached(url).length, "the held request to reach the server");
        await ev.abortWith(p, id, 0);
        const o = await settled(p, id);
        const end = await loadend(p, url);
        server.release(key);
        await sleep(300);
        t.check("abort(0), a falsy reason: rejects with an AbortError, never resolves", o.state === "rejected" && o.name === "AbortError", JSON.stringify(o));
        t.check("abort(0): the request is aborted", end.outcome === "abort", JSON.stringify(end));
        kept("abort(0)", before, await ev.status(p));
      }
      {
        await fresh(p);
        const url = tag("/midi/ok/ws.mid");
        const o = await settled(p, await ev.load(p, url, "before"));
        await sleep(300);
        t.check("an already aborted signal: rejects AbortError and sends nothing", o.state === "rejected" && o.name === "AbortError" && !reached(url).length,
          JSON.stringify([o, reached(url)]));
      }
      // Races.
      {
        await fresh(p);
        const key = "t5-race-a-" + build + "-" + Date.now();
        server.hold(key);
        const slow = tag("/midi/hold/" + key + "/ws.mid"), fast = tag("/midi/ok/test-midi/all-gm-sounds.mid");
        const older = await ev.load(p, slow);
        await until(() => reached(slow).length, "the held request to reach the server");
        const newer = await ev.load(p, fast);
        const o1 = await settled(p, older), slowEnd = await loadend(p, slow), o2 = await settled(p, newer);
        server.release(key);
        await sleep(300);
        t.check("race, newer URL: the older load rejects LOAD_SUPERSEDED and its request is aborted",
          o1.state === "rejected" && o1.code === "LOAD_SUPERSEDED" && slowEnd.outcome === "abort", JSON.stringify([o1, slowEnd]));
        t.check("race, newer URL: the newer song stays installed", o2.state === "resolved" && (await ev.status(p)).maxTick === GM, JSON.stringify(o2));
      }
      {
        await fresh(p);
        const key = "t5-race-b-" + build + "-" + Date.now();
        server.hold(key);
        const slow = tag("/midi/hold/" + key + "/ws.mid");
        const id = await ev.load(p, slow);
        await until(() => reached(slow).length, "the held request to reach the server");
        const direct = await ev.bytes(p, DIRECT.toString("base64"));
        server.release(key);
        const o = await settled(p, id);
        await loadend(p, slow);
        const st = await ev.status(p);
        t.check("race, direct loadMIDI(): the URL load rejects LOAD_SUPERSEDED", o.state === "rejected" && o.code === "LOAD_SUPERSEDED", JSON.stringify(o));
        t.check("race, direct loadMIDI(): the direct song stays installed", direct.maxTick === directTicks && st.maxTick === directTicks, JSON.stringify([direct, st]));
      }
      t.check("no page errors and no unhandled rejection", !p.pageErrors.length && !(await ev.status(p)).rejections.length,
        JSON.stringify([p.pageErrors, (await ev.status(p)).rejections]));

      // dispose() during a load.
      {
        const q = await open();
        const before = await fresh(q);
        const key = "t5-dispose-" + build + "-" + Date.now();
        server.hold(key);
        const url = tag("/midi/hold/" + key + "/ws.mid");
        const id = await ev.load(q, url);
        await until(() => reached(url).length, "the held request to reach the server");
        await ev.dispose(q);
        const o = await settled(q, id);
        server.release(key);
        const end = await loadend(q, url);
        await sleep(200);
        t.check("dispose(): the pending load rejects SYNTH_DISPOSED at once", o.state === "rejected" && o.code === "SYNTH_DISPOSED", JSON.stringify(o));
        t.check("dispose(): the response still arrives and installs nothing", end.status === 200 && (await ev.status(q)).maxTick === before.maxTick,
          JSON.stringify([end, await ev.status(q)]));
      }

      // Fire and forget.
      {
        const q = await open();
        const key = "t5-forget-" + build + "-" + Date.now();
        server.hold(key);
        const urls = ["/midi/status/404/ws.mid", "/midi/garbage", "/midi/reset", "/midi/truncated/100/ws.mid"].map(tag);
        for (const url of urls) {
          await ev.forget(q, url);
          await loadend(q, url);
        }
        const superseded = tag("/midi/hold/" + key + "/ws.mid");
        await ev.forget(q, superseded);
        await ev.forget(q, tag("/midi/status/500/ws.mid"));
        await ev.forget(q, ""); // TypeError
        const pending = tag("/midi/hold/" + key + "/ws.mid");
        await ev.forget(q, pending);
        await until(() => reached(pending).length, "the held request to reach the server");
        await ev.dispose(q);
        server.release(key);
        await loadend(q, pending);
        await sleep(500);
        const quiet = (await ev.status(q)).rejections;
        await ev.control(q);
        await sleep(200);
        const after = (await ev.status(q)).rejections;
        t.check("fire and forget: no unhandled rejection from any failure", quiet.length === 0, JSON.stringify(quiet));
        t.check("fire and forget: the control rejection is seen (the detector works)", after.length === 1 && after[0].message === "control", JSON.stringify(after));
        t.check("fire and forget: no page errors", !q.pageErrors.length, q.pageErrors.join(" | "));
      }
    },
  })).concat(matrix.builds.map((build) => ({
    id: "api-url guard " + build,
    dims: { build },
    deadline: 120,
    run: async (t) => {
      const pageId = "api-url-guard-" + build;
      server.registerPage(pageId, pages.inlinePage({ library: pages.readLibrary(build, options.overrides), seed: options.seed }));
      const p = await t.newPage();
      await p.page.goto(server.origin + "/html/" + pageId);
      const url = "/midi/ok/ws.mid?t52=" + build + "-" + Date.now();
      const o = await p.page.evaluate(GUARD, url);
      await sleep(300);
      t.observe("engine: out-of-range WebAudio calls", o.engine);
      t.check("setTimbre: a, h, d, r and q of 1e39 throw a RangeError naming the operator; nothing is installed",
        o.timbre.every((e, i) => e === "RangeError: operator 1 " + "ahdrq"[i] + " out of range: 1e+39") && o.timbreKept, JSON.stringify(o.timbre));
      for (const r of o.notes)
        t.check("a note whose values overflow float32 (" + r.label + "): no throw, no node, no voice", r.error === null && r.made === 0 && r.voices === 0, JSON.stringify(r));
      t.check("a valid note afterwards plays", o.valid === null && o.validMade > 0, JSON.stringify([o.valid, o.validMade]));
      t.check("tsmode 1: performance.now() times before the context's time 0 play at once, no throw", o.ts === null && o.tsMade > 0, JSON.stringify([o.ts, o.tsMade]));
      t.check("the render is finite and audible", o.render.finite && o.render.peak > 0, JSON.stringify(o.render));
      t.check("send(): an empty array-like SysEx creates no lazy context", o.sysex === null && o.sysexNoContext, JSON.stringify([o.sysex, o.sysexNoContext]));
      t.check("loadMIDIUrl(): a throwing opts.signal getter rejects with its error and sends nothing",
        o.urlThrow === null && o.url === "rejected: getter" && !server.requests.some((r) => r.path === url), JSON.stringify([o.urlThrow, o.url]));
      t.check("no page errors and no unhandled rejection", !p.pageErrors.length && !o.rejections.length, JSON.stringify([p.pageErrors, o.rejections]));
    },
  })));
}

module.exports = { cases };
