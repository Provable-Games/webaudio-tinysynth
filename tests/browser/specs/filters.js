/*
 * Fixed operator filters (#27, D-007 as amended by D-028; tasks/T12.md) in real engines, for both
 * builds. Expected values are computed here, independently of the library, from the contract:
 *   cutoff = min(fk ? ff x f(note) : ff, 0.45 x sampleRate), f(note) = 440 x 2^((note - 69) / 12);
 *   Q = fq (default Math.SQRT1_2) as a linear Q, in the RBJ cookbook biquad (Web Audio's formulas:
 *   alpha = sin(w0) / (2Q) for all three types, the engine being given 20 log10(fq) dB for low-
 *   and high-pass, and the constant 0 dB peak band-pass).
 *
 * Asserted:
 *   - response: getFrequencyResponse() of the filter node each voice gets, at 256 log-spaced
 *     frequencies from 20 Hz to Nyquist, equals the RBJ magnitude within RESPONSE_DB wherever
 *     that is above -80 dB: three types x four cutoffs x five Q, key tracking at six notes from
 *     24 to 120 with ff 1, 2 and 8 (the clamp included), cutoffs at and above Nyquist, and two
 *     drum timbres, at 44.1 and 48 kHz;
 *   - rendered routing (OfflineAudioContext, reverb off, masterVol 0.05 so the compressor stays
 *     below its threshold): pure-tone probes, each a sine operator held at a known frequency F in
 *     its own slot. Input spectrum: one tone at F. Measurement: the tone's amplitude, a least-
 *     squares fit of sin and cos at F over the slot's window (0.2 s to 0.45 s after the note-on).
 *     Normalization: the same render without the filter fields. The ratio must equal the RBJ
 *     magnitude at F within PROBE_DB: low-, high- and band-pass with Q in dB and linear,
 *     a +20 dB resonance, key tracking (-3.01 dB at every note), the Nyquist clamp on key-
 *     tracked high notes, and a drum;
 *   - the consumer fixture (tests/fixtures/consumer/filters-setup.json) end to end: its three
 *     timbres rendered with and without their filters. Per octave band (125 Hz to 16 kHz;
 *     Blackman-Harris window over 16384 samples, 4096 for the short hi-hat, from 10 ms after
 *     each note-on), the filtered render's energy relative to the unfiltered one must equal that
 *     of the unfiltered render passed through the independent RBJ filter (double precision),
 *     within BAND_DB wherever that expectation is above -60 dB; deeper bands measure at least
 *     50 dB down;
 *   - lifecycle on a realtime context with T6's instrumentation (page/instrument.js): after
 *     many melodic notes with steals, drum hits, a song stopped by stopMIDI() with hits queued
 *     ahead, all-sound-off, context replacement and dispose(), every node-to-node connection is
 *     the idle graph's (so none from or to a BiquadFilter is left; WebKit's pre-existing leftover
 *     modulation-to-detune routes are observed separately), the synth's voice lists hold
 *     no filter, the old context has no live connection, and filters were created in every
 *     phase (no vacuous pass);
 *   - no page error and no unhandled rejection.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const pages = require("../lib/pages");
const A = require("../lib/analysis");
const smf = require("../lib/smf");
const { openRenderPage, render } = require("./render");

const CLAMP = 0.45;
const RESPONSE_DB = 0.01; // measured max 0.0028 dB, at 0.4999 x SR (tasks/T12.md); at or below the clamp 1e-4
const PROBE_DB = 0.02; // measured max: see tasks/T12.md
const BAND_DB = 0.5; // measured max: see tasks/T12.md
const LEVEL = 0.05;
const DETUNE = /^\d+>n\d+\.detune:/; // an edge from a node to a source's detune parameter (instrument.js keys)

/* ---- the contract and an independent RBJ biquad ---- */
const noteHz = (n) => 440 * Math.pow(2, (n - 69) / 12);
const cutoff = (op, note, sr) => Math.min(op.fk ? op.ff * noteHz(note) : op.ff, CLAMP * sr);
function rbj(type, f0, Q, sr) {
  const w0 = 2 * Math.PI * f0 / sr, c = Math.cos(w0), a = Math.sin(w0) / (2 * Q);
  const b = type === "lowpass" ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : type === "highpass" ? [(1 + c) / 2, -(1 + c), (1 + c) / 2] : [a, 0, -a];
  return { b, a: [1 + a, -2 * c, 1 - a] };
}
function mag({ b, a }, f, sr) {
  const w = 2 * Math.PI * f / sr, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  return Math.hypot(b[0] + b[1] * c1 + b[2] * c2, b[1] * s1 + b[2] * s2) / Math.hypot(a[0] + a[1] * c1 + a[2] * c2, a[1] * s1 + a[2] * s2);
}
const expected = (op, note, sr) => rbj(op.fl, cutoff(op, note, sr), op.fq || Math.SQRT1_2, sr);

