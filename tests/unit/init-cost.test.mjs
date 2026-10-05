/*
 * Initialization cost (#18, ledger L-16) on the mock WebAudio of tests/harness.js, for both
 * builds. The measurements are in tasks/T8.md; these tests pin what the changes promise:
 *
 *   - with useReverb 0 the install makes no reverb impulse (convBuf is null, no 2-channel
 *     buffer, no convolver), and n0 and n1 are unchanged, because every buffer has its own
 *     stream (#7); a later install with reverb on makes the seeded impulse;
 *   - n1, the metallic noise (64 passes of sine products), is generated when it is first
 *     read, by the first note that plays it or by code reading noiseBuf.n1, and holds the
 *     seeded data whenever that happens; until then no generation work is done, and a
 *     disposed or replaced synth never does it;
 *   - the constructor installs the built-in timbres once.
 *
 * Generation work is counted with Math.sin (n1 makes 2 * 64 * length calls and nothing else
 * in the library calls it) and Array.from with a mapping function (one per setTimbre). The
 * structural tests run at 8 kHz, where a buffer is 4000 frames; the seeded hashes at 44.1 kHz
 * come from tests/browser/specs/seed-expected.js, computed by the independent reference.
 */
import vm from "node:vm";
import v8 from "node:v8";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { H, variants } from "./helpers.mjs";
import { reference, sha } from "./seed-reference.mjs";

const require = createRequire(import.meta.url);
const { SEED_EXPECTED: E } = require("../browser/specs/seed-expected.js");

const SLOW = 60000;
const SR = 8000;
const SIN_N1 = (sr) => 2 * 64 * Math.floor(sr / 2);

/* A fresh mock environment with `variant` loaded, counting Math.sin and Array.from-with-a-function calls. */
function load(variant) {
  const trace = [];
  const env = H.createEnvironment(trace);
  const count = { sin: 0, map: 0, stall: 0 }; // stall: ms the audio clock advances at the next Math.sin call (a generation that takes time)
  env.sandbox.__count = count;
  env.sandbox.__clock = env.clock;
  vm.runInContext(
    "(function () { const sin = Math.sin, from = Array.from;" +
    " Math.sin = function (x) { ++__count.sin; if (__count.stall) { __clock.ms += __count.stall; __count.stall = 0; } return sin(x); };" +
    " Array.from = function (a, f) { if (typeof f === \"function\") ++__count.map; return from.apply(this, arguments); }; })();",
    env.sandbox);
  vm.runInContext(variant.source, env.sandbox, { filename: variant.name });
  const Ctx = env.sandbox.AudioContext;
  return { env, trace, count, at: (sr = SR) => Object.assign(new Ctx(), { sampleRate: sr }), Synth: env.sandbox.WebAudioTinySynth };
}

const channels = (buf) => Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
const hashOf = (buf) => sha(channels(buf));
const want = (k, seed, sr) => sha(reference[k](seed, sr));
const ops = (trace, name) => trace.map((l) => JSON.parse(l)).filter((l) => l[0] === name);
const buffers = (trace, ch) => ops(trace, "createBuffer").filter((l) => l[2] === ch);
const hasGetter = (synth) => typeof Object.getOwnPropertyDescriptor(synth.noiseBuf, "n1").get === "function";

