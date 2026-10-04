/*
 * The #26 waveform registry in real engines (T11; D-006, D-021, D-027, D-028;
 * docs/improvements/tasks/T11.md). One case per quality mode and sample rate;
 * each case renders every item with the source and the minified build, in
 * offline pages (every request aborted), on an OfflineAudioContext given to
 * the constructor, and measures the PCM in Node (lib/analysis.js). Notes play
 * at masterVol 0.05, below the DynamicsCompressor's threshold (T6 §4.1).
 *
 * Asserted:
 *   - tables: each registered sample wave's AudioBuffer holds D-027's held
 *     table bit for bit (k = max(1, round(sr / (440 N))), each sample k
 *     frames, then one guard frame), computed here independently, in both
 *     builds; this includes TinyChip's 32,767-step LFSR (D-028);
 *   - pitch: 8-, 16-, 32-, 64-, 93- and 256-sample tables (the consumer
 *     fixture's TinyChip and Beast waves, and an 8-bit sine) at A4, and the
 *     64-step 4-bit triangle and the 12.5 % pulse at A2, C4 and A5, within
 *     1 cent of the note (T6's estimator);
 *   - home pitch: a note at f = base plays at rate 1, so every table sample
 *     lasts exactly k frames (runs of equal samples exactly their count x k);
 *   - other notes: the 12.5 % pulse's edges are sr / (f N) and 7 sr / (f N)
 *     frames apart, +-1 frame, and the frames around each edge that leave an
 *     independent sample-and-hold reference are a small fraction of a step
 *     (WAVES.edgeFraction, per engine);
 *   - pitch envelope on a drum override: p 0.28 from 160 Hz settles at 44.8 Hz
 *     within 1 cent;
 *   - FM: a 1 Hz square modulator (v 0.02; a registered 2-sample wave, whose
 *     plateaus are exactly +-1, unlike the normalized band-limited square
 *     oscillator's) moves a sample-wave carrier and a triangle-oscillator
 *     carrier by the same cents, 1200 log2(1 +- 0.02);
 *   - harmonic waves: the harmonic levels of the fixture organ are the
 *     coefficients' ratios; a registered copy of w9999's coefficients renders
 *     as w9999 does;
 *   - extreme coefficients (3e38, a lone subnormal) render finite audio, and a
 *     later note too (review M1);
 *   - lifecycle: waves registered before setAudioContext() are rebuilt for the
 *     new context's rate and render as if registered on it; the registry
 *     survives setQuality() (timbres reinstalled); a re-registered name leaves
 *     a sounding voice on the old wave while the next note gets the new one;
 *     dispose() releases the context's waves; registering waves leaves n0/n1
 *     timbres untouched;
 *   - the pinned consumer setup (tests/fixtures/consumer/waves-setup.json and
 *     waves-song.mid) installs in the consumer's order and plays audibly in
 *     every beat;
 *   - every render is finite; min renders as source within the same-engine
 *     tolerance (non-reproducible WebKit glitches are re-rendered, as in
 *     render.js); no page error and no unhandled rejection.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const pages = require("../lib/pages");
const smf = require("../lib/smf");
const A = require("../lib/analysis");
const { tolerances } = require("../tolerances");

/*
 * Tolerances for this spec, declared from the T11 runs (tasks/T11.md, the
 * waves spec results), in addition to tolerances.js (noteAmpMin, audiblePeak,
 * sameEngineSample).
 */
const WAVES = {
  pitchCents: 1, // #26 criterion; max 0.072 cents (Firefox), 0.0001 (Chromium, WebKit)
  stepFrames: 1, // #26 / D-027: edge spacing sr / (f N) +- 1 frame away from the home pitch; max 0.374 (Chromium, WebKit), 0.099 (Firefox)
  // Edge sharpness: the frames that differ from the sample-and-hold reference by more than 10 % of
  // the step, per edge, as a fraction of the step's width sr / (f N). Linear interpolation (Chromium,
  // WebKit) smears one buffer frame, 1/k of a held step: max 0.0617 for the 8-sample pulse (k 13
  // and 14) at A3, A4 and E5. Firefox's band-limited resampler rings around each edge: max 0.124.
  // Unheld storage (k = 1, D-021) smears whole steps (the T11 record's scratch k = 1 build).
  edgeFraction: { chromium: 0.1, webkit: 0.1, firefox: 0.2 },
  fmCents: 0.2, // FM depth against 1200 log2(1 +- v), and the two carriers against each other; max 0.06 (Firefox), 0.0002 elsewhere
  harmonicDb: 0.1, // harmonic levels relative to the fundamental; max 0.0001 dB (all engines)
  harmonicFloorDb: -60, // a zero coefficient; max -115 dB (Firefox)
  rereg: 1e-3, // relative to the peak: a re-registered wave's note against its own render (the first note's tail)
};

