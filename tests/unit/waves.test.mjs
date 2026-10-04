/*
 * The waveform registry (#26): setHarmonicWave() and setSampleWave() under
 * D-006, D-021, D-027 (held storage) and D-028 (natural limits only), on the
 * mock WebAudio of tests/harness.js. The rendered-audio checks are in
 * tests/browser/specs/waves.js.
 *
 * Expected tables come from heldTable() below, written from D-027's formula,
 * not from the library: each of the N samples is held for
 * k = max(1, round(sampleRate / (440 N))) frames, and the home pitch is
 * sampleRate / (N k). One guard frame (the first sample again) follows the
 * N k frames, and notes loop only those (loopEnd = N k / sampleRate): a
 * Chromium loop-seam workaround (tasks/T11.md).
 */
import vm from "node:vm";
import { describe, expect, test } from "vitest";
import { H, variants, noteHz } from "./helpers.mjs";

const calls = (trace, from = 0) => trace.slice(from).map((line) => JSON.parse(line));

/* The error `fn` throws (from the library's realm, so read by name and message), or null. */
function thrown(fn) {
  try {
    fn();
  } catch (e) {
    return { name: e.name, message: e.message };
  }
  return null;
}

/* D-027: {k, frames (with the guard frame), loop (seconds), base} for a table at a sample rate, as Float32 data. */
function heldTable(samples, sr) {
  const n = samples.length, k = Math.max(1, Math.round(sr / (440 * n)));
  const frames = new Float32Array(n * k + 1);
  for (let j = 0; j < n * k; ++j) frames[j] = samples[Math.floor(j / k)];
  frames[n * k] = samples[0];
  return { k, frames, loop: n * k / sr, base: sr / (n * k) };
}

/* A 64-sample 4-bit triangle, as Beast chip.js builds it: 32 levels, two samples each, scaled by 0.6. */
const TRI64 = [...Array.from({ length: 16 }, (_, i) => 15 - i), ...Array.from({ length: 16 }, (_, i) => i)].flatMap((v) => [v / 7.5 - 1, v / 7.5 - 1]).map((v) => v * 0.6);
const PULSE8 = [0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5];
function lfsr(len, tap) {
  const out = [];
  let r = 1;
  for (let i = 0; i < len; ++i) {
    const fb = (r & 1) ^ ((r >> tap) & 1);
    r = (r >> 1) | (fb << 14);
    out.push(r & 1 ? 0.5 : -0.5);
  }
  return out;
}

/* A synth in a fresh mock environment: {synth, env, trace, Ctx}; Ctx(sr) makes another mock context. */
function make(variant, opts) {
  const trace = [];
  const env = H.createEnvironment(trace);
  vm.runInContext(variant.source, env.sandbox, { filename: variant.name });
  const Base = env.sandbox.AudioContext;
  const synth = new env.sandbox.WebAudioTinySynth(opts);
  const Ctx = (sr = 44100) => {
    const c = new Base();
    c.sampleRate = sr;
    return c;
  };
  return { synth, env, trace, Ctx };
}

