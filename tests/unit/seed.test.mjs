/*
 * Seeded built-in buffers (#7, D-004, ledger L-07) on the mock WebAudio of
 * tests/harness.js, for both builds: the `seed` option and its validation,
 * the read-only `seed` and `bufferVersion` properties, the generated convBuf,
 * n0 and n1 data against an independent reference and the seeded
 * expectations (tests/browser/specs/seed-expected.js), per-buffer stream
 * independence, and no Math.random anywhere.
 *
 * The mock records that buffers are created, never their sample data, so the
 * upstream differential, tempo and loop-end regressions compare the same
 * traces as before (checked below). Every library load here gets a
 * Math.random that counts and throws.
 */
import vm from "node:vm";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { H, variants } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { SEED_EXPECTED: E } = require("../browser/specs/seed-expected.js");

const RATES = [44100, 48000];
/* Each construction generates 0.5 s buffers inside a vm context (slow global lookups): about 0.5 s. */
const SLOW = 60000;
const SEEDS = Object.keys(E.hashes[44100]).map(Number);

/* ---------- independent reference for generation version 1 ---------- */

/* mulberry32 in BigInt uint32 arithmetic, after Tommy Ettinger's C reference: a draw is an integer / 2^32. */
function mulberry32(seed) {
  const M = 0xffffffffn;
  let s = BigInt(seed) & M;
  return () => {
    s = (s + 0x6d2b79f5n) & M;
    let z = s;
    z = ((z ^ (z >> 15n)) * (z | 1n)) & M;
    z = (z ^ ((z + (((z ^ (z >> 7n)) * (z | 61n)) & M)) & M)) & M;
    return Number(z ^ (z >> 14n)) / 4294967296;
  };
}

/* murmur3's fmix32 in BigInt uint32 arithmetic: the seed mix. */
function fmix32(x) {
  const M = 0xffffffffn;
  let h = BigInt(x) & M;
  h = ((h ^ (h >> 16n)) * 0x85ebca6bn) & M;
  h = ((h ^ (h >> 13n)) * 0xc2b2ae35n) & M;
  return h ^ (h >> 16n);
}

/* Stream k (convBuf 0, n0 1, n1 2) starts at (fmix32(seed) + k * 2^30) mod 2^32. Each buffer is generated alone from its stream. */
const stream = (seed, k) => mulberry32((fmix32(seed) + BigInt(k) * 0x40000000n) & 0xffffffffn);
const reference = {
  convBuf(seed, sr) {
    const blen = Math.floor(sr / 2), r = stream(seed, 0), d1 = new Float32Array(blen), d2 = new Float32Array(blen);
    for (let i = 0; i < blen; ++i) {
      if (i / blen < r()) {
        d1[i] = Math.exp(-3 * i / blen) * (r() - 0.5) * 0.5;
        d2[i] = Math.exp(-3 * i / blen) * (r() - 0.5) * 0.5;
      }
    }
    return [d1, d2];
  },
  n0(seed, sr) {
    const blen = Math.floor(sr / 2), r = stream(seed, 1), d = new Float32Array(blen);
    for (let i = 0; i < blen; ++i) d[i] = r() * 2 - 1;
    return [d];
  },
  n1(seed, sr) {
    const blen = Math.floor(sr / 2), r = stream(seed, 2), d = new Float32Array(blen);
    for (let j = 0; j < 64; ++j) {
      const r1 = r() * 10 + 1, r2 = r() * 10 + 1;
      for (let i = 0; i < blen; ++i) d[i] += Math.sin((i / blen) * 2 * Math.PI * 440 * r1) * Math.sin((i / blen) * 2 * Math.PI * 440 * r2) / 8;
    }
    return [d];
  },
};

/* SHA-256 of Float32 channel data, little-endian, channels in order (the seed-expected.js format). */
function sha(chs) {
  const h = crypto.createHash("sha256");
  for (const c of chs) h.update(Buffer.from(c.buffer, c.byteOffset, c.byteLength));
  return h.digest("hex");
}

/* ---------- the library on the mock ---------- */

/* A fresh mock environment with `variant` loaded after a Math.random that counts its calls and throws. */
function load(variant) {
  const trace = [];
  const env = H.createEnvironment(trace);
  const random = { calls: 0 };
  env.sandbox.__random = random;
  vm.runInContext("Math.random = function () { ++__random.calls; throw new Error(\"Math.random called\"); };", env.sandbox);
  vm.runInContext(variant.source, env.sandbox, { filename: variant.name });
  const Ctx = env.sandbox.AudioContext;
  const at = (sr) => Object.assign(new Ctx(), { sampleRate: sr });
  return { env, trace, random, at, Synth: env.sandbox.WebAudioTinySynth };
}