const LEVEL = 0.05;
const ON = 0.25; // note-on time (an exact frame at 44.1 and 48 kHz)
const FIXTURE = JSON.parse(fs.readFileSync(path.join(pages.ROOT, "tests", "fixtures", "consumer", "waves-setup.json"), "utf8"));
const SONG = fs.readFileSync(path.join(pages.ROOT, "tests", "fixtures", "consumer", FIXTURE.song.file));
const fixtureWave = (name) => FIXTURE.waves.find((w) => w.name === name);
const S256 = Array.from({ length: 256 }, (_, i) => Math.round(Math.sin(2 * Math.PI * i / 256) * 127) / 128); // an 8-bit sine
function lfsr({ length, tap, high }) {
  const out = [];
  let r = 1;
  for (let i = 0; i < length; ++i) {
    const fb = (r & 1) ^ ((r >> tap) & 1);
    r = (r >> 1) | (fb << 14);
    out.push((r & 1 ? high : -high) / 128);
  }
  return out;
}
/* The fixture's waves as engine calls (its converted values), plus the 8-bit sine. */
const REGISTER = FIXTURE.waves.map((w) => (w.Harmonics ? ["setHarmonicWave", w.name, w.real, w.imag] : ["setSampleWave", w.name, w.samples || lfsr(w.SamplesGenerator.lfsr)]))
  .concat([["setSampleWave", "nS256", S256]]);
const SAMPLES = Object.fromEntries(REGISTER.filter((c) => c[0] === "setSampleWave").map((c) => [c[1], c[2]]));

/* D-027, written from the formula: k, the held frames plus the guard frame (the first sample again; tasks/T11.md) and the home pitch. */
function held(samples, sr) {
  const n = samples.length, k = Math.max(1, Math.round(sr / (440 * n)));
  const frames = new Float32Array(n * k + 1);
  for (let j = 0; j < n * k; ++j) frames[j] = samples[Math.floor(j / k)];
  frames[n * k] = samples[0];
  return { k, frames, base: sr / (n * k) };
}
/* Cyclic runs of equal consecutive samples, starting at a run boundary: [{v, n}]. */
function runsOf(samples) {
  const s = samples.map(Math.fround);
  let start = 0;
  while (start < s.length && s[start] === s[(start + s.length - 1) % s.length]) ++start;
  if (start === s.length) return [{ v: s[0], n: s.length }];
  const out = [];
  for (let i = 0; i < s.length; ++i) {
    const v = s[(start + i) % s.length];
    if (out.length && out[out.length - 1].v === v) ++out[out.length - 1].n;
    else out.push({ v, n: 1 });
  }
  return out;
}

const hz = A.midiHz;
/* An operator held at its level (s 1) until note-off. */
const op = (w, o = {}) => Object.assign({ w, v: 1, a: 0, h: 0, d: 10, s: 1, r: 0.01 }, o);
/* Calls that play `timbre` as program 1 on channel 0: note n from ON to off. */
const melodic = (timbre, n, off) => [["setTimbre", 0, 1, timbre], ["send", [0xc0, 1]], ["noteOn", 0, n, 100, ON], ["noteOff", 0, n, off]];