/* Amplitude of the tone at f in x[i0..i1), by least squares on sin and cos. */
function toneAmp(x, sr, f, i0, i1) {
  let ss = 0, cc = 0, sc = 0, xs = 0, xc = 0;
  for (let i = i0; i < i1; ++i) {
    const p = 2 * Math.PI * f * i / sr, s = Math.sin(p), c = Math.cos(p);
    ss += s * s; cc += c * c; sc += s * c; xs += x[i] * s; xc += x[i] * c;
  }
  const det = ss * cc - sc * sc, A1 = (xs * cc - xc * sc) / det, B1 = (xc * ss - xs * sc) / det;
  return Math.hypot(A1, B1);
}

/* Power spectrum of x[i0..i0+n) with a Blackman-Harris window: Float64Array of n/2+1 bins. */
function power(x, i0, n) {
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; ++i) {
    const p = 2 * Math.PI * i / (n - 1);
    re[i] = (x[i0 + i] || 0) * (0.35875 - 0.48829 * Math.cos(p) + 0.14128 * Math.cos(2 * p) - 0.01168 * Math.cos(3 * p));
  }
  A.fft(re, im);
  const out = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; ++k) out[k] = re[k] * re[k] + im[k] * im[k];
  return out;
}

/* ---- response: the voices' filter nodes ---- */
function responseCombos(sr) {
  const out = [];
  for (const fl of ["lowpass", "highpass", "bandpass"]) {
    for (const ff of [250, 1000, 5000, 15000]) for (const fq of [undefined, 0.1, 1, 4, 30]) out.push({ m: 0, n: 69, op: { fl, ff, fq } });
    for (const ff of [1, 2, 8]) for (const n of [24, 48, 69, 96, 108, 120]) out.push({ m: 0, n, op: { fl, ff, fk: 1 } });
    out.push({ m: 0, n: 69, op: { fl, ff: 30000 } }, { m: 0, n: 69, op: { fl, ff: sr / 2, fq: 4 } });
  }
  out.push({ m: 1, n: 42, op: { fl: "highpass", ff: 3000 } }, { m: 1, n: 44, op: { fl: "lowpass", ff: 20, fk: 1, fq: 2 } });
  return out;
}

/* eslint-disable no-undef -- the callbacks below run in the page */
const RESPONSE = ({ sr, combos, freqs }) => {
  const synth = new WebAudioTinySynth({ quality: 1, useReverb: 0, voices: 1000, context: new OfflineAudioContext(1, 128, sr) });
  const f32 = new Float32Array(freqs), out = [];
  for (const c of combos) {
    synth.setTimbre(c.m, c.m ? c.n : 0, [Object.assign({ w: "sine", s: 1 }, c.op)]);
    synth.noteOn(c.m ? 9 : 0, c.n, 100, 0);
    const list = c.m ? synth._src : synth.notetab, b = list[list.length - 1].q[0];
    const m = new Float32Array(f32.length), ph = new Float32Array(f32.length);
    b.getFrequencyResponse(f32, m, ph);
    out.push(Array.from(m));
  }
  return out;
};