const channels = (buf) => Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
const buffersOf = (synth) => ({ convBuf: channels(synth.convBuf), n0: channels(synth.noiseBuf.n0), n1: channels(synth.noiseBuf.n1) });
const hashesOf = (synth) => {
  const b = buffersOf(synth);
  return { convBuf: sha(b.convBuf), n0: sha(b.n0), n1: sha(b.n1) };
};

/* The error `fn` throws (from the library's realm, so compared by name), or null. */
function thrown(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}

describe("the seeded expectations", () => {
  test("come from the independent reference (every seed, both sample rates)", () => {
    for (const sr of RATES) {
      for (const seed of SEEDS) {
        const h = {};
        for (const k of ["convBuf", "n0", "n1"]) h[k] = sha(reference[k](seed, sr));
        expect(h, seed + " @" + sr).toEqual(E.hashes[sr][seed]);
      }
    }
  }, SLOW);

  test("the seed mix maps 0 to 0, so the default seed's data does not depend on it", () => {
    expect(fmix32(0)).toBe(0n);
    expect(fmix32(1)).not.toBe(1n);
  });

  test("the streams are 2^30 draws apart in the mixed seed's sequence, far more than a buffer draws", () => {
    // mulberry32's state advances by 0x6d2b79f5 per draw, so stream k's start, seed + k * 2^30,
    // is the state after k * 2^30 draws exactly when 2^30 * 0x6d2b79f5 = 2^30 (mod 2^32).
    expect((2n ** 30n * 0x6d2b79f5n) % 2n ** 32n).toBe(2n ** 30n);
    // The most a stream draws, at 768 kHz (the Web Audio maximum): convBuf at most 3 per sample.
    const blen = 768000 / 2;
    expect(Math.max(3 * blen, blen, 128)).toBeLessThan(2 ** 30);
  });
});

describe("stream independence on the library itself", () => {
  test("a copy of the source that skips the convBuf loop when useReverb is 0 keeps n0 and n1", () => {
    // The library always fills convBuf today (skipping it is #18's work); this copy stops the
    // convBuf loop at its first sample, so its stream draws nothing, and n0 and n1 must not move.
    const source = variants.find((v) => v.name === "webaudio-tinysynth.js").source;
    const anchor = "if(i/blen<g()){";
    expect(source.split(anchor).length - 1).toBe(1);
    const l = load({ name: "skip-conv.js", source: source.replace(anchor, "if(!this.useReverb)break;" + anchor) });
    for (const sr of RATES) {
      const skipped = hashesOf(new l.Synth({ context: l.at(sr), seed: 1, useReverb: 0 }));
      expect(skipped.convBuf, "the convBuf loop was skipped @" + sr).toBe(sha([new Float32Array(sr / 2), new Float32Array(sr / 2)]));
      expect({ n0: skipped.n0, n1: skipped.n1 }, "@" + sr).toEqual({ n0: E.hashes[sr][1].n0, n1: E.hashes[sr][1].n1 });
      expect(hashesOf(new l.Synth({ context: l.at(sr), seed: 1 })), "reverb on @" + sr).toEqual(E.hashes[sr][1]);
    }
    expect(l.random.calls).toBe(0);
  }, SLOW);
});