/* eslint-disable no-undef -- the callbacks below run in the page */
const RENDER = async (o) => {
  const t6 = window.__t6;
  const b64 = (f) => {
    const u8 = new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  t6.seed(o.seed);
  const ctx = new OfflineAudioContext(1, Math.round(o.dur * o.sr), o.sr);
  // o.replace: start on another offline context at that rate, then install ctx with setAudioContext().
  const synth = new WebAudioTinySynth({ quality: o.quality, useReverb: 0, voices: 64, context: o.replace ? new OfflineAudioContext(1, 128, o.replace) : ctx });
  synth.setMasterVol(o.level);
  for (const c of o.before || []) synth[c[0]](...c.slice(1));
  if (o.replace) {
    t6.seed(o.seed);
    synth.setAudioContext(ctx);
  }
  for (const c of o.calls) synth[c[0]](...c.slice(1));
  const tables = {};
  for (const n of o.tables || []) tables[n] = b64(synth.noiseBuf[n].getChannelData(0));
  const buf = await ctx.startRendering();
  let disposed = null;
  if (o.dispose) {
    await synth.dispose();
    const later = [];
    for (const c of [["setSampleWave", "nLater", [0.5, -0.5]], ["setTimbre", 0, 1, [{ w: "nLater" }]], ["noteOn", 0, 60, 100]]) {
      try { synth[c[0]](...c.slice(1)); later.push("ok"); } catch (e) { later.push(e.name); }
    }
    disposed = { noiseBuf: synth.noiseBuf, wave: synth.wave, later };
  }
  await new Promise((r) => setTimeout(r, 10)); // let rejection events arrive
  return { pcm: b64(buf.getChannelData(0)), tables, disposed, rejections: t6.rejections.slice() };
};
/* eslint-enable no-undef */

const decode = (b64) => {
  const b = Buffer.from(b64, "base64");
  const copy = new ArrayBuffer(b.length);
  new Uint8Array(copy).set(b);
  return new Float32Array(copy);
};
const sha = (f32) => crypto.createHash("sha256").update(Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)).digest("hex");
function maxDiff(a, b) {
  if (a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; ++i) {
    const d = Math.abs(a[i] - b[i]);
    if (!(d <= m)) m = d; // NaN propagates
  }
  return m;
}
const seg = (x, sr, t0, t1) => x.subarray(Math.round(t0 * sr), Math.round(t1 * sr));
const median = (a) => {
  const s = Float64Array.from(a).sort();
  return s.length ? s[s.length >> 1] : NaN;
};

/* Pitch of the note in [t0, t1) near f, and its amplitude. */
function pitch(x, sr, t0, t1, f) {
  const p = A.peakFrequency(x, sr, { start: t0, duration: t1 - t0, fmin: f * Math.pow(2, -1.5 / 12), fmax: f * Math.pow(2, 1.5 / 12) });
  return { cents: p ? A.cents(p.freq, f) : NaN, amp: A.rms(x, Math.round(t0 * sr), Math.round(t1 * sr)) * Math.SQRT2 };
}

/*
 * Rate-1 playback of a table: runs of equal output frames (a change is a jump
 * of more than a quarter of the smallest level step) over [t0, t1), first and
 * last runs dropped, against the table's cyclic runs x k. Returns
 * {ok, measured: first runs, expected}.
 */
function homeRuns(x, sr, t0, t1, samples, k) {
  const w = seg(x, sr, t0, t1);
  const levels = [...new Set(samples.map(Math.fround))].sort((a, b) => a - b);
  let step = Infinity;
  for (let i = 1; i < levels.length; ++i) step = Math.min(step, levels[i] - levels[i - 1]);
  const scale = A.peak(w) / Math.max(...samples.map(Math.abs));
  const eps = step * scale / 4;
  const runs = [];
  let start = 0;
  for (let j = 1; j < w.length; ++j) if (Math.abs(w[j] - w[j - 1]) > eps) { runs.push(j - start); start = j; }
  const inner = runs.slice(1);
  const expected = runsOf(samples).map((r) => r.n * k);
  let ok = inner.length >= expected.length * 3;
  for (let off = 0; off < expected.length && ok; ++off) {
    if (inner.every((n, i) => n === expected[(off + i) % expected.length])) return { ok: true, runs: inner.length, measured: inner.slice(0, 8), expected: expected.slice(0, 8) };
  }
  return { ok: false, runs: inner.length, measured: inner.slice(0, 16), expected: expected.slice(0, 16) };
}

/*
 * Edges of a sounding 12.5 % pulse (one high sample of 8) at frequency f over
 * [t0, t1): midpoint crossings, their spacings against sr / (f 8) (high) and
 * 7 sr / (f 8) (low), and the frames per edge that differ from an independent
 * sample-and-hold reference (phase fitted to the rising crossings) by more
 * than 10 % of the step.
 */