const LIFE = async ({ midi }) => {
  const L = window.__t6.lifecycle;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const bytes = (b64) => { const s = atob(b64), a = new Uint8Array(s.length); for (let i = 0; i < s.length; ++i) a[i] = s.charCodeAt(i); return a.buffer; };
  const synth = new WebAudioTinySynth({ quality: 1 });
  await Promise.race([synth.resume(), wait(5000)]);
  const held = () => [...synth.notetab, ...synth._src, ...synth._gone].reduce((s, v) => s + (v.q || []).filter(Boolean).length, 0);
  const busy = (c) => L.active().filter((a) => a.context === c).length;
  /* Every voice pruned and every source ended but the LFO (bounded). */
  const idle = async (c = "c0") => {
    for (let i = 0; i < 100 && (synth.notetab.length || synth._src.length || synth._gone.size || busy(c) > 1); ++i) await wait(100);
  };
  const bq = (c = "c0") => (L.snapshot().contexts[c] || { nodes: {} }).nodes.BiquadFilter || 0;
  const timbres = () => {
    synth.setTimbre(0, 1, [{ w: "sawtooth", v: 0.2, d: 0.2, s: 0.5, r: 0.05, fl: "lowpass", ff: 2, fk: 1, fq: 2 }, { w: "square", t: 2, v: 0.05, s: 0.5, r: 0.05 }]);
    synth.setTimbre(0, 2, [{ w: "n0", v: 0.2, s: 0.5, r: 0.05, fl: "bandpass", ff: 1200, fq: 4 }, { g: 1, w: "sine", t: 0, f: 5, v: 0.01, s: 1 }]);
    synth.setTimbre(1, 42, [{ w: "n1", t: 0, f: 440, v: 0.2, d: 0.04, r: 0.04, fl: "highpass", ff: 3000 }]);
    synth.setTimbre(1, 38, [{ w: "n0", t: 0, f: 440, v: 0.2, d: 0.08, fl: "bandpass", ff: 2000, fq: 2 }, { w: "triangle", t: 0, f: 180, v: 0.3, d: 0.08 }]);
  };
  const programs = () => { synth.setProgram(0, 1); synth.setProgram(1, 2); };
  timbres();
  await idle();
  const S0 = new Set(L.edges()), r = { phases: [] };
  const phase = async (name, run) => {
    const before = bq();
    const mid = await run();
    await idle();
    r.phases.push({ name, created: bq() - before, mid, extra: L.edges().filter((k) => !S0.has(k)), missing: [...S0].filter((k) => !L.edges().includes(k)), held: held(), lists: [synth.notetab.length, synth._src.length, synth._gone.size] });
  };
  await phase("notes, steals and drum hits", async () => {
    programs();
    synth.setVoices(6);
    let mid = 0;
    for (let k = 0; k < 60; ++k) {
      const t = synth.getAudioContext().currentTime, n = 40 + (k * 5) % 40;
      synth.noteOn(k % 2, n, 100, t);
      synth.noteOff(k % 2, n, t + 0.08 + (k % 4) * 0.05);
      if (k % 3 === 0) synth.noteOn(9, k % 2 ? 42 : 38, 100, t + 0.01);
      if (k === 30) mid = L.edges().length - S0.size;
      await wait(20);
    }
    synth.setVoices(64);
    return mid;
  });
  await phase("a song stopped by stopMIDI() with hits queued ahead (D-023)", async () => {
    synth.loadMIDI(bytes(midi)); // its programs 1 and 2 are the filtered timbres
    synth.playMIDI();
    await wait(700);
    const t = synth.getAudioContext().currentTime;
    synth.noteOn(9, 42, 100, t + 0.3); synth.noteOn(9, 38, 100, t + 0.4);
    const mid = L.edges().length - S0.size;
    synth.stopMIDI();
    return mid;
  });
  await phase("all-sound-off", async () => {
    programs();
    synth.noteOn(0, 60, 100); synth.noteOn(0, 67, 100); synth.noteOn(1, 64, 100);
    await wait(200);
    const mid = L.edges().length - S0.size;
    synth.send([0xb0, 120, 0]); synth.send([0xb1, 120, 0]);
    return mid;
  });
  // Replacement: the synth's own context c0 is closed and torn down at once; then dispose() on the caller's c1.
  programs();
  synth.noteOn(0, 60, 100); synth.noteOn(1, 64, 100); synth.noteOn(9, 42, 100);
  await wait(150);
  r.beforeReplace = { bq: bq(), edges: L.snapshot().contexts.c0.liveEdges };
  const c1 = new AudioContext();
  synth.setAudioContext(c1);
  r.c0After = L.snapshot().contexts.c0.liveEdges;
  programs(); // the timbres stay; setAudioContext() reset the channels
  synth.noteOn(0, 60, 100); synth.noteOn(1, 67, 100); synth.noteOn(9, 38, 100);
  await wait(200);
  r.c1Before = { bq: bq("c1"), edges: L.snapshot().contexts.c1.liveEdges, held: held() };
  await synth.dispose();
  for (let i = 0; i < 50 && busy("c1"); ++i) await wait(100);
  r.c1After = { edges: L.snapshot().contexts.c1.liveEdges, active: busy("c1"), held: held(), state: c1.state };
  await c1.close();
  r.rejections = window.__t6.rejections;
  return r;
};
/* eslint-enable no-undef */