for (const variant of variants) {
  describe(variant.name, () => {
    describe("useReverb 0 makes no reverb impulse", () => {
      test("no convBuf, no 2-channel buffer, no convolver; the noise buffers keep their data", () => {
        const l = load(variant);
        const seed = 0x5eed0001;
        const off = new l.Synth({ context: l.at(), seed, useReverb: 0 });
        expect(off.convBuf).toBe(null);
        expect(buffers(l.trace, 2)).toEqual([]);
        expect(ops(l.trace, "create").filter((x) => /^conv#/.test(x[1]))).toEqual([]);
        expect([off.conv, off.rev]).toEqual([undefined, undefined]);
        expect(hashOf(off.noiseBuf.n0)).toBe(want("n0", seed, SR));
        expect(hashOf(off.noiseBuf.n1)).toBe(want("n1", seed, SR));

        const on = new l.Synth({ context: l.at(), seed });
        expect(buffers(l.trace, 2).length).toBe(1);
        expect(ops(l.trace, "create").filter((x) => /^conv#/.test(x[1])).length).toBe(1);
        expect(hashOf(on.convBuf)).toBe(want("convBuf", seed, SR));
        expect(hashOf(on.noiseBuf.n0)).toBe(hashOf(off.noiseBuf.n0));
        expect(hashOf(on.noiseBuf.n1)).toBe(hashOf(off.noiseBuf.n1));
      }, SLOW);

      test("useReverb is read at each install: toggling it and installing again adds or drops the impulse, and the noise stays seed-identical", () => {
        const l = load(variant);
        const seed = 7;
        const synth = new l.Synth({ context: l.at(), seed, useReverb: 0 });
        expect(synth.convBuf).toBe(null);
        synth.useReverb = 1;
        synth.setAudioContext(l.at());
        expect(hashOf(synth.convBuf)).toBe(want("convBuf", seed, SR));
        expect([hashOf(synth.noiseBuf.n0), hashOf(synth.noiseBuf.n1)]).toEqual([want("n0", seed, SR), want("n1", seed, SR)]);
        synth.useReverb = 0;
        synth.setAudioContext(l.at());
        expect(synth.convBuf).toBe(null); // the old impulse is not kept
        expect(synth.conv).toBe(null);
        expect([hashOf(synth.noiseBuf.n0), hashOf(synth.noiseBuf.n1)]).toEqual([want("n0", seed, SR), want("n1", seed, SR)]);
      }, SLOW);

      test("the 44.1 kHz default-seed n0 and n1 equal the seeded expectations with reverb off, and the impulse with it on", () => {
        const l = load(variant);
        const off = new l.Synth({ context: l.at(44100), useReverb: 0 });
        const on = new l.Synth({ context: l.at(44100) });
        const h = E.hashes[44100][E.defaultSeed];
        expect([off.convBuf, hashOf(off.noiseBuf.n0), hashOf(off.noiseBuf.n1)]).toEqual([null, h.n0, h.n1]);
        expect([hashOf(on.convBuf), hashOf(on.noiseBuf.n0), hashOf(on.noiseBuf.n1)]).toEqual([h.convBuf, h.n0, h.n1]);
      }, SLOW);

      test("the reverb is still wired with the option on, and not with it off", () => {
        const l = load(variant);
        const wired = (opts) => {
          const y = new l.Synth({ context: l.at(), ...opts });
          return [!!y.conv, !!y.rev, y.conv ? y.conv.buffer === y.convBuf : null];
        };
        expect(wired({})).toEqual([true, true, true]);
        expect(wired({ useReverb: 0 })).toEqual([false, false, null]);
      }, SLOW);
    });

    describe("n1 is generated when it is first read", () => {
      test("construction, melodic notes and an n0 drum generate nothing; the first n1 note makes the seeded data, once", () => {
        for (const quality of [0, 1]) {
          const l = load(variant);
          const seed = 12345;
          const synth = new l.Synth({ context: l.at(), quality, seed, useReverb: 0 });
          expect([l.count.sin, hasGetter(synth)]).toEqual([0, true]);
          synth.noteOn(0, 60, 100, 0);
          synth.noteOn(9, quality ? 38 : 35, 100, 0); // an n0 (or, in quality 0, a melodic) hit
          synth.noteOn(9, 38, 100, 0.1);
          expect([l.count.sin, hasGetter(synth)], "quality " + quality).toEqual([0, true]);
          synth.setTimbre(1, 42, [{ w: "n1", t: 0, f: 440, v: 0.3, d: 0.1, r: 0.1 }]);
          const from = l.trace.length;
          synth.noteOn(9, 42, 100, 0.2);
          expect(l.count.sin, "quality " + quality).toBe(SIN_N1(SR));
          const d = Object.getOwnPropertyDescriptor(synth.noiseBuf, "n1");
          expect([typeof d.get, d.enumerable, d.writable, d.configurable]).toEqual(["undefined", true, true, true]);
          const src = ops(l.trace.slice(from), "buffer").find((x) => /^src#/.test(x[1]));
          expect(src && src[2]).toBe(synth.noiseBuf.n1._id);
          expect(hashOf(synth.noiseBuf.n1)).toBe(want("n1", seed, SR));
          synth.noteOn(9, 42, 100, 0.4);
          synth.noteOn(9, 42, 100, 0.5);
          expect(l.count.sin, "no refill").toBe(SIN_N1(SR));
        }
      }, SLOW);

      test("a first live hi-hat is not cut by the generation: its onset and stop come after the stall, whatever time it was given (Codex review of #63)", () => {
        // noteOn() took the onset from the clock, then _note read n1: with a 41 ms generation the
        // 35 ms hi-hat started and stopped in the past. The lazy buffer is now resolved first, and a
        // time that was current or short-future on entry and is past afterwards moves to the clock.
        const hit = (stall, t) => {
          const l = load(variant);
          const synth = new l.Synth({ context: l.at(), quality: 1, seed: 1, useReverb: 0 });
          l.env.clock.ms = 1000;
          if (stall) l.count.stall = stall;
          else synth.noiseBuf.n1; // the eager case: already generated, the clock does not move
          const from = l.trace.length;
          synth.noteOn(9, 42, 100, t);
          const lines = l.trace.slice(from).map((x) => JSON.parse(x));
          const src = lines.find((x) => x[0] === "create" && /^src#/.test(x[1]))[1];
          const at = (op) => lines.find((x) => x[0] === op && x[1] === src)[2];
          return { start: at("start"), stop: at("stop"), now: l.env.clock.ms / 1000 };
        };
        const eager = hit(0, undefined);
        expect(eager.start).toBe(1);
        const length = eager.stop - eager.start;
        expect(length).toBeGreaterThan(0.02);
        for (const t of [undefined, 1, 1.02, 1.0409]) { // now, now (explicit) and leads shorter than the stall
          const lazy = hit(41, t);
          expect(lazy.now, String(t)).toBeCloseTo(1.041, 9);
          expect(lazy.start, "start " + t).toBeGreaterThanOrEqual(lazy.now - 1e-9); // not in the past
          expect(lazy.stop - lazy.start, "length " + t).toBeCloseTo(length, 9); // the full duration
        }
        const later = hit(41, 1.5), past = hit(41, 0.5);
        expect([later.start, later.stop - later.start]).toEqual([1.5, length]); // still in the future: as given
        expect(past.start).toBe(0.5); // already past on entry: as given, as without a stall
      }, SLOW);

      test("a first n1 note whose onset the generation moved still takes its note-off, pedal-up and stops (Codex review of #63, round 3)", () => {
        // Program 119 (Reverse Cymbal) sustains (s: 1): a release that misses leaves it sounding.
        // The note is asked for at 1.01 s and the generation takes the clock to 1.041 s, so its
        // onset moves; the note-off or pedal-up at 1.03 s falls inside the window and must still
        // release that note, from the moved onset, with no negative or past AudioParam event.
        const setup = (sustain, ...at) => { // at: the time passed to noteOn (1.01 s if none; undefined is a value)
          const l = load(variant);
          const synth = new l.Synth({ context: l.at(), quality: 1, seed: 1, useReverb: 0 });
          l.env.clock.ms = 1000;
          synth.setProgram(0, 119);
          if (sustain) synth.setSustain(0, 127);
          l.count.stall = 41;
          synth.noteOn(0, 60, 100, ...(at.length ? at : [1.01]));
          const nt = synth.notetab[0];
          return { l, synth, nt, from: l.trace.length };
        };
        const events = (l, from) => l.trace.slice(from).map((x) => JSON.parse(x)).filter((x) => ["linearRamp", "setValueAtTime", "setTargetAtTime", "expRamp"].includes(x[0]));
        const sane = (l, from, onset) => {
          const ev = events(l, from);
          expect(ev.length).toBeGreaterThan(0);
          for (const x of ev) {
            expect(x[3], x.join()).toBeGreaterThanOrEqual(onset - 1e-9);
            if (x[0] === "linearRamp" || x[0] === "setValueAtTime") expect(x[2], x.join()).toBeGreaterThanOrEqual(0);
          }
        };
        for (const at of [1.03, 1.041, 1.2]) { // inside the window, exactly at the moved onset, after it
          const { l, synth, nt, from } = setup(false);
          expect([nt.t, nt.s]).toEqual([expect.closeTo(1.041, 9), 1.01]);
          synth.noteOff(0, 60, at);
          expect([nt.f, nt.e < 99999], "note-off at " + at).toEqual([1, true]);
          sane(l, from, 1.041);
        }
        for (const at of [1.03, 1.041, 1.2]) { // the pedal held across the window, up inside it or after it
          const { l, synth, nt, from } = setup(true);
          synth.noteOff(0, 60, 1.03);
          expect([nt.f, nt.e], "held").toEqual([1, 99999]);
          synth.setSustain(0, 0, at);
          expect(nt.e < 99999, "pedal-up at " + at).toBe(true);
          sane(l, from, 1.041);
        }
        for (const at of [undefined, null, 0]) { // no time: asked for at the entry clock, 1.0 s
          for (const sustain of [false, true]) {
            const { l, synth, nt, from } = setup(sustain, at);
            expect([nt.t, nt.s], String(at)).toEqual([expect.closeTo(1.041, 9), 1]);
            synth.noteOff(0, 60, 1.03);
            if (sustain) {
              expect([nt.f, nt.e]).toEqual([1, 99999]);
              synth.setSustain(0, 0, 1.03);
            }
            expect([nt.f, nt.e < 99999], "no time, timed release, sustain " + sustain).toEqual([1, true]);
            sane(l, from, 1.041);
          }
        }
        { // a note-off before the requested time still does not match, as before
          const { synth, nt } = setup(false);
          synth.noteOff(0, 60, 1.0);
          expect([nt.f, nt.e]).toEqual([0, 99999]);
        }
        { // all-sound-off and stopMIDI() inside the window reach it and leave nothing
          const a = setup(false);
          a.synth.allSoundOff(0);
          expect(a.synth.notetab.length).toBe(0);
          const b = setup(true);
          b.synth.stopMIDI();
          expect([b.synth.notetab.length, b.synth._src.length]).toEqual([0, 0]);
        }
      }, SLOW);

      test("a custom n1 timbre in quality 0 plays the seeded data on its first note", () => {
        const l = load(variant);
        const seed = 99;
        const synth = new l.Synth({ context: l.at(), quality: 0, seed, useReverb: 0 });
        synth.setTimbre(0, 0, [{ w: "n1", v: 0.3, a: 0, d: 0.2, s: 0.5, r: 0.1 }]);
        expect(l.count.sin).toBe(0);
        const from = l.trace.length;
        synth.noteOn(0, 60, 100, 0);
        const lines = l.trace.slice(from).map((x) => JSON.parse(x));
        const buf = lines.find((x) => x[0] === "buffer" && /^src#/.test(x[1]));
        expect(buf && buf[2]).toBe(synth.noiseBuf.n1._id);
        expect(l.count.sin).toBe(SIN_N1(SR));
        expect(hashOf(synth.noiseBuf.n1)).toBe(want("n1", seed, SR));
      }, SLOW);

      test("reading noiseBuf.n1 gives the seeded data at 44.1 kHz, the same object each time, and no refill", () => {
        const l = load(variant);
        const synth = new l.Synth({ context: l.at(44100), seed: 0xffffffff, useReverb: 0 });
        const n1 = synth.noiseBuf.n1;
        expect(hashOf(n1)).toBe(E.hashes[44100][0xffffffff].n1);
        expect(synth.noiseBuf.n1).toBe(n1);
        n1.getChannelData(0)[0] = 0.5; // a refill would overwrite it
        expect(synth.noiseBuf.n1.getChannelData(0)[0]).toBe(0.5);
      }, SLOW);

      test("the data does not depend on what ran before the read: other buffers, notes, setQuality, an unrelated install", () => {
        const seed = 0x5eed0001;
        for (const order of ["n0 first", "n1 first", "after notes and setQuality", "after a replaced install"]) {
          const l = load(variant);
          const synth = new l.Synth({ context: l.at(), seed });
          if (order === "n0 first") synth.noiseBuf.n0;
          if (order === "after notes and setQuality") {
            synth.noteOn(0, 60, 100, 0);
            synth.noteOn(9, 38, 100, 0);
            synth.setQuality(0);
            synth.setQuality(1);
          }
          if (order === "after a replaced install") {
            synth.setAudioContext(l.at());
            synth.setAudioContext(l.at());
          }
          expect([hashOf(synth.noiseBuf.n0), hashOf(synth.noiseBuf.n1)], order).toEqual([want("n0", seed, SR), want("n1", seed, SR)]);
        }
      }, SLOW);

      test("a buffer assigned before the first read replaces it without generating", () => {
        const l = load(variant);
        const synth = new l.Synth({ context: l.at(), useReverb: 0 });
        const mine = synth.getAudioContext().createBuffer(1, 100, SR);
        synth.noiseBuf.n1 = mine;
        expect(synth.noiseBuf.n1).toBe(mine);
        const d = Object.getOwnPropertyDescriptor(synth.noiseBuf, "n1");
        expect([typeof d.get, d.enumerable]).toEqual(["undefined", true]);
        synth.setTimbre(1, 42, [{ w: "n1", t: 0, f: 440, d: 0.1 }]);
        const from = l.trace.length;
        synth.noteOn(9, 42, 100, 0);
        const buf = l.trace.slice(from).map((x) => JSON.parse(x)).find((x) => x[0] === "buffer" && /^src#/.test(x[1]));
        expect(buf && buf[2]).toBe(mine._id);
        expect(l.count.sin).toBe(0);
      }, SLOW);

      test("noiseBuf keeps its keys, n0 then n1; listing the keys generates nothing, listing the entries does", () => {
        const l = load(variant);
        const synth = new l.Synth({ context: l.at(), useReverb: 0, seed: 5 });
        expect(Object.keys(synth.noiseBuf)).toEqual(["n0", "n1"]);
        expect(l.count.sin).toBe(0);
        const entries = Object.entries(synth.noiseBuf);
        expect(entries.map((e) => e[0])).toEqual(["n0", "n1"]);
        expect(hashOf(entries[1][1])).toBe(want("n1", 5, SR));
        expect(Object.keys(synth.noiseBuf)).toEqual(["n0", "n1"]);
      }, SLOW);

      test("a registered wave named like a built-in noise stays rejected, and registered waves do not read n1", () => {
        const l = load(variant);
        const synth = new l.Synth({ context: l.at(), useReverb: 0 });
        synth.setSampleWave("nSaw", [-1, -0.5, 0, 0.5]);
        synth.setTimbre(0, 0, [{ w: "nSaw" }, { w: "n0" }]);
        synth.noteOn(0, 60, 100, 0);
        expect(() => synth.setSampleWave("n1", [0, 1])).toThrow();
        expect(l.count.sin).toBe(0);
        expect(hasGetter(synth)).toBe(true);
      }, SLOW);
    });

    describe("disposal and replacement", () => {
      test("dispose() before any n1 read does no generation and leaves nothing", async () => {
        const l = load(variant);
        const synth = new l.Synth({ context: l.at(), seed: 3 });
        const held = synth.noiseBuf; // a caller's own reference keeps working as data
        await synth.dispose();
        expect([synth.noiseBuf, synth.convBuf, synth.getAudioContext()]).toEqual([null, null, null]);
        expect(l.count.sin).toBe(0);
        expect(hashOf(held.n1)).toBe(want("n1", 3, SR)); // a held reference still reads the seeded data
        // A dead synth stays dead: no later note reads anything.
        synth.noteOn(9, 42, 100, 0);
        expect(synth.noiseBuf).toBe(null);
      }, SLOW);

      test("a lazy synth that is never started, and one disposed unused, generate nothing", async () => {
        const l = load(variant);
        const a = new l.Synth({ lazy: true });
        await a.dispose();
        const b = new l.Synth({ lazy: true });
        b.noteOn(0, 60, 100, 0); // starts: installs
        await b.dispose();
        expect(l.count.sin).toBe(0);
      }, SLOW);

      test("replacing the context before the first read: the new install makes its own, at its own rate", () => {
        const l = load(variant);
        const seed = 21;
        const synth = new l.Synth({ context: l.at(SR), seed });
        const first = synth.noiseBuf;
        synth.setAudioContext(l.at(16000));
        expect(l.count.sin).toBe(0);
        expect(synth.noiseBuf === first).toBe(false); // not toBe(): a failed Object.is makes vitest deep-compare, reading both n1
        const n1 = synth.noiseBuf.n1;
        expect([n1.length, n1.sampleRate]).toEqual([8000, 16000]);
        expect(hashOf(n1)).toBe(want("n1", seed, 16000));
        expect(l.count.sin).toBe(SIN_N1(16000));
      }, SLOW);

      test("a disposed synth's context can be collected: nothing keeps it (no global cache)", async () => {
        v8.setFlagsFromString("--expose-gc");
        const gc = vm.runInNewContext("gc");
        const l = load(variant);
        const refs = [];
        const make = async () => {
          const ctx = l.at();
          refs.push(new WeakRef(ctx));
          const synth = new l.Synth({ context: ctx, useReverb: 1 });
          synth.noteOn(0, 60, 100, 0);
          await synth.dispose();
        };
        await make();
        await make();
        for (let i = 0; i < 5 && refs.some((r) => r.deref()); ++i) {
          await new Promise((r) => setTimeout(r, 10));
          gc();
        }
        expect(refs.map((r) => r.deref() === undefined)).toEqual([true, true]);
      }, SLOW);
    });

    describe("the constructor installs the built-in timbres once", () => {
      test("the number of timbre installs equals one setQuality() call, with and without a quality option", () => {
        const l = load(variant);
        const installs = (fn) => {
          const before = l.count.map;
          const r = fn();
          return [l.count.map - before, r];
        };
        for (const q of [undefined, 0, 1, null, "0"]) {
          const [c, synth] = installs(() => new l.Synth({ lazy: true, quality: q }));
          const [s] = installs(() => synth.setQuality(synth.quality));
          expect(c, "quality " + String(q)).toBe(s);
          expect(c).toBeGreaterThan(100);
        }
        const [c0] = installs(() => new l.Synth({ lazy: true, quality: 0 }));
        const [c1] = installs(() => new l.Synth({ lazy: true }));
        expect(c1).toBeGreaterThan(c0); // quality 1 installs the quality-1 tables as well, once each
      });

      test("the constructor options still take effect in order: reverb, quality, voices", () => {
        const l = load(variant);
        const y = new l.Synth({ lazy: true, useReverb: 0, quality: 0, voices: 5 });
        expect([y.useReverb, y.quality, y.voices]).toEqual([0, 0, 5]);
        const z = new l.Synth({ lazy: true, quality: null });
        expect(z.quality).toBe(1);
        const q0 = new l.Synth({ lazy: true, quality: 0 });
        expect(q0.program[0].p.length).toBe(1); // a quality-0 program is one operator
        expect(q0.program[119].p.length).toBe(z.program0[119].length);
        const e = (() => { try { new l.Synth({ quality: 2 }); } catch (x) { return x; } return null; })();
        expect(e && e.name).toBe("RangeError");
        expect(l.trace).toEqual([]); // a rejected option creates no context or node
      });
    });
  });
}