function pulseEdges(x, sr, t0, t1, f) {
  const w = seg(x, sr, t0, t1);
  const hi = median(w.filter((v) => v > 0)), lo = median(w.filter((v) => v < 0)), mid = (hi + lo) / 2;
  const rise = [], fall = [];
  for (let j = 1; j < w.length; ++j) {
    const a = w[j - 1] - mid, b = w[j] - mid;
    if (a < 0 && b >= 0) rise.push(j - 1 + a / (a - b));
    else if (a >= 0 && b < 0) fall.push(j - 1 + a / (a - b));
  }
  const width = sr / (f * 8), period = sr / f;
  let worst = 0;
  for (const r of rise) {
    const fl = fall.find((v) => v > r), nr = rise.find((v) => v > r);
    if (fl !== undefined) worst = Math.max(worst, Math.abs(fl - r - width));
    if (fl !== undefined && nr !== undefined) worst = Math.max(worst, Math.abs(nr - fl - 7 * width));
  }
  // Reference: high for the first `width` frames of each period after phase p0 (fitted to the rising crossings).
  const p0 = A.mean(rise.map((r) => r - Math.round((r - rise[0]) / period) * period));
  let off = 0;
  for (let j = 0; j < w.length; ++j) {
    const ph = (j - p0) / period - Math.floor((j - p0) / period);
    if (Math.abs(w[j] - (ph * 8 < 1 ? hi : lo)) > 0.1 * (hi - lo)) ++off;
  }
  const offPerEdge = off / (rise.length + fall.length);
  return { edges: rise.length + fall.length, worstSpacing: worst, offPerEdge, width, fraction: offPerEdge / width };
}

/* Level of harmonic m of f relative to the fundamental, in dB (Blackman-Harris window, exact-frequency DFT). */
function harmonicDb(x, sr, t0, f, ms) {
  const w = seg(x, sr, t0, t0 + 1);
  const n = w.length, win = new Float64Array(n);
  for (let i = 0; i < n; ++i) {
    const p = 2 * Math.PI * i / (n - 1);
    win[i] = 0.35875 - 0.48829 * Math.cos(p) + 0.14128 * Math.cos(2 * p) - 0.01168 * Math.cos(3 * p);
  }
  const mag = (fr) => {
    let re = 0, im = 0;
    for (let i = 0; i < n; ++i) {
      const ph = 2 * Math.PI * fr * i / sr;
      re += w[i] * win[i] * Math.cos(ph);
      im -= w[i] * win[i] * Math.sin(ph);
    }
    return Math.hypot(re, im);
  };
  const m1 = mag(f);
  return ms.map((m) => A.db(mag(m * f) / m1));
}

/* The song's channel messages as send() calls at their times (120 BPM, starting at ON). */
function songCalls() {
  const s = smf.read(SONG);
  const secs = (tick) => ON + tick / s.division * 0.5;
  const out = [];
  for (const tr of s.tracks) for (const e of tr.events) if (e.status < 0xf0) out.push({ t: secs(e.tick), m: [e.status, ...e.data] });
  out.sort((a, b) => a.t - b.t);
  return { calls: out.map((e) => ["send", e.m, e.t]), end: secs(s.endTick) };
}