/* ---- rendered probes ---- */
const sineOp = (o) => Object.assign({ w: "sine", t: 0, f: 0, v: 0.1, a: 0, h: 0.01, d: 0.01, s: 1, r: 0.02 }, o);
function probes(sr) {
  const list = [];
  const add = (label, m, n, op, F) => list.push({ label, m, n, op, F });
  for (const F of [250, 1000, 4000]) add("low-pass 1 kHz, default Q, at " + F + " Hz", 0, 69, sineOp({ f: F, fl: "lowpass", ff: 1000 }), F);
  for (const F of [250, 1000, 4000]) add("high-pass 1 kHz, fq 4 (12.04 dB), at " + F + " Hz", 0, 69, sineOp({ f: F, fl: "highpass", ff: 1000, fq: 4 }), F);
  for (const F of [500, 1000, 2000]) add("band-pass 1 kHz, fq 4 (linear), at " + F + " Hz", 0, 69, sineOp({ f: F, fl: "bandpass", ff: 1000, fq: 4 }), F);
  add("low-pass 1 kHz, fq 10: +20 dB at the cutoff", 0, 69, sineOp({ f: 1000, v: 0.02, fl: "lowpass", ff: 1000, fq: 10 }), 1000);
  for (const n of [36, 48, 60, 72, 84, 96, 105]) add("key tracking: low-pass fk 1 ff 1 at note " + n + " (-3.01 dB)", 0, n, sineOp({ t: 1, fl: "lowpass", ff: 1, fk: 1 }), noteHz(n));
  for (const n of [84, 96, 100, 104, 108]) {
    const raw = 8 * noteHz(n);
    add("clamp: high-pass fk 1 ff 8 at note " + n + " (" + (raw >= CLAMP * sr ? "clamped from " + Math.round(raw) + " Hz" : "unclamped") + ")", 0, n, sineOp({ t: 1, v: 0.2, fl: "highpass", ff: 8, fk: 1 }), noteHz(n));
  }
  add("drum 42: high-pass 1 kHz at 500 Hz", 1, 42, sineOp({ f: 500, d: 0.15, fl: "highpass", ff: 1000 }), 500);
  add("drum 44: low-pass fk 1 ff 1 at the drum note's frequency", 1, 44, sineOp({ t: 1, d: 0.15, fl: "lowpass", ff: 1, fk: 1 }), noteHz(44));
  return list;
}
const SLOT = 0.6, ON = 0.05, OFF = 0.5, W0 = 0.2, W1 = 0.45;
const strip = (op) => { const o = Object.assign({}, op); delete o.fl; delete o.ff; delete o.fq; delete o.fk; return o; };
function probeSpec(list, sr, seed, filtered) {
  const steps = [];
  list.forEach((p, k) => {
    const t = k * SLOT;
    steps.push({ call: "setTimbre", args: [p.m, p.m ? p.n : 0, [filtered ? p.op : strip(p.op)]] });
    steps.push({ call: "noteOn", args: [p.m ? 9 : 0, p.n, 100, t + ON] });
    if (!p.m) steps.push({ call: "noteOff", args: [0, p.n, t + OFF] });
  });
  return { seed, sr, duration: list.length * SLOT + 0.2, options: { quality: 1, useReverb: 0 }, masterVol: LEVEL, steps, pcm: "L" };
}