for (const variant of variants) {
  describe(variant.name, () => {
    test("default construction: seed 0 and bufferVersion 1, both read-only", () => {
      const l = load(variant);
      const synth = new l.Synth();
      expect([synth.seed, synth.bufferVersion]).toEqual([E.defaultSeed, E.bufferVersion]);
      for (const k of ["seed", "bufferVersion"]) {
        const d = Object.getOwnPropertyDescriptor(synth, k);
        expect([d.writable, d.configurable, d.enumerable], k).toEqual([false, false, true]);
        expect(() => { synth[k] = 7; }, k).toThrow(TypeError);
        expect(synth[k], k).toBe(k === "seed" ? E.defaultSeed : E.bufferVersion);
      }
      expect(l.random.calls).toBe(0);
    }, SLOW);

    test("the buffers match the seeded expectations at 44.1 and 48 kHz, for the default and explicit seeds", () => {
      for (const sr of RATES) {
        const l = load(variant);
        expect(hashesOf(new l.Synth({ context: l.at(sr) })), "default @" + sr).toEqual(E.hashes[sr][E.defaultSeed]);
        for (const seed of SEEDS) {
          const synth = new l.Synth({ context: l.at(sr), seed });
          expect(synth.seed).toBe(seed);
          expect(hashesOf(synth), seed + " @" + sr).toEqual(E.hashes[sr][seed]);
        }
        expect(l.random.calls).toBe(0);
      }
    }, SLOW);

    test("each buffer equals its stream generated alone by the reference", () => {
      const l = load(variant);
      const seed = 0x5eed0001, sr = 48000;
      const b = buffersOf(new l.Synth({ context: l.at(sr), seed }));
      for (const k of ["convBuf", "n0", "n1"]) {
        const ref = reference[k](seed, sr);
        expect(b[k].length, k).toBe(ref.length);
        b[k].forEach((x, c) => expect(Buffer.compare(Buffer.from(x.buffer), Buffer.from(ref[c].buffer)), k + " channel " + c).toBe(0));
      }
    }, SLOW);

    test("useReverb: 0 (which still fills convBuf), lazy start, setQuality() and context replacement give the same buffers", () => {
      const l = load(variant);
      const want = E.hashes[44100][1];
      expect(hashesOf(new l.Synth({ context: l.at(44100), seed: 1, useReverb: 0 }))).toEqual(want);
      expect(hashesOf(new l.Synth({ context: l.at(44100), seed: 1, quality: 0 }))).toEqual(want);
      const lazy = new l.Synth({ lazy: true, seed: 1 });
      expect(lazy.getAudioContext()).toBe(null);
      lazy.noteOn(9, 42, 100, 0);
      expect(hashesOf(lazy)).toEqual(want);
      const synth = new l.Synth({ context: l.at(48000), seed: 1 });
      const before = synth.noiseBuf.n1;
      synth.setQuality(0);
      synth.setAudioContext(l.at(44100));
      expect(synth.noiseBuf.n1).not.toBe(before);
      expect(hashesOf(synth)).toEqual(want);
      synth.setAudioContext(l.at(48000));
      expect(hashesOf(synth)).toEqual(E.hashes[48000][1]);
      expect(l.random.calls).toBe(0);
    }, SLOW);

    test("seeds that differ by mulberry32's increment or by 2^30 do not give shifted copies of each other's buffers", () => {
      // Without the fmix32 mix, seed 0x6d2b79f5 is seed 0 one draw on: its n0 was seed 0's n0 shifted by one sample.
      const l = load(variant);
      const of = (seed) => buffersOf(new l.Synth({ context: l.at(44100), seed }));
      const base = of(0);
      const sameAtShift = (x, y, d) => {
        let n = 0;
        for (let i = 0; i + d < y.length && i < x.length; ++i) if (x[i] === y[i + d]) ++n;
        return n;
      };
      for (const seed of [0x6d2b79f5, 2 * 0x6d2b79f5, 0x40000000, 0x80000000, 0xc0000000]) {
        const other = of(seed);
        for (const k of ["n0", "n1"]) {
          for (let d = 0; d <= 4; ++d) {
            expect(sameAtShift(other[k][0], base[k][0], d), k + " of seed " + seed + " vs seed 0 shifted " + d).toBeLessThan(50);
            expect(sameAtShift(base[k][0], other[k][0], d), k + " of seed 0 vs seed " + seed + " shifted " + d).toBeLessThan(50);
          }
        }
      }
    }, SLOW);

    test("repeated construction repeats the data; each synth and context gets its own buffers (no cache)", () => {
      const l = load(variant);
      const ctx = l.at(44100);
      const a = new l.Synth({ context: ctx, seed: 0xffffffff }), b = new l.Synth({ context: ctx, seed: 0xffffffff });
      expect(hashesOf(b)).toEqual(hashesOf(a));
      expect(b.convBuf).not.toBe(a.convBuf);
      expect(b.noiseBuf.n0).not.toBe(a.noiseBuf.n0);
      expect(hashesOf(new l.Synth({ context: l.at(44100), seed: 0xffffffff }))).toEqual(hashesOf(a));
      return a.dispose().then(() => {
        expect([a.convBuf, a.noiseBuf, a.getAudioContext()]).toEqual([null, null, null]);
        expect(hashesOf(b)).toEqual(E.hashes[44100][0xffffffff]);
      });
    }, SLOW);

    test("different seeds give different data in every buffer, including seeds 2^30 apart", () => {
      const l = load(variant);
      const seeds = [0, 1, 2, 0x40000000, 0x80000000, 0xffffffff];
      const all = seeds.map((seed) => hashesOf(new l.Synth({ context: l.at(44100), seed })));
      for (const k of ["convBuf", "n0", "n1"]) expect(new Set(all.map((h) => h[k])).size, k).toBe(seeds.length);
    }, SLOW);

    test("the seed is an unsigned 32-bit integer: edge values are accepted, -0 reads as 0, null and undefined mean the default", () => {
      const l = load(variant);
      for (const [seed, want] of [[0, 0], [-0, 0], [2 ** 31, 2 ** 31], [4294967295, 4294967295], [7.0, 7], [null, E.defaultSeed], [undefined, E.defaultSeed]]) {
        const synth = new l.Synth({ lazy: true, seed });
        expect(Object.is(synth.seed, want), String(seed)).toBe(true);
      }
      expect(hashesOf(new l.Synth({ context: l.at(44100), seed: -0 }))).toEqual(E.hashes[44100][0]);
      expect(hashesOf(new l.Synth({ context: l.at(44100), seed: null }))).toEqual(E.hashes[44100][E.defaultSeed]);
    }, SLOW);

    test("an invalid seed throws a TypeError or RangeError naming it, before any context, node or timer is created", () => {
      const l = load(variant);
      const cases = [
        ["1", "TypeError"], ["", "TypeError"], [1n, "TypeError"], [true, "TypeError"],
        [{}, "TypeError"], [[1], "TypeError"], [() => 1, "TypeError"], [Symbol("seed"), "TypeError"],
        [-1, "RangeError"], [1.5, "RangeError"], [-0.5, "RangeError"], [NaN, "RangeError"], [Infinity, "RangeError"],
        [-Infinity, "RangeError"], [2 ** 32, "RangeError"], [4294967295.5, "RangeError"], [2 ** 53, "RangeError"],
      ];
      for (const [seed, name] of cases) {
        for (const extra of [{}, { lazy: true }]) {
          const e = thrown(() => new l.Synth({ seed, ...extra }));
          expect(e && e.name, String(seed)).toBe(name);
          expect(e.message).toMatch(/^seed must be /);
        }
      }
      expect(l.trace).toEqual([]);
      expect(l.env.timers.size).toBe(0);
    });

    test("Math.random is never called: construction, notes on the noise drums and programs, playback, replacement, disposal", () => {
      const l = load(variant);
      for (const quality of [0, 1]) {
        const synth = new l.Synth({ context: l.at(48000), quality, seed: 3 });
        for (const n of [38, 42, 49, 55]) synth.noteOn(9, n, 100, 0.1);
        for (const p of [119, 120, 122, 127]) {
          synth.setProgram(0, p);
          synth.noteOn(0, 60, 100, 0.2);
          synth.noteOff(0, 60, 0.4);
        }
        const song = H.makeMidi(480, [H.midi.noteOn(0, 9, 42, 100), H.midi.noteOff(240, 9, 42), H.midi.noteOn(480, 9, 38, 100), H.midi.noteOff(960, 9, 38)]);
        synth.loadMIDI(H.toArrayBuffer(song));
        synth.playMIDI();
        H.runUntil(l.env, () => synth.getPlayStatus().play === 0, 10000);
        synth.setAudioContext(l.at(44100));
        synth.noteOn(9, 42, 100, 0);
        synth.dispose();
      }
      expect(l.random.calls).toBe(0);
    }, SLOW);

    test("a lazy start whose first install fails, then succeeds, gets the seed's buffers (with #47's cleanup)", () => {
      // #47 closes a lazy synth's new context when installing it fails, and the next use retries.
      // Each install makes fresh generators from the seed, so neither a failure after the buffers
      // were generated (w9999, built later in setAudioContext) nor one part-way through generating
      // them (the second createBuffer, n0) changes what the retry generates.
      for (const [seed, failAt] of [[1, "periodicWave"], [0, "periodicWave"], [0x5eed0001, "secondBuffer"]]) {
        const l = load(variant);
        const synth = new l.Synth({ lazy: true, seed });
        const Base = l.env.sandbox.AudioContext, made = [];
        l.env.sandbox.AudioContext = class extends Base {
          constructor() {
            super();
            made.push(this);
            this.buffers = 0;
          }
          createPeriodicWave(re, im) {
            if (failAt === "periodicWave" && made.length === 1) throw new Error("refused");
            return super.createPeriodicWave(re, im);
          }
          createBuffer(ch, len, sr) {
            if (failAt === "secondBuffer" && made.length === 1 && ++this.buffers === 2) throw new Error("refused");
            return super.createBuffer(ch, len, sr);
          }
        };
        const e = thrown(() => synth.noteOn(9, 42, 100, 0));
        expect(e && e.message, failAt).toBe("refused");
        expect([made[0].state, synth.getAudioContext(), synth.convBuf, synth.noiseBuf], failAt).toEqual(["closed", null, null, null]);
        synth.noteOn(9, 42, 100, 0);
        expect([made.length, synth.getAudioContext() === made[1], synth.seed]).toEqual([2, true, seed]);
        expect(hashesOf(synth), seed + " after a failed " + failAt).toEqual(E.hashes[44100][seed]);
        expect(l.random.calls).toBe(0);
      }
    }, SLOW);

    test("the mock trace does not depend on the seed (it records buffer creation, not sample data)", () => {
      const traces = [0, 0xffffffff].map((seed) => {
        const l = load(variant);
        const synth = new l.Synth({ seed });
        for (const n of [38, 42]) synth.noteOn(9, n, 100, 0.1);
        expect(l.trace.some((line) => JSON.parse(line)[0] === "createBuffer")).toBe(true);
        return l.trace;
      });
      expect(traces[1]).toEqual(traces[0]);
    }, SLOW);
  });
}