function cases(shared) {
  const { matrix, options, engine } = shared;
  const tol = tolerances(engine);
  const edgeTol = WAVES.edgeFraction[engine];
  const out = [];
  for (const quality of matrix.qualities) {
    for (const sr of matrix.sampleRates) {
      const tag = "q" + quality + " " + sr;
      out.push({
        id: "waves " + tag,
        dims: { quality, sampleRate: sr },
        deadline: 400,
        run: async (t) => {
          const seed = options.seed;
          const pg = {};
          for (const build of matrix.builds) {
            pg[build] = await t.newPage({ offline: true });
            await pg[build].page.setContent(pages.inlinePage({ library: pages.readLibrary(build, options.overrides), seed }));
          }
          const problems = { nonFinite: [], rejections: [] };
          const reconciled = [], parity = [];
          let renders = 0;
          const once = async (build, o) => {
            ++renders;
            const r = await pg[build].page.evaluate(RENDER, Object.assign({ seed, sr, quality, level: LEVEL }, o));
            const x = decode(r.pcm);
            const nf = A.nonFinite(x);
            if (nf.nan || nf.inf) problems.nonFinite.push(o.label + "/" + build);
            if (r.rejections.length) problems.rejections.push(o.label + "/" + build + ": " + r.rejections.map((e) => e.message).join("; "));
            return { x, tables: Object.fromEntries(Object.entries(r.tables).map(([k, v]) => [k, decode(v)])), disposed: r.disposed };
          };
          /*
           * Renders o with both builds: the source render, with the min render as .min. They must
           * agree within the same-engine tolerance. As in render.js, a difference that does not
           * reproduce (WebKit's occasional glitch) is re-rendered at most twice per side and
           * reconciled when a source and a min render agree, at most 3 times per case, recorded.
           */
          const render = async (o) => {
            let a = await once("source", o), b = await once("min", o), d = maxDiff(a.x, b.x);
            if (!(d <= tol.sameEngineSample) && reconciled.length < 3) {
              const As = [a], Bs = [b];
              for (let i = 0; i < 2 && !(d <= tol.sameEngineSample); ++i) {
                As.push(await once("source", o));
                Bs.push(await once("min", o));
                const pair = As.flatMap((x) => Bs.map((y) => [x, y])).find(([x, y]) => maxDiff(x.x, y.x) <= tol.sameEngineSample);
                if (pair) {
                  reconciled.push({ part: o.label, maxDiff: d, renders: As.length + Bs.length });
                  [a, b] = pair;
                  d = maxDiff(a.x, b.x);
                }
              }
            }
            parity.push([o.label, d]);
            return Object.assign(a, { min: b });
          };
          const measurements = {};

          // ---- generated tables, and pitch at A4 for every table size ----
          const names = Object.keys(SAMPLES);
          const reg = await render({ label: "tables", dur: 0.1, calls: REGISTER, tables: names });
          const tableHashes = {}, tableProblems = [];
          for (const name of names) {
            const want = held(SAMPLES[name], sr).frames;
            tableHashes[name] = sha(reg.tables[name]);
            if (tableHashes[name] !== sha(want)) tableProblems.push(name);
          }
          for (const name of names) if (sha(reg.min.tables[name]) !== tableHashes[name]) tableProblems.push(name + " (min)");
          t.check("each sample wave's buffer is D-027's held table, bit for bit, in both builds (" + names.length + " tables, incl. 32,767 steps)", !tableProblems.length,
            tableProblems.length ? tableProblems.join(", ") : names.map((n) => n + " " + SAMPLES[n].length + "x" + held(SAMPLES[n], sr).k).join(", "));
          t.observe("table sha256 (Float32 data) @" + sr, tableHashes);

          const pitchItems = [["nP12", 69], ["nSAW", 69], ["nTRI", 69], ["nBTRI", 69], ["nMET", 69], ["nS256", 69], ["nBTRI", 45], ["nBTRI", 60], ["nBTRI", 81], ["nP12", 45], ["nP12", 60], ["nP12", 81]];
          const pitchRes = [];
          for (const [name, n] of pitchItems) {
            const r = await render({ label: "pitch " + name + " " + n, dur: 1.4, calls: [...REGISTER.filter((c) => c[1] === name), ...melodic([op(name)], n, 1.35)] });
            const p = pitch(r.x, sr, ON + 0.1, ON + 1.1, hz(n));
            pitchRes.push({ name, n, N: SAMPLES[name].length, cents: +p.cents.toFixed(5), amp: +p.amp.toFixed(4) });
          }
          const badPitch = pitchRes.filter((p) => !(Math.abs(p.cents) <= WAVES.pitchCents) || !(p.amp >= tol.noteAmpMin));
          t.check("8-, 16-, 32-, 64-, 93- and 256-sample tables sound at the note within " + WAVES.pitchCents + " cent (A4; A2, C4, A5 for 8 and 64)", !badPitch.length,
            (badPitch.length ? "off: " + JSON.stringify(badPitch) + "; " : "") + "max |cents| " + Math.max(...pitchRes.map((p) => Math.abs(p.cents))).toFixed(5));
          const a4 = pitchRes.find((p) => p.name === "nBTRI" && p.n === 69);
          t.check("the 64-step 4-bit triangle at A4 measures 440 Hz within 1 cent", Math.abs(a4.cents) <= 1, a4.cents.toFixed(5) + " cents");
          measurements.pitch = pitchRes;

          // ---- steps at the home pitch, edges elsewhere ----
          const steps = [];
          for (const name of ["nBTRI", "nP12", "nTRI"]) {
            const h = held(SAMPLES[name], sr);
            const r = await render({ label: "home " + name, dur: 0.9, calls: [...REGISTER.filter((c) => c[1] === name), ...melodic([op(name, { t: 0, f: h.base })], 60, 0.85)] });
            steps.push(Object.assign({ name, k: h.k, base: h.base }, homeRuns(r.x, sr, ON + 0.05, ON + 0.55, SAMPLES[name], h.k)));
          }
          t.check("at the home pitch every table sample lasts exactly k frames", steps.every((s) => s.ok),
            steps.map((s) => s.name + " k=" + s.k + (s.ok ? " ok (" + s.runs + " runs)" : " got " + s.measured.join(",") + " want " + s.expected.join(","))).join("; "));
          measurements.home = steps.map(({ name, k, base, ok, runs }) => ({ name, k, base, ok, runs }));
          const edges = [];
          for (const n of [57, 69, 76]) {
            const r = await render({ label: "edges " + n, dur: 0.9, calls: [...REGISTER.filter((c) => c[1] === "nP12"), ...melodic([op("nP12")], n, 0.85)] });
            edges.push(Object.assign({ n }, pulseEdges(r.x, sr, ON + 0.05, ON + 0.55, hz(n))));
          }
          t.check("away from the home pitch, the 12.5 % pulse's steps are sr/(f N) frames wide +-" + WAVES.stepFrames, edges.every((e) => e.worstSpacing <= WAVES.stepFrames && e.edges > 50),
            edges.map((e) => "note " + e.n + ": width " + e.width.toFixed(2) + ", worst " + e.worstSpacing.toFixed(3) + " (" + e.edges + " edges)").join("; "));
          t.check("edges stay sharp: frames per edge off the sample-and-hold reference <= " + edgeTol + " of a step", edges.every((e) => e.fraction <= edgeTol),
            edges.map((e) => "note " + e.n + ": " + e.offPerEdge.toFixed(3) + " frames, " + e.fraction.toFixed(4) + " of " + e.width.toFixed(2)).join("; "));
          measurements.edges = edges.map((e) => ({ n: e.n, width: +e.width.toFixed(3), worstSpacing: +e.worstSpacing.toFixed(4), offPerEdge: +e.offPerEdge.toFixed(4), fraction: +e.fraction.toFixed(5), edges: e.edges }));

          // ---- pitch envelope (drum override) and FM ----
          const kick = [op("nBTRI", { t: 0, f: 160, p: 0.28, q: 0.03, d: 1 })];
          const env = await render({ label: "pitch envelope", dur: 2.1, calls: [...REGISTER.filter((c) => c[1] === "nBTRI"), ["setTimbre", 1, 36, kick], ["noteOn", 9, 36, 100, ON]] });
          const envP = pitch(env.x, sr, ON + 0.6, ON + 1.6, 160 * 0.28);
          t.check("a drum override's pitch envelope (p 0.28 from 160 Hz) settles at 44.8 Hz within " + WAVES.pitchCents + " cent", Math.abs(envP.cents) <= WAVES.pitchCents && envP.amp >= tol.noteAmpMin,
            envP.cents.toFixed(5) + " cents, amplitude " + envP.amp.toFixed(4));
          const fm = {};
          for (const w of ["nBTRI", "triangle"]) {
            const r = await render({ label: "fm " + w, dur: 1.4, calls: [...REGISTER.filter((c) => c[1] === w), ["setSampleWave", "nSQ", [1, -1]],
              ...melodic([op(w), op("nSQ", { g: 1, t: 0, f: 1, v: 0.02 })], 69, 1.35)] });
            fm[w] = [pitch(r.x, sr, ON + 0.1, ON + 0.4, 440).cents, pitch(r.x, sr, ON + 0.6, ON + 0.9, 440).cents];
          }
          const want = [1200 * Math.log2(1.02), 1200 * Math.log2(0.98)];
          const fmOk = ["nBTRI", "triangle"].every((w) => fm[w].every((c, i) => Math.abs(c - want[i]) <= WAVES.fmCents)) && fm.nBTRI.every((c, i) => Math.abs(c - fm.triangle[i]) <= WAVES.fmCents);
          t.check("FM on a sample wave gives the oscillator's depth in cents (1200 log2(1 +- 0.02))", fmOk,
            "sample wave " + fm.nBTRI.map((c) => c.toFixed(4)).join("/") + ", triangle " + fm.triangle.map((c) => c.toFixed(4)).join("/") + ", expected " + want.map((c) => c.toFixed(4)).join("/"));
          measurements.envelope = +envP.cents.toFixed(5);
          measurements.fm = { nBTRI: fm.nBTRI.map((c) => +c.toFixed(5)), triangle: fm.triangle.map((c) => +c.toFixed(5)), expected: want.map((c) => +c.toFixed(5)) };

          // ---- harmonic waves ----
          const organ = fixtureWave("wOrgan");
          const org = await render({ label: "harmonics", dur: 1.6, calls: [...REGISTER.filter((c) => c[1] === "wOrgan"), ...melodic([op("wOrgan")], 69, 1.55)] });
          const ms = organ.imag.map((v, i) => i).slice(2);
          const got = harmonicDb(org.x, sr, ON + 0.2, 440, ms);
          const hBad = ms.filter((m, i) => {
            const c = organ.imag[m] / organ.imag[1];
            return c ? Math.abs(got[i] - A.db(c)) > WAVES.harmonicDb : got[i] > WAVES.harmonicFloorDb;
          });
          t.check("a harmonic wave's harmonics have its coefficients' levels (+-" + WAVES.harmonicDb + " dB; zero below " + WAVES.harmonicFloorDb + " dB)", !hBad.length,
            ms.map((m, i) => m + ": " + got[i].toFixed(3)).join(", "));
          measurements.harmonics = Object.fromEntries(ms.map((m, i) => [m, +got[i].toFixed(4)]));
          // Review M1: coefficients that are finite as floats but extreme (3e38, a lone subnormal) rendered
          // NaN, and Firefox kept the NaN for later notes. The engine scales them by a power of two.
          const extreme = await render({ label: "extreme harmonics", dur: 1.6, calls: [
            ["setHarmonicWave", "wBig", [0, 0, 0, 0], [0, 3e38, -3e38, 3e38]], ["setHarmonicWave", "wTiny", [0, 0], [0, 1e-44]],
            ["setTimbre", 0, 1, [op("wBig")]], ["setTimbre", 0, 2, [op("wTiny")]],
            ["send", [0xc0, 1]], ["noteOn", 0, 69, 100, ON], ["noteOff", 0, 69, 0.55],
            ["send", [0xc1, 2]], ["noteOn", 1, 69, 100, 0.65], ["noteOff", 1, 69, 0.95],
            ["send", [0xc2, 1]], ["setTimbre", 0, 3, [op("sine")]], ["send", [0xc2, 3]], ["noteOn", 2, 72, 100, 1.1], ["noteOff", 2, 72, 1.4]] });
          const exNf = A.nonFinite(extreme.x), exPeaks = [[ON, 0.55], [0.65, 0.95], [1.1, 1.4]].map(([a, b]) => A.peak(seg(extreme.x, sr, a, b)));
          t.check("extreme harmonic coefficients (3e38, 1e-44) render finite audio, and a later note stays finite (review M1)", !exNf.nan && !exNf.inf && exPeaks.every((p) => p > tol.audiblePeak),
            JSON.stringify(exNf) + ", peaks " + exPeaks.map((p) => p.toFixed(4)).join("/"));
          const nine = await render({ label: "wNine", dur: 0.8, calls: [["setHarmonicWave", "wNine", [0, 0, 0, 0, 0], [0, 9, 9, 9, 9]], ...melodic([op("wNine")], 69, 0.7)] });
          const w9999 = await render({ label: "w9999", dur: 0.8, calls: melodic([op("w9999")], 69, 0.7) });
          const d9 = maxDiff(nine.x, w9999.x);
          t.check("w9999's coefficients registered under a new name render as w9999", d9 <= tol.sameEngineSample && A.peak(nine.x) > tol.audiblePeak, "max |diff| " + d9.toExponential(3));

          // ---- the registry across contexts, setQuality(), re-registration, dispose() ----
          const tri = REGISTER.filter((c) => c[1] === "nBTRI"), pulse = REGISTER.filter((c) => c[1] === "nP12");
          const play = melodic([op("nBTRI")], 69, 0.7);
          const direct = await render({ label: "direct", dur: 0.8, calls: [...tri, ...play] });
          const replaced = await render({ label: "replaced", dur: 0.8, replace: sr === 44100 ? 48000 : 44100, before: tri, calls: play, tables: ["nBTRI"] });
          const dRep = maxDiff(direct.x, replaced.x);
          t.check("waves registered before setAudioContext() are rebuilt for the new rate and render as if registered on it", dRep <= tol.sameEngineSample && sha(replaced.tables.nBTRI) === sha(held(SAMPLES.nBTRI, sr).frames),
            "max |diff| " + dRep.toExponential(3) + ", table " + replaced.tables.nBTRI.length + " frames");
          const requal = await render({ label: "setQuality", dur: 0.8, calls: [...tri, ["setTimbre", 0, 1, [op("nBTRI")]], ["setQuality", 1 - quality], ["setQuality", quality], ...play] });
          const dQ = maxDiff(direct.x, requal.x);
          t.check("the registry survives setQuality() (timbre reinstalled): same render", dQ <= tol.sameEngineSample, "max |diff| " + dQ.toExponential(3));
          const rereg = await render({ label: "re-register", dur: 1.3, calls: [["setSampleWave", "nW", SAMPLES.nBTRI], ["setTimbre", 0, 1, [op("nW")]], ["send", [0xc0, 1]],
            ["noteOn", 0, 69, 100, ON], ["noteOff", 0, 69, 0.6], ["setSampleWave", "nW", SAMPLES.nP12], ["noteOn", 0, 69, 100, 0.8], ["noteOff", 0, 69, 1.2]] });
          const second = await render({ label: "re-register reference", dur: 1.3, calls: [...pulse, ["setTimbre", 0, 1, [op("nP12")]], ["send", [0xc0, 1]], ["noteOn", 0, 69, 100, 0.8], ["noteOff", 0, 69, 1.2]] });
          const dFirst = maxDiff(seg(rereg.x, sr, 0, 0.6), seg(direct.x, sr, 0, 0.6));
          const dSecond = maxDiff(seg(rereg.x, sr, 0.85, 1.15), seg(second.x, sr, 0.85, 1.15)) / A.peak(seg(second.x, sr, 0.85, 1.15));
          t.check("re-registering keeps the sounding voice's wave; the next note plays the new one", dFirst <= tol.sameEngineSample && dSecond <= WAVES.rereg,
            "first note max |diff| " + dFirst.toExponential(3) + ", second note " + dSecond.toExponential(3) + " of its peak");
          const disp = await render({ label: "dispose", dur: 0.3, calls: tri, dispose: true });
          t.check("dispose() releases the context's waves; later calls are safe no-ops", disp.disposed.noiseBuf === null && disp.disposed.wave === null && disp.disposed.later.every((v) => v === "ok"),
            JSON.stringify(disp.disposed));
          const builtins = [["send", [0xc0, 119]], ["noteOn", 0, 60, 100, ON], ["noteOff", 0, 60, 1.6], ["noteOn", 9, 38, 100, 0.4], ["noteOn", 9, 42, 100, 0.6], ["noteOn", 9, 49, 100, 0.8]];
          const plain = await render({ label: "n0/n1", dur: 1.8, calls: builtins });
          const withReg = await render({ label: "n0/n1 with waves", dur: 1.8, calls: [...REGISTER, ...builtins] });
          const dB = maxDiff(plain.x, withReg.x);
          t.check("registering waves leaves n0/n1 timbres (program 119, drums 38, 42, 49) unchanged", dB <= tol.sameEngineSample && A.peak(plain.x) > tol.audiblePeak, "max |diff| " + dB.toExponential(3));

          // ---- the pinned consumer setup ----
          const song = songCalls();
          const setup = [["setQuality", quality], ["setMasterVol", LEVEL], ["setVoices", 64], ...REGISTER.filter((c) => c[1] !== "nS256"),
            ...FIXTURE.timbres.map((tb) => ["setTimbre", tb.drum ? 1 : 0, tb.slot, tb.operators])];
          const fx = await render({ label: "consumer fixture", dur: song.end + 1, calls: [...setup, ...song.calls] });
          const beats = [];
          for (let b = 0; b < 16; ++b) beats.push(A.peak(seg(fx.x, sr, ON + b * 0.5, ON + (b + 1) * 0.5)));
          t.check("the consumer setup (" + FIXTURE.waves.length + " waves, " + FIXTURE.timbres.length + " timbres) plays its song audibly in every beat", beats.every((p) => p >= tol.audiblePeak),
            "min beat peak " + Math.min(...beats).toFixed(4) + ", whole peak " + A.peak(fx.x).toFixed(4));
          if (t.out) {
            t.save("waves/" + tag.replace(" ", "-") + "/consumer-fixture.wav", A.wav([fx.x, fx.x], sr));
            t.save("waves/" + tag.replace(" ", "-") + "/rereg.wav", A.wav([rereg.x, rereg.x], sr));
          }

          // ---- every render ----
          const worst = parity.reduce((m, [, d]) => (d > m || d !== d ? d : m), 0);
          t.check("min renders the same PCM as source (max |diff| <= " + tol.sameEngineSample + ")", worst <= tol.sameEngineSample,
            "worst " + worst.toExponential(3) + " over " + parity.length + " items" + (reconciled.length ? "; reconciled " + JSON.stringify(reconciled) : ""));
          t.check("every render is finite", !problems.nonFinite.length, problems.nonFinite.join(", "));
          t.check("no unhandled rejections", !problems.rejections.length, problems.rejections.slice(0, 2).join(" | "));
          const errors = Object.values(pg).flatMap((p) => p.pageErrors);
          t.check("no page errors, no requests", !errors.length && Object.values(pg).every((p) => !p.aborted.length), errors.slice(0, 2).join(" | "));
          if (reconciled.length) t.observe("reconciled same-engine differences", reconciled);
          t.observe("measurements", Object.assign(measurements, { renders }));
        },
      });
    }
  }
  return out;
}

module.exports = { cases, WAVES, held, runsOf, homeRuns, pulseEdges };