/* ---- the consumer fixture ---- */
const FIXTURE = JSON.parse(fs.readFileSync(path.join(pages.ROOT, "tests", "fixtures", "consumer", "filters-setup.json"), "utf8"));
const FIX_SLOT = 2.0; // the lead's release tail is below -90 dB when the next slot starts
function fixtureSpec(sr, seed, filtered) {
  const steps = [];
  FIXTURE.tinysynth.forEach(([m, n, ops], k) => {
    const t = k * FIX_SLOT + ON;
    steps.push({ call: "setTimbre", args: [m, n, filtered ? ops : ops.map(strip)] });
    if (m) steps.push({ call: "noteOn", args: [9, n, 100, t] });
    else steps.push({ call: "setProgram", args: [0, n] }, { call: "noteOn", args: [0, 60, 100, t] }, { call: "noteOff", args: [0, 60, t + 0.9] });
  });
  return { seed, sr, duration: FIXTURE.tinysynth.length * FIX_SLOT + 0.2, options: { quality: 1, useReverb: 0 }, masterVol: LEVEL, steps, pcm: "L" };
}
/* x[i0..i1) through the RBJ biquad k, in double precision, from rest. */
function biquad({ b, a }, x, i0, i1) {
  const y = new Float64Array(i1 - i0);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = i0; i < i1; ++i) {
    const v = (b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2) / a[0];
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i - i0] = v;
  }
  return y;
}
/*
 * Per fixture timbre and octave band: the energy of the filtered render relative to the
 * unfiltered one (measured), and of the unfiltered render passed through the independent RBJ
 * filter of the timbre's declared setting (expected), both with the same Blackman-Harris window.
 * The chain after the filter (channel volume, pan, the compressor below its threshold) is linear
 * and the same in both renders, so it commutes with the filter.
 */
const BANDS = [125, 250, 500, 1000, 2000, 4000, 8000, 16000];
function fixtureBands(x, y, sr) {
  const out = [];
  FIXTURE.tinysynth.forEach(([m, n, ops], k) => {
    const note = m ? n : 60, N = m ? 4096 : 16384; // the hi-hat lasts 0.14 s
    const filters = ops.filter((o) => o.fl);
    const s0 = Math.round((k * FIX_SLOT) * sr), i0 = Math.round((k * FIX_SLOT + ON + 0.01) * sr);
    const z = biquad(expected(filters[0], note, sr), x, s0, i0 + N); // every filtered operator of a fixture timbre has the same setting
    const X = power(x, i0, N), Y = power(y, i0, N), Z = power(z, i0 - s0, N);
    for (const fc of BANDS) {
      const lo = fc / Math.SQRT2, hi = Math.min(fc * Math.SQRT2, sr / 2);
      let ex = 0, ey = 0, ez = 0;
      for (let b = 1; b < N / 2; ++b) {
        const f = b * sr / N;
        if (f < lo || f >= hi) continue;
        ex += X[b]; ey += Y[b]; ez += Z[b];
      }
      out.push({ timbre: (m ? "drum " : "program ") + n, band: fc, measuredDb: 10 * Math.log10(ey / ex), expectedDb: 10 * Math.log10(ez / ex), inputDb: 10 * Math.log10(ex) });
    }
  });
  return out;
}