/* The sources a call made, with their buffer, rate, loop end (read from the node: the mock does not record it), pitch-envelope target and FM inputs. */
function sourcesBy(s, act) {
  const from = s.trace.length;
  act(s.synth);
  const byId = new Map(), gainValue = new Map(), into = [];
  for (const [op, id, ...a] of calls(s.trace, from)) {
    if (op === "create" && /^(osc|src)#/.test(id)) byId.set(id, { id, buffer: null, rate: undefined, freq: undefined, target: undefined, wave: null, fm: [] });
    const owner = byId.get(String(id).split(".")[0]);
    if (op === "buffer" && byId.has(id)) byId.get(id).buffer = a[0];
    if (op === "setPeriodicWave" && byId.has(id)) byId.get(id).wave = a[0];
    if (op === "value" && /\.playbackRate$/.test(id) && owner) owner.rate = a[0];
    if (op === "value" && /\.frequency$/.test(id) && owner) owner.freq = a[0];
    if (op === "setTargetAtTime" && /\.(playbackRate|frequency)$/.test(id) && owner) owner.target = a[0];
    if (op === "setValueAtTime" && /^gain#\d+\.gain$/.test(id) && !gainValue.has(id.split(".")[0])) gainValue.set(id.split(".")[0], a[0]);
    if (op === "connect" && /\.(playbackRate|frequency)$/.test(a[0])) into.push([id, a[0]]);
  }
  for (const [g, param] of into) {
    const target = byId.get(param.split(".")[0]);
    if (target) target.fm.push(gainValue.get(g));
  }
  const nodes = new Map([...s.synth.notetab, ...s.synth._src].flatMap((v) => v.o.map((o) => [o._id, o])));
  for (const x of byId.values()) x.loopEnd = nodes.has(x.id) ? nodes.get(x.id).loopEnd : "untracked";
  return [...byId.values()].filter((x) => x.freq !== 0);
}

const lead = (w, o = {}) => [Object.assign({ w, v: 0.5, a: 0, h: 0, d: 0.1, s: 1, r: 0.05 }, o)];

describe.each(variants)("$name: registering waves (#26)", (variant) => {
  test("valid names register; reserved, malformed and wrongly prefixed names throw a TypeError and change nothing", () => {
    const s = make(variant);
    const ok = ["nA", "n_", "nTRI", "n" + "a".repeat(31), "nA1_b2", "n__proto__", "nconstructor", "nhasOwnProperty"];
    for (const name of ok) expect(thrown(() => s.synth.setSampleWave(name, [0.5, -0.5]))).toBe(null);
    for (const name of ["wA", "w_", "wOrgan", "w" + "Z".repeat(31), "w__proto__", "wconstructor"])
      expect(thrown(() => s.synth.setHarmonicWave(name, [0, 0], [0, 1]))).toBe(null);
    const before = [...s.synth._wv.keys()];
    const from = s.trace.length;
    const badSample = ["n0", "n1", "n9", "n0x", "n", "", "N1", "xA", "wA", "nA-b", "na b", "n" + "a".repeat(32), "nA\n", "nÄ", "n.a",
      5, null, undefined, ["nA"], { toString: () => "nA" }];
    for (const name of badSample) expect(thrown(() => s.synth.setSampleWave(name, [0.5]))).toMatchObject({ name: "TypeError" });
    for (const name of ["w9999", "w1", "w0abc", "w", "nA", "W9", "wA b", "w" + "a".repeat(32), 9999])
      expect(thrown(() => s.synth.setHarmonicWave(name, [0, 0], [0, 1]))).toMatchObject({ name: "TypeError" });
    expect(thrown(() => s.synth.setSampleWave("n0", [0.5]))).toEqual({ name: "TypeError", message: "wave name: n0" });
    expect([...s.synth._wv.keys()]).toEqual(before);
    expect(s.trace.slice(from)).toEqual([]);
    expect(Object.getOwnPropertyNames(Object.prototype).some((k) => k[0] === "n" || k[0] === "w")).toBe(false);
  });

  test("samples: a non-empty array or typed array of numbers in [-1, 1], with no upper bound", () => {
    const s = make(variant);
    const accepted = [[0.25], [-1, 1], new Float32Array([0.5, -0.5]), new Float64Array([1, -1, 0]), new Int8Array([1, 0, -1]), lfsr(32767, 1)];
    for (const a of accepted) expect(thrown(() => s.synth.setSampleWave("nX", a))).toBe(null);
    const range = [[], [1.0000001], [-1.0000001], [NaN], [Infinity], ["0.5"], [0.5, , 0.5], [0.5, undefined], [null], [5n], new Int8Array([-128]), [true]]; // eslint-disable-line no-sparse-arrays -- a hole is not a number
    for (const a of range) expect(thrown(() => s.synth.setSampleWave("nY", a))).toEqual({ name: "RangeError", message: "samples: an array of numbers in [-1, 1]" });
    for (const a of [null, undefined, "abc", 0.5, { length: 1, 0: 0.5 }, new ArrayBuffer(8), new Set([0.5])])
      expect(thrown(() => s.synth.setSampleWave("nY", a))).toMatchObject({ name: "TypeError" });
    expect(s.synth._wv.has("nY")).toBe(false);
    expect(s.synth.noiseBuf.nY).toBe(undefined);
  });

  test("harmonics: equal-length arrays of 2 or more numbers that are finite as floats, with no upper bound", () => {
    const s = make(variant);
    const long = Array.from({ length: 5000 }, (_, i) => (i ? 1 / i : 0));
    for (const [re, im] of [[[0, 0], [0, 1]], [[0, 1, 0], [0, 0, 1]], [new Float64Array(3), new Float32Array([0, 1, 1])], [long, long], [[0, -3e38], [0, 3e38]]])
      expect(thrown(() => s.synth.setHarmonicWave("wX", re, im))).toBe(null);
    const msg = "real, imag: equal-length arrays of >= 2 finite numbers";
    for (const [re, im] of [[[0], [0]], [[], []], [[0, 0], [0, 0, 1]], [[0, NaN], [0, 1]], [[0, 1], [0, Infinity]], [[0, 1e300], [0, 1]], [[0, 1], [0, -4e38]], [[0, "1"], [0, 1]], [[0, 1, 1], [0, , 1]]]) // eslint-disable-line no-sparse-arrays -- a hole is not a number
      expect(thrown(() => s.synth.setHarmonicWave("wY", re, im))).toEqual({ name: "RangeError", message: msg });
    for (const [re, im] of [[null, [0, 1]], [[0, 1], "01"], [{ length: 2 }, [0, 1]], [[0, 1]]])
      expect(thrown(() => s.synth.setHarmonicWave("wY", re, im))).toEqual({ name: "TypeError", message: msg });
    expect(s.synth._wv.has("wY")).toBe(false);
    expect(s.synth.wave.wY).toBe(undefined);
  });

  test("a harmonic wave is built with createPeriodicWave(real, imag), DC forced to 0, default normalization", () => {
    const s = make(variant);
    const from = s.trace.length;
    s.synth.setHarmonicWave("wOrgan", [7, 0.25, 0], [-3, 1, 0.5]);
    expect(calls(s.trace, from)).toEqual([["createPeriodicWave", expect.any(String), [0, 0.25, 0], [0, 1, 0.5]]]);
    // The w9999 built-in's coefficients (T0 §7) give the same call as the built-in itself.
    const t2 = s.trace.length;
    s.synth.setHarmonicWave("wNine", [0, 0, 0, 0, 0], [0, 9, 9, 9, 9]);
    const builtin = calls(s.trace).find((c) => c[0] === "createPeriodicWave");
    expect(calls(s.trace, t2)[0].slice(2)).toEqual(builtin.slice(2));
  });

  test("extreme harmonic magnitudes are scaled by a power of two before createPeriodicWave (review M1); ordinary ones are not", () => {
    const s = make(variant);
    const call = (re, im) => {
      const from = s.trace.length;
      s.synth.setHarmonicWave("wX", re, im);
      return calls(s.trace, from).find((c) => c[0] === "createPeriodicWave").slice(2);
    };
    for (const [re, im] of [[[0, 0], [0, 3e38]], [[0, 0, 0, 0], [0, 3e38, -3e38, 3e38]], [[0, -2e36], [0, 1]], [[0, 0], [0, 1e-44]], [[0, 0], [0, 1e-40]], [[0, 1e-12], [0, -3e-12]], [[0, 2e9], [0, 0]]]) {
      const [r2, i2] = call(re, im);
      const peak = Math.max(...r2.map(Math.abs), ...i2.map(Math.abs));
      expect(peak >= 0.5 && peak < 2 && r2.concat(i2).every(Number.isFinite)).toBe(true);
      // An exact power of two: the ratios are kept (up to float rounding of the input).
      const k = Math.max(...re.map(Math.abs), ...im.map(Math.abs)) / peak;
      expect(Math.log2(Math.abs(Math.fround(re.concat(im).find((v, j) => j % re.length && v) || 1) / (r2.concat(i2).find((v, j) => j % re.length && v) || 1)))).toBe(Math.round(Math.log2(k)));
    }
    for (const [re, im] of [[[0, 0], [0, 1e9]], [[0, 0], [0, 2e-9]], [[0, 65535], [0, 3]], [[0, 0, 0, 0, 0], [0, 9, 9, 9, 9]]])
      expect(call(re, im)).toEqual([re.map((v, j) => (j ? Math.fround(v) : 0)), im.map((v, j) => (j ? Math.fround(v) : 0))]);
    expect(call([0, 0], [0, 0])).toEqual([[0, 0], [0, 0]]); // all zero: silent, nothing to scale
  });

  test.each([44100, 48000, 22050, 96000, 44100.5])("a sample wave is stored held (D-027) at %s Hz: k, frames and contents", (sr) => {
    const s = make(variant);
    s.synth.setAudioContext(s.Ctx(sr));
    for (const n of [1, 2, 8, 16, 32, 64, 93, 100, 101, 256, 1024]) { // 32,767: below and in tests/node/waves.test.cjs
      const samples = Array.from({ length: n }, (_, i) => Math.fround(Math.sin(i * 2.3) * 0.9));
      s.synth.setSampleWave("nT" + n, samples);
      const buf = s.synth.noiseBuf["nT" + n];
      const want = heldTable(samples, sr);
      expect([buf.numberOfChannels, buf.length, buf.sampleRate]).toEqual([1, want.frames.length, sr]);
      expect(Buffer.from(buf.getChannelData(0).buffer).equals(Buffer.from(want.frames.buffer))).toBe(true);
    }
  }, 60000); // 5 s is too short on a loaded machine

  test("the issue's example values: 64-step triangle k=2/128 frames/375 Hz and 8-sample pulse k=14/112/428.6 Hz at 48 kHz (plus the guard frame)", () => {
    const s = make(variant);
    s.synth.setAudioContext(s.Ctx(48000));
    s.synth.setSampleWave("nTRI", TRI64);
    s.synth.setSampleWave("nP12", PULSE8);
    const t = s.synth.noiseBuf.nTRI, p = s.synth.noiseBuf.nP12;
    expect([t.length, t.sampleRate / (t.length - 1)]).toEqual([129, 375]);
    expect([p.length, p.sampleRate / (p.length - 1)]).toEqual([113, 48000 / 112]);
    expect(48000 / 112).toBeCloseTo(428.571, 3);
    // TinyChip's 32,767-step LFSR (D-028): k = 1 at both rates.
    s.synth.setSampleWave("nNOI", lfsr(32767, 1));
    expect(s.synth.noiseBuf.nNOI.length).toBe(32768);
  });

  test("the registry keeps copies: changing the caller's arrays later changes nothing, now or after a context change", () => {
    const s = make(variant);
    const samples = TRI64.slice(), real = [0, 0, 0], imag = [0, 1, 0.5];
    s.synth.setSampleWave("nTRI", samples);
    s.synth.setHarmonicWave("wOrg", real, imag);
    samples.fill(1);
    real[1] = 5;
    imag[2] = -1;
    const want = heldTable(TRI64, 44100).frames;
    expect(Array.from(s.synth.noiseBuf.nTRI.getChannelData(0))).toEqual(Array.from(want));
    const from = s.trace.length;
    s.synth.setAudioContext(s.Ctx(44100));
    expect(Array.from(s.synth.noiseBuf.nTRI.getChannelData(0))).toEqual(Array.from(want));
    expect(calls(s.trace, from).filter((c) => c[0] === "createPeriodicWave").map((c) => c.slice(2))).toEqual([[[0, 0, 0], [0, 1, 0.5]], [[0, 0, 0, 0, 0], [0, 9, 9, 9, 9]]]); // registry first (review L2)
    // The stored copy is not the caller's array either.
    expect(s.synth._wv.get("nTRI")[0]).not.toBe(samples);
  });

  test("re-registering replaces transactionally: invalid data keeps the old wave; sounding voices keep theirs, later notes get the new one", () => {
    const s = make(variant);
    s.synth.setSampleWave("nW", TRI64);
    s.synth.setTimbre(0, 0, lead("nW"));
    const old = s.synth.noiseBuf.nW;
    expect(thrown(() => s.synth.setSampleWave("nW", [2]))).toMatchObject({ name: "RangeError" });
    expect(s.synth.noiseBuf.nW).toBe(old);
    const [first] = sourcesBy(s, (y) => y.noteOn(0, 60, 100, 1));
    s.synth.setSampleWave("nW", PULSE8);
    const fresh = s.synth.noiseBuf.nW;
    expect(fresh).not.toBe(old);
    expect(s.synth.notetab.find((v) => v.t === 1).o[0].buffer).toBe(old); // the sounding voice is untouched
    const [second] = sourcesBy(s, (y) => y.noteOn(0, 64, 100, 1.5));
    expect([first.buffer, second.buffer]).toEqual([old._id, fresh._id]);
    expect(second.rate).toBeCloseTo(noteHz(64) / heldTable(PULSE8, 44100).base, 12);
  });
});

describe.each(variants)("$name: playing registered waves (#26)", (variant) => {
  test.each([44100, 48000])("playbackRate, pitch-envelope target and FM depth use the wave's home pitch at %s Hz", (sr) => {
    const s = make(variant);
    s.synth.setAudioContext(s.Ctx(sr));
    s.synth.setSampleWave("nTRI", TRI64);
    const base = heldTable(TRI64, sr).base;
    // A carrier on the registered wave with a pitch drop, and a 5 Hz sine modulating it.
    s.synth.setTimbre(0, 0, [Object.assign(lead("nTRI")[0], { p: 0.5, q: 0.2 }), { g: 1, w: "sine", t: 0, f: 5, v: 0.02 }]);
    const [carrier, lfo] = sourcesBy(s, (y) => y.noteOn(0, 69, 100, 1));
    expect(carrier.rate).toBeCloseTo(440 / base, 12);
    expect(carrier.loopEnd).toBe(heldTable(TRI64, sr).loop); // the N k frames, not the guard frame
    expect(carrier.target).toBeCloseTo(440 / base * 0.5, 12);
    expect(carrier.fm).toEqual([expect.closeTo(440 / base * 0.02, 12)]);
    expect(lfo.freq).toBe(5);
    // The same timbre on an oscillator: FM depth in Hz is f * v, the same relative depth.
    s.synth.setTimbre(0, 1, [Object.assign(lead("triangle")[0], { p: 0.5, q: 0.2 }), { g: 1, w: "sine", t: 0, f: 5, v: 0.02 }]);
    s.synth.send([0xc0, 1]);
    const [osc] = sourcesBy(s, (y) => y.noteOn(0, 69, 100, 2));
    expect(osc.fm[0] / osc.freq).toBeCloseTo(carrier.fm[0] / carrier.rate, 12);
    expect(osc.target / osc.freq).toBeCloseTo(carrier.target / carrier.rate, 12);
  });

  test("n0 and n1 keep the 440 Hz basis, and FM into them too", () => {
    const s = make(variant);
    s.synth.setSampleWave("nTRI", TRI64); // registering does not change the built-ins
    s.synth.setTimbre(0, 0, [{ w: "n0", t: 2, p: 0.5, q: 0.1 }, { g: 1, w: "sine", t: 0, f: 3, v: 0.5 }, { w: "n1", t: 0.5 }]);
    const [n0, , n1] = sourcesBy(s, (y) => y.noteOn(0, 60, 100, 1));
    expect(n0.rate).toBe(noteHz(60) * 2 / 440);
    expect(n0.target).toBe(noteHz(60) * 2 / 440 * 0.5);
    expect(n0.fm).toEqual([noteHz(60) * 2 / 440 * 0.5]);
    expect(n1.rate).toBe(noteHz(60) * 0.5 / 440);
    expect([n0.loopEnd, n1.loopEnd]).toEqual([undefined, undefined]); // the whole buffer loops, as before
    expect([n0.buffer, n1.buffer]).toEqual([s.synth.noiseBuf.n0._id, s.synth.noiseBuf.n1._id]);
  });

  test("a buffer written into noiseBuf directly (TinyChip's current workaround) keeps the 440 Hz basis and its whole length", () => {
    const s = make(variant);
    s.synth.noiseBuf.nDirect = s.synth.getAudioContext().createBuffer(1, 44100, 44100);
    s.synth.program[3].p = [Object.assign({}, lead("nDirect")[0], { t: 1, f: 0, g: 0, p: 1, q: 1, k: 0 })];
    s.synth.send([0xc0, 3]);
    const [o] = sourcesBy(s, (y) => y.noteOn(0, 69, 100, 1));
    expect([o.buffer, o.rate, o.loopEnd]).toEqual([s.synth.noiseBuf.nDirect._id, 1, undefined]);
  });

  test("unsupported compatibility path (D-031): setTimbre accepts a name the caller wrote into noiseBuf or wave itself, while it is there", () => {
    const s = make(variant);
    const ctx = s.synth.getAudioContext();
    s.synth.noiseBuf.nDirect = ctx.createBuffer(1, 44100, 44100);
    s.synth.wave.wDirect = ctx.createPeriodicWave([0, 0], [0, 1]);
    expect(thrown(() => s.synth.setTimbre(1, 38, [{ w: "nDirect", t: 0, f: 264 }]))).toBe(null);
    expect(thrown(() => s.synth.setTimbre(0, 3, lead("wDirect")))).toBe(null);
    const [hit] = sourcesBy(s, (y) => y.noteOn(9, 38, 100, 1));
    expect([hit.buffer, hit.rate, hit.loopEnd]).toEqual([s.synth.noiseBuf.nDirect._id, 264 / 440, undefined]); // the 440 basis, as before T11
    s.synth.send([0xc0, 3]);
    const [osc] = sourcesBy(s, (y) => y.noteOn(0, 57, 100, 1.5));
    expect(osc.wave).toBe(s.synth.wave.wDirect._id);
    // Only own properties under the matching prefix, and only strings, count.
    for (const w of [["nDirect"], "nOther", "Direct"]) expect(thrown(() => s.synth.setTimbre(1, 39, [{ w }]))).toMatchObject({ name: "TypeError" });
    s.synth.noiseBuf.wSwap = s.synth.noiseBuf.nDirect;
    expect(thrown(() => s.synth.setTimbre(1, 39, [{ w: "wSwap" }]))).toMatchObject({ name: "TypeError" });
    // A new context builds new noiseBuf and wave objects: the caller's entries are gone, and so is the name.
    s.synth.setAudioContext(s.Ctx());
    expect(thrown(() => s.synth.setTimbre(1, 38, [{ w: "nDirect" }]))).toMatchObject({ name: "TypeError" });
    // Before the context exists (lazy), only built-in and registered names are known.
    const lazy = make(variant, { lazy: true });
    expect(thrown(() => lazy.synth.setTimbre(1, 38, [{ w: "nDirect" }]))).toEqual({ name: "TypeError", message: "unknown wave: nDirect" });
  });

  test("a caller's buffer written over a registered name plays as a caller's buffer: 440 basis, whole buffer (review L1)", () => {
    const s = make(variant);
    s.synth.setSampleWave("nTRI", TRI64);
    s.synth.setTimbre(1, 36, [{ w: "nTRI", t: 0, f: 160 }]);
    // TinyChip's registerWaves() on a page that also registered nTRI: a 1 s buffer holding 440 cycles.
    s.synth.noiseBuf.nTRI = s.synth.getAudioContext().createBuffer(1, 44100, 44100);
    const [hit] = sourcesBy(s, (y) => y.noteOn(9, 36, 100, 1));
    expect([hit.buffer, hit.rate, hit.loopEnd]).toEqual([s.synth.noiseBuf.nTRI._id, 160 / 440, undefined]);
    // Registering again restores the held table and its home pitch.
    s.synth.setSampleWave("nTRI", TRI64);
    const [again] = sourcesBy(s, (y) => y.noteOn(9, 36, 100, 2));
    expect([again.rate, again.loopEnd]).toEqual([expect.closeTo(160 / heldTable(TRI64, 44100).base, 12), heldTable(TRI64, 44100).loop]);
  });

  test("a drum override on a registered wave: p 0.28 from 160 Hz", () => {
    const s = make(variant);
    s.synth.setSampleWave("nTRI", TRI64);
    s.synth.setTimbre(1, 36, [{ w: "nTRI", t: 0, f: 160, v: 0.95, a: 0.002, h: 0, d: 0.06, s: 0, r: 0.03, p: 0.28, q: 0.03 }]);
    const [kick] = sourcesBy(s, (y) => y.noteOn(9, 36, 100, 1));
    const base = heldTable(TRI64, 44100).base;
    expect(kick.buffer).toBe(s.synth.noiseBuf.nTRI._id);
    expect(kick.rate).toBeCloseTo(160 / base, 12);
    expect(kick.target).toBeCloseTo(160 / base * 0.28, 12);
    expect(kick.loopEnd).toBe(heldTable(TRI64, 44100).loop);
    expect(s.synth._src).toHaveLength(1);
  });

  test("a harmonic wave plays through setPeriodicWave with the note's frequency", () => {
    const s = make(variant);
    s.synth.setHarmonicWave("wOrg", [0, 0, 0], [0, 1, 0.5]);
    s.synth.setTimbre(0, 0, lead("wOrg"));
    const [o] = sourcesBy(s, (y) => y.noteOn(0, 57, 100, 1));
    expect(o.wave).toBe(calls(s.trace).filter((c) => c[0] === "createPeriodicWave").pop()[1]);
    expect(o.freq).toBe(noteHz(57));
  });

  test("a wave missing from the context (a timbre written past setTimbre) drops the note before anything is made or stolen", () => {
    const s = make(variant, { voices: 1 });
    s.synth.noteOn(0, 60, 100, 1);
    const voices = s.synth.notetab.slice();
    for (const p of [lead("nMissing"), [{ w: "sine" }, { w: "wMissing" }], [{ w: "triangle" }, { g: 1, w: "nGone", t: 0, f: 4 }]]) {
      s.synth.program[3].p = p;
      s.synth.send([0xc0, 3]);
      const from = s.trace.length;
      expect(thrown(() => s.synth.noteOn(0, 62, 100, 1.2))).toBe(null);
      expect(calls(s.trace, from)).toEqual([]);
      expect(s.synth.notetab).toEqual(voices);
    }
  });
});

describe.each(variants)("$name: setTimbre and the registry (#26, D-026)", (variant) => {
  test("unknown and unregistered names throw a TypeError before anything changes", () => {
    const s = make(variant);
    const program = JSON.stringify(s.synth.program), drums = JSON.stringify(s.synth.drummap);
    const bad = ["nTRI", "wOrg", "n2", "w1234", "custom", "Sine", "noise", "", "__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", 5, null, ["sine"]];
    for (const w of bad) {
      const ops = [{ w: "sine", v: 0.3 }, { w, v: 0.2 }];
      expect(thrown(() => s.synth.setTimbre(0, 5, ops))).toMatchObject({ name: "TypeError" });
      expect(thrown(() => s.synth.setTimbre(1, 38, ops))).toMatchObject({ name: "TypeError" });
      expect(ops[0]).toEqual({ w: "sine", v: 0.3 }); // the defaults were not filled in: nothing changed
    }
    expect(thrown(() => s.synth.setTimbre(0, 5, [{ w: "nTRI" }]))).toEqual({ name: "TypeError", message: "unknown wave: nTRI" });
    expect(JSON.stringify(s.synth.program)).toBe(program);
    expect(JSON.stringify(s.synth.drummap)).toBe(drums);
  });

  test("built-ins, registered names and an omitted w are accepted; a name's kind follows its prefix", () => {
    const s = make(variant);
    for (const w of ["sine", "square", "sawtooth", "triangle", "w9999", "n0", "n1", undefined])
      expect(thrown(() => s.synth.setTimbre(0, 5, [{ w, v: 0.3 }]))).toBe(null);
    expect(s.synth.program[5].p[0].w).toBe("sine");
    s.synth.setSampleWave("nTRI", TRI64);
    s.synth.setHarmonicWave("wOrg", [0, 0], [0, 1]);
    s.synth.setSampleWave("n__proto__", PULSE8);
    for (const w of ["nTRI", "wOrg", "n__proto__"]) expect(thrown(() => s.synth.setTimbre(1, 36, [{ w }]))).toBe(null);
    expect(thrown(() => s.synth.setTimbre(0, 5, [{ w: "wTRI" }]))).toMatchObject({ name: "TypeError" });
    expect(Object.prototype.n__proto__).toBe(undefined);
    const [hit] = sourcesBy(s, (y) => y.noteOn(9, 36, 100, 1));
    expect(hit.buffer).toBe(s.synth.noiseBuf.n__proto__._id);
  });

  test("the registry survives setQuality(); the timbres it resets are reinstalled", () => {
    for (const q of [0, 1]) {
      const s = make(variant, { quality: 1 - q });
      s.synth.setSampleWave("nTRI", TRI64);
      s.synth.setTimbre(0, 0, lead("nTRI"));
      const buf = s.synth.noiseBuf.nTRI;
      s.synth.setQuality(q);
      expect(s.synth.program[0].p.some((o) => o.w === "nTRI")).toBe(false); // reset to the built-in
      expect(s.synth.noiseBuf.nTRI).toBe(buf);
      s.synth.setTimbre(0, 0, lead("nTRI"));
      const [o] = sourcesBy(s, (y) => y.noteOn(0, 69, 100, 1));
      expect(o.buffer).toBe(buf._id);
    }
  });
});

describe.each(variants)("$name: the registry across contexts (#26, D-018)", (variant) => {
  test("setAudioContext() rebuilds every registered wave in the new context, for its sample rate", () => {
    const s = make(variant);
    s.synth.setSampleWave("nTRI", TRI64);
    s.synth.setHarmonicWave("wOrg", [0, 0], [0, 1]);
    const old = [s.synth.noiseBuf.nTRI, s.synth.wave.wOrg];
    const from = s.trace.length;
    s.synth.setAudioContext(s.Ctx(48000));
    const made = calls(s.trace, from);
    expect(made.filter((c) => c[0] === "createBuffer").map((c) => c.slice(2))).toEqual([[1, 129, 48000], [2, 24000, 48000], [1, 24000, 48000], [1, 24000, 48000]]);
    expect(made.filter((c) => c[0] === "createPeriodicWave").map((c) => c.slice(2))).toEqual([[[0, 0], [0, 1]], [[0, 0, 0, 0, 0], [0, 9, 9, 9, 9]]]); // the registry first (review L2)
    expect(s.synth.noiseBuf.nTRI).not.toBe(old[0]);
    expect(s.synth.wave.wOrg).not.toBe(old[1]);
    expect(Array.from(s.synth.noiseBuf.nTRI.getChannelData(0))).toEqual(Array.from(heldTable(TRI64, 48000).frames));
  });

  test("a wave the new context refuses leaves the installed graph as it was (review L2), and a refused registration stores nothing", () => {
    const s = make(variant);
    s.synth.setSampleWave("nTRI", TRI64);
    s.synth.setHarmonicWave("wOrg", [0, 0], [0, 1]);
    s.synth.setTimbre(0, 0, lead("nTRI"));
    const before = { ctx: s.synth.getAudioContext(), out: s.synth.out, chvol: s.synth.chvol.slice(), noiseBuf: s.synth.noiseBuf, wave: s.synth.wave };
    const bad = s.Ctx(48000);
    bad.createPeriodicWave = () => { throw new Error("refused"); };
    const from = s.trace.length;
    expect(thrown(() => s.synth.setAudioContext(bad))).toEqual({ name: "Error", message: "refused" });
    expect(calls(s.trace, from).filter((c) => !["createBuffer"].includes(c[0]))).toEqual([]); // nothing torn down or built in the old graph
    expect({ ctx: s.synth.getAudioContext(), out: s.synth.out, chvol: s.synth.chvol, noiseBuf: s.synth.noiseBuf, wave: s.synth.wave }).toEqual(before);
    const [o] = sourcesBy(s, (y) => y.noteOn(0, 69, 100, 1));
    expect(o.buffer).toBe(s.synth.noiseBuf.nTRI._id);
    // _reg builds before it stores: a context that refuses the new wave leaves the registry and the old wave.
    s.synth.getAudioContext().createBuffer = () => { throw new Error("refused"); };
    const tri = s.synth.noiseBuf.nTRI, def = s.synth._wv.get("nTRI");
    expect(thrown(() => s.synth.setSampleWave("nTRI", PULSE8))).toEqual({ name: "Error", message: "refused" });
    expect(thrown(() => s.synth.setSampleWave("nNew", PULSE8))).toEqual({ name: "Error", message: "refused" });
    expect([s.synth.noiseBuf.nTRI, s.synth._wv.get("nTRI"), s.synth._wv.has("nNew"), "nNew" in s.synth.noiseBuf]).toEqual([tri, def, false, false]);
  });

  test("dispose() releases the context's waves and keeps the definitions; later calls change nothing audible", async () => {
    const s = make(variant);
    s.synth.setSampleWave("nTRI", TRI64);
    await s.synth.dispose();
    expect([s.synth.noiseBuf, s.synth.wave]).toEqual([null, null]);
    expect(s.synth._wv.has("nTRI")).toBe(true);
    const from = s.trace.length;
    expect(thrown(() => s.synth.setSampleWave("nNew", PULSE8))).toBe(null);
    expect(thrown(() => s.synth.setTimbre(0, 0, lead("nTRI")))).toBe(null);
    s.synth.noteOn(0, 60, 100);
    expect(s.trace.slice(from)).toEqual([]);
  });

  test("a lazy synth stores the waves and builds them with its context at first use", () => {
    const s = make(variant, { lazy: true });
    s.synth.setSampleWave("nTRI", TRI64);
    s.synth.setTimbre(0, 0, lead("nTRI"));
    expect(s.trace.filter((l) => l.startsWith("[\"create"))).toEqual([]);
    expect(s.synth.getAudioContext()).toBe(null);
    // The first use creates the context, which plays its warm-up note (C4) on program 0: the registered wave too.
    const o = sourcesBy(s, (y) => y.noteOn(0, 69, 100, 1)).filter((x) => x.buffer);
    const base = heldTable(TRI64, 44100).base;
    expect(o.map((x) => x.buffer)).toEqual([s.synth.noiseBuf.nTRI._id, s.synth.noiseBuf.nTRI._id]);
    expect(o.map((x) => x.rate)).toEqual([expect.closeTo(noteHz(60) / base, 12), expect.closeTo(440 / base, 12)]);
  });

  test("with nothing registered, construction and a context change make no extra WebAudio call", () => {
    const a = make(variant), b = make(variant);
    b.synth.setSampleWave("nTRI", TRI64);
    const strip = (trace) => calls(trace).map((c) => c[0]);
    const extra = strip(b.trace).length - strip(a.trace).length;
    expect(extra).toBe(1); // the one createBuffer of the registration
    a.synth.setAudioContext(a.Ctx());
    b.synth.setAudioContext(b.Ctx());
    expect(strip(b.trace).length - strip(a.trace).length).toBe(2); // and one more at the rebuild
  });
});
