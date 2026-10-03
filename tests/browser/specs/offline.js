/*
 * The OfflineAudioContext contract (#12, D-017, D-018; tasks/T4.md §3).
 * T4 phase-B checks.
 *
 * Asserted, for both builds:
 *   - melodic notes scheduled at explicit times on an injected
 *     OfflineAudioContext (released, so the baseline's interval would prune
 *     them at wall-clock-dependent render positions, which is why T6's render
 *     pages stop it) render the same three times in a row while the library's
 *     interval keeps running, within the engine's same-engine tolerance
 *     (tolerances.js). Drums are left out of this comparison: the interval
 *     never pruned them, and WebKit renders them with an occasional 1e-5
 *     difference with or without the interval (base build measured the same;
 *     specs/render.js reconciles those);
 *   - playMIDI() on an offline context throws AUDIO_CONTEXT_OFFLINE and
 *     leaves the play status unchanged;
 *   - setAudioContext(OfflineAudioContext) closes the realtime context the
 *     constructor created, and nothing rejects unhandled;
 *   - the `destination` option routes the output: a gain of 0.5 there halves
 *     the rendered peak, a gain of 0 silences it;
 *   - zero unhandled rejections (the baseline left two per install and one
 *     per send(), T6 §4.4.2).
 * Math.random is seeded before each construction (prelude), so the noise and
 * reverb buffers are equal between renders.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const pages = require("../lib/pages");
const { tolerances } = require("../tolerances");

/* eslint-disable no-undef -- the callbacks below run in the page */
const RENDER = async ({ seed }) => {
  window.__t6.seed(seed);
  const ctx = new OfflineAudioContext(2, 44100 * 12, 44100);
  const synth = new WebAudioTinySynth({ quality: 1, context: ctx });
  [0, 24, 48, 80].forEach((p, ch) => synth.setProgram(ch, p));
  for (let k = 0; k < 30; ++k) {
    const t = 0.1 + k * 0.35, ch = k % 4, n = 48 + (k * 5) % 30;
    synth.noteOn(ch, n, 100, t);
    synth.noteOff(ch, n, t + 0.2);
  }
  const intervals = window.__t6.intervals.filter((r) => r.active && r.ms === 60).length;
  const buf = await ctx.startRendering();
  (window.__renders = window.__renders || []).push([buf.getChannelData(0), buf.getChannelData(1)]);
  await synth.dispose();
  let peak = 0;
  for (const d of window.__renders[window.__renders.length - 1]) for (let i = 0; i < d.length; ++i) peak = Math.max(peak, Math.abs(d[i]));
  return { index: window.__renders.length - 1, intervals, peak };
};
const DIFF = ([a, b]) => {
  const A = window.__renders[a], B = window.__renders[b];
  let m = 0;
  for (let c = 0; c < 2; ++c) for (let i = 0; i < A[c].length; ++i) m = Math.max(m, Math.abs(A[c][i] - B[c][i]));
  return m;
};
const PLAY = async (midi) => {
  const bin = atob(midi), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; ++i) bytes[i] = bin.charCodeAt(i);
  const synth = new WebAudioTinySynth({ context: new OfflineAudioContext(1, 44100, 44100) });
  synth.loadMIDI(bytes.buffer);
  const before = JSON.stringify(synth.getPlayStatus());
  let error = null;
  try { synth.playMIDI(); } catch (e) { error = { code: e.code, message: e.message }; }
  return { error, unchanged: JSON.stringify(synth.getPlayStatus()) === before };
};
const REPLACE = async () => {
  const synth = new WebAudioTinySynth({ quality: 1 });
  const realtime = synth.getAudioContext();
  const ctx = new OfflineAudioContext(1, 44100, 44100);
  synth.setAudioContext(ctx);
  synth.noteOn(0, 60, 100, 0.1);
  synth.noteOn(9, 38, 100, 0.2);
  await ctx.startRendering();
  await new Promise((r) => setTimeout(r, 300));
  return { realtime: realtime.state };
};
const ROUTE = async ({ seed, gain }) => {
  window.__t6.seed(seed);
  const ctx = new OfflineAudioContext(1, 44100, 44100);
  let dest = null;
  if (gain !== null) {
    dest = ctx.createGain();
    dest.gain.value = gain;
    dest.connect(ctx.destination);
  }
  const synth = new WebAudioTinySynth(dest ? { quality: 0, useReverb: 0, context: ctx, destination: dest } : { quality: 0, useReverb: 0, context: ctx });
  synth.noteOn(0, 69, 100, 0.1);
  synth.noteOff(0, 69, 0.6);
  const d = (await ctx.startRendering()).getChannelData(0);
  let peak = 0;
  for (let i = 0; i < d.length; ++i) peak = Math.max(peak, Math.abs(d[i]));
  return peak;
};
/* eslint-enable no-undef */