function cases(shared) {
  const { matrix, options, server } = shared;
  const out = [];
  for (const build of matrix.builds) {
    out.push({
      id: "filters response " + build,
      dims: { build },
      deadline: 120,
      run: async (t) => {
        const p = await t.newPage({ offline: true });
        await p.page.setContent(pages.inlinePage({ library: pages.readLibrary(build, options.overrides), seed: options.seed }));
        for (const sr of matrix.sampleRates) {
          const freqs = [];
          for (let i = 0; i < 256; ++i) freqs.push(20 * Math.pow((sr / 2) / 20, i / 255) * (i === 255 ? 0.999 : 1));
          const combos = responseCombos(sr);
          const got = await p.page.evaluate(RESPONSE, { sr, combos, freqs });
          let worst = { d: 0 }, compared = 0;
          combos.forEach((c, j) => {
            const H = expected(c.op, c.n, sr);
            freqs.forEach((f, i) => {
              const e = 20 * Math.log10(mag(H, Math.fround(f), sr));
              if (e < -80) return;
              ++compared;
              const d = Math.abs(20 * Math.log10(got[j][i]) - e);
              if (!(d <= worst.d)) worst = { d, f, op: c.op, n: c.n, e };
            });
          });
          t.observe("response " + sr + ": worst dB difference", { db: worst.d, at: worst.f, op: worst.op, note: worst.n, compared });
          t.check(sr + " Hz: every voice's filter response equals RBJ within " + RESPONSE_DB + " dB (" + combos.length + " filters, " + compared + " points above -80 dB)",
            worst.d <= RESPONSE_DB, "worst " + worst.d.toExponential(2) + " dB at " + Math.round(worst.f) + " Hz, " + JSON.stringify(worst.op) + " note " + worst.n);
        }
        t.check("no page errors", !p.pageErrors.length, p.pageErrors.slice(0, 2).join(" | "));
      },
    });
    for (const sr of matrix.sampleRates) {
      out.push({
        id: "filters render " + build + " " + sr,
        dims: { build, sampleRate: sr },
        deadline: 180,
        run: async (t) => {
          const p = await openRenderPage(t, build, options.seed);
          const list = probes(sr);
          const fr = await render(p, probeSpec(list, sr, options.seed, true));
          const un = await render(p, probeSpec(list, sr, options.seed, false));
          const x = fr.channels[0], y = un.channels[0];
          const rows = list.map((pr, k) => {
            const i0 = Math.round((k * SLOT + ON + W0) * sr), i1 = Math.round((k * SLOT + ON + W1) * sr);
            const ratio = toneAmp(x, sr, pr.F, i0, i1) / toneAmp(y, sr, pr.F, i0, i1);
            const e = mag(expected(pr.op, pr.n, sr), pr.F, sr);
            return { label: pr.label, measuredDb: A.db(ratio), expectedDb: A.db(e), diff: Math.abs(A.db(ratio) - A.db(e)), unfiltered: toneAmp(y, sr, pr.F, i0, i1) };
          });
          t.observe("probes " + sr, rows.map((r) => [r.label, +r.measuredDb.toFixed(4), +r.expectedDb.toFixed(4)]));
          for (const r of rows)
            t.check(r.label + ": " + r.measuredDb.toFixed(3) + " dB, RBJ " + r.expectedDb.toFixed(3) + " dB", r.unfiltered > 1e-4 && r.diff <= PROBE_DB, "|diff| " + r.diff.toExponential(2) + " dB");
          t.check("renders are finite", !A.nonFinite(x).nan && !A.nonFinite(x).inf && !A.nonFinite(y).nan && !A.nonFinite(y).inf);

          const fx = await render(p, fixtureSpec(sr, options.seed, true));
          const fu = await render(p, fixtureSpec(sr, options.seed, false));
          const bands = fixtureBands(fu.channels[0], fx.channels[0], sr);
          t.observe("fixture bands " + sr, bands.map((b) => [b.timbre, b.band, +b.measuredDb.toFixed(3), +b.expectedDb.toFixed(3)]));
          const judged = bands.filter((b) => b.expectedDb > -60 && b.inputDb > -200);
          const worst = judged.reduce((w, b) => (Math.abs(b.measuredDb - b.expectedDb) > w.d ? { d: Math.abs(b.measuredDb - b.expectedDb), b } : w), { d: 0 });
          t.check("consumer fixture: every octave band's energy ratio equals the RBJ expectation within " + BAND_DB + " dB (" + judged.length + " bands above -60 dB)",
            judged.length >= 18 && worst.d <= BAND_DB, worst.b ? "worst " + worst.d.toFixed(3) + " dB, " + worst.b.timbre + " " + worst.b.band + " Hz" : "");
          const deep = bands.filter((b) => b.expectedDb <= -60);
          t.check("consumer fixture: bands the filters cut by 60 dB or more measure at least 50 dB down", deep.every((b) => b.measuredDb <= -50), deep.map((b) => b.timbre + " " + b.band + ": " + b.measuredDb.toFixed(1)).join(", "));
          t.check("no unhandled rejections", ![fr, un, fx, fu].some((z) => z.rejections.length));
          t.check("no page errors", !p.pageErrors.length, p.pageErrors.slice(0, 2).join(" | "));
        },
      });
    }
    out.push({
      id: "filters lifecycle " + build,
      dims: { build },
      deadline: 150,
      run: async (t) => {
        const id = "filters-life-" + build;
        server.registerPage(id, pages.inlinePage({ library: pages.readLibrary(build, options.overrides), seed: options.seed, instrument: true }));
        const p = await t.newPage();
        await p.page.goto(server.origin + "/html/" + id);
        const ev = (d, tick) => ({ dt: d, bytes: tick });
        const track = [];
        for (let k = 0; k < 24; ++k) {
          track.push(ev(k ? 120 : 0, [0x90, 48 + (k * 7) % 24, 100]), ev(0, [0x91, 60 + (k * 5) % 12, 90]), ev(0, [0x99, k % 2 ? 42 : 38, 100]));
          track.push(ev(100, [0x80, 48 + (k * 7) % 24, 0]), ev(0, [0x81, 60 + (k * 5) % 12, 0]));
        }
        const midi = smf.write({ tracks: [[ev(0, [0xc0, 1]), ev(0, [0xc1, 2]), ...track]] }).toString("base64");
        const r = await p.page.evaluate(LIFE, { midi });
        for (const ph of r.phases) {
          t.check(ph.name + ": filters were created and connected (" + ph.created + " BiquadFilters, " + ph.mid + " live connections over the idle graph mid-phase)", ph.created >= 3 && ph.mid >= 2);
          // A filter has node-to-node connections only (gain -> filter -> channel volume). Routes from a
          // channel's modulation gain to a source's detune that WebKit keeps after some voices end are
          // pre-existing (the base build d1f0e26 leaves the same; tasks/T12.md) and are observed, not judged here.
          const detune = ph.extra.filter((k) => DETUNE.test(k)), other = ph.extra.filter((k) => !DETUNE.test(k));
          t.observe(ph.name + ": leftover modulation-to-detune routes (pre-existing)", detune.length);
          t.check(ph.name + ": afterwards every node-to-node connection is the idle graph's, so none from or to a filter", !other.length && !ph.missing.length,
            "extra " + JSON.stringify(other.slice(0, 6)) + " missing " + JSON.stringify(ph.missing.slice(0, 6)));
          t.check(ph.name + ": the voice lists are empty and hold no filter", ph.held === 0 && ph.lists.every((n) => n === 0), JSON.stringify(ph.lists) + ", " + ph.held + " filters held");
        }
        t.check("replacement: filters were playing on the replaced context", r.beforeReplace.bq >= 3 && r.beforeReplace.edges > 0, JSON.stringify(r.beforeReplace));
        t.check("replacement: the synth's own context is torn down at once, no live connection left", r.c0After === 0, String(r.c0After));
        t.check("dispose(): filters were playing on the caller's context", r.c1Before.bq >= 3 && r.c1Before.held >= 2, JSON.stringify(r.c1Before));
        t.check("dispose(): the caller's context stays open; once its sources end no live connection is left and no filter is held",
          r.c1After.state !== "closed" && r.c1After.active === 0 && r.c1After.edges === 0 && r.c1After.held === 0, JSON.stringify(r.c1After));
        t.check("no unhandled rejections", !r.rejections.length, JSON.stringify(r.rejections.slice(0, 2)));
        t.check("no page errors", !p.pageErrors.length, p.pageErrors.slice(0, 2).join(" | "));
      },
    });
  }
  return out;
}

module.exports = { cases, rbj, mag, cutoff };