function cases(shared) {
  const { matrix, options, server, engine } = shared;
  const tol = tolerances(engine);
  const midi = fs.readFileSync(path.join(pages.ROOT, "ws.mid")).toString("base64");
  const out = [];
  for (const build of matrix.builds) {
    out.push({
      id: "offline " + build,
      dims: { build },
      deadline: 180,
      run: async (t) => {
        const id = "offline-" + build;
        server.registerPage(id, pages.inlinePage({ library: pages.readLibrary(build, options.overrides), seed: options.seed }));
        const p = await t.newPage();
        await p.page.goto(server.origin + "/html/" + id);
        const ev = (fn, arg) => p.page.evaluate(fn, arg);

        // Three renders with the library's interval running.
        const r = [];
        for (let i = 0; i < 3; ++i) r.push(await ev(RENDER, { seed: options.seed }));
        t.check("renders are audible and the library's interval ran during each", r.every((x) => x.peak > tol.audiblePeak && x.intervals === 1),
          r.map((x) => x.peak.toFixed(3) + "/" + x.intervals).join(", "));
        const diffs = [await ev(DIFF, [0, 1]), await ev(DIFF, [0, 2])];
        t.check("renders repeat within the same-engine tolerance (" + tol.sameEngineSample + ") with the interval running", diffs.every((x) => x <= tol.sameEngineSample),
          "max |diff| " + diffs.map((x) => x.toExponential(2)).join(", "));

        const play = await ev(PLAY, midi);
        t.check("playMIDI() throws AUDIO_CONTEXT_OFFLINE and changes nothing", !!play.error && play.error.code === "AUDIO_CONTEXT_OFFLINE" && play.unchanged, JSON.stringify(play));

        const rep = await ev(REPLACE);
        t.check("setAudioContext(offline) closes the realtime context the constructor created", rep.realtime === "closed", rep.realtime);

        const full = await ev(ROUTE, { seed: options.seed, gain: null });
        const half = await ev(ROUTE, { seed: options.seed, gain: 0.5 });
        const none = await ev(ROUTE, { seed: options.seed, gain: 0 });
        t.check("an injected destination receives the output: gain 0.5 halves the peak", full > tol.audiblePeak && Math.abs(half / full - 0.5) <= 0.5 * tol.levelRatio,
          "peaks " + full.toFixed(6) + " / " + half.toFixed(6) + " = " + (half / full).toFixed(6));
        t.check("gain 0 at the injected destination renders silence", none === 0, "peak " + none);

        const rejections = await p.page.evaluate(() => window.__t6.rejections); // eslint-disable-line no-undef -- runs in the page
        t.check("no unhandled rejections", rejections.length === 0, JSON.stringify(rejections.slice(0, 3)));
        t.check("no page errors", !p.pageErrors.length, p.pageErrors.slice(0, 2).join(" | "));
      },
    });
  }
  return out;
}

module.exports = { cases };
