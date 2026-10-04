/*
 * Fixed operator filters (#27) under D-007 as amended by D-028 (tasks/T12.md), on the mock
 * WebAudio of tests/harness.js, for both builds:
 *   - setTimbre's filter check (_checkFilter): what it accepts, what it rejects with which
 *     error, and that a rejection changes nothing (no slot, no caller object);
 *   - the graph a filtered operator builds (gain -> BiquadFilter -> channel volume) and the
 *     filter's parameters: type, cutoff (Hz, or a multiple of the tuned note-on frequency),
 *     the Nyquist clamp at 0.45 x the sample rate, and Q (dB for low- and high-pass, linear
 *     for band-pass), with expected values computed here from the contract;
 *   - the filter's release on every path that ends a voice.
 * The mock never ends a source by itself; ended() below fires `ended` on every source whose
 * stop time has passed, as a browser does. The browser spec (tests/browser/specs/filters.js)
 * checks the response against an independent RBJ computation and the real graph.
 */
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { H, variants, noteHz } from "./helpers.mjs";

const calls = (trace, from = 0) => trace.slice(from).map((line) => JSON.parse(line));
const SQRT1_2_DB = 20 * Math.log10(Math.SQRT1_2); // -3.0103 dB: the default Q for low- and high-pass
const CLAMP = 0.45; // x sample rate (tasks/T12.md, "Nyquist")
const FLOOR = 2 ** -126; // the smallest normal 32-bit float: the least accepted ff and fq (review F1)
const BELOW = FLOOR * (1 - 2 ** -20); // a double just under it

/*
 * A fresh mock environment with `variant` loaded and a synth built with `opts`. `sr` sets the
 * sample rate of an injected (caller-owned) context; without it the synth creates its own
 * 44.1 kHz context. ended(now) fires `ended` on every source stopped at or before `now`
 * (default: the clock); step(ms) advances the clock through the synth's 60 ms timer.
 */
function make(variant, opts = {}, sr) {
  const trace = [];
  const env = H.createEnvironment(trace);
  vm.runInContext(variant.source, env.sandbox, { filename: variant.name });
  const Base = env.sandbox.AudioContext;
  const sources = [];
  for (const m of ["createOscillator", "createBufferSource"]) {
    const create = Base.prototype[m];
    Base.prototype[m] = function () {
      const node = create.call(this);
      const stop = node.stop;
      node.stop = (t) => {
        node.endsAt = t === undefined || t === null ? env.clock.ms / 1000 : t;
        return stop.call(node, t);
      };
      sources.push(node);
      return node;
    };
  }
  let ctx = null;
  if (sr) {
    ctx = new Base();
    ctx.sampleRate = sr;
  }
  const synth = new env.sandbox.WebAudioTinySynth(Object.assign({}, opts, ctx ? { context: ctx } : {}));
  const ended = (now = env.clock.ms / 1000) => {
    for (const n of sources) {
      if (!n.done && n.endsAt !== undefined && n.endsAt <= now) {
        n.done = true;
        if (n.onended) n.onended();
      }
    }
  };
  const step = (ms) => H.runUntil(env, () => false, ms);
  return { env, trace, synth, ended, step, Base, ctx };
}

/* The BiquadFilters created in trace[from..]: {id, type, frequency, Q} from their recorded calls. */
function biquads(trace, from = 0) {
  const byId = new Map();
  for (const [op, id, ...a] of calls(trace, from)) {
    if (op === "create" && id.startsWith("biquad#")) byId.set(id, { id, type: "lowpass", frequency: 350, Q: 1 });
    else if (op === "type" && byId.has(id)) byId.get(id).type = a[0];
    else if (op === "value" && byId.has(id.split(".")[0])) byId.get(id.split(".")[0])[id.split(".")[1]] = a[0];
  }
  return [...byId.values()];
}

/* Connections the recorded calls leave in place, as [from, to] ids (a parameter is "node.param"). */
function liveEdges(trace) {
  const live = [];
  for (const [op, from, to] of calls(trace)) {
    if (op === "connect") live.push([from, to]);
    else if (op === "disconnect")
      for (let i = live.length - 1; i >= 0; --i) if (live[i][0] === from && (to === null || live[i][1] === to)) live.splice(i, 1);
  }
  return live;
}
/* Live connections from or to a BiquadFilter (or one of its parameters). */
const filterEdges = (trace) => liveEdges(trace).filter(([a, b]) => /^biquad#/.test(a) || /^biquad#/.test(b));
/* Filters still held by the synth's voice lists. */
const heldFilters = (synth) => [...synth.notetab, ...synth._src, ...synth._gone].flatMap((v) => (v.q || []).filter(Boolean));

/* JSON that keeps NaN and the infinities (as strings). */
const keep = (k, v) => (typeof v === "number" && !Number.isFinite(v) ? String(v) : v);
/* The newest voice on channel ch playing note n (the constructor's warm-up note is channel 0, note 60). */
const voice = (synth, ch, n) => synth.notetab.filter((v) => v.ch === ch && v.n === n).pop();

const lead = (extra = {}) => [{ w: "sawtooth", v: 0.3, s: 1, r: 0.05, fl: "lowpass", ff: 1000, ...extra }];
const hat = (extra = {}) => [{ w: "n1", t: 0, f: 440, v: 0.3, d: 0.04, r: 0.04, fl: "highpass", ff: 3000, ...extra }];

describe.each(variants)("$name", (variant) => {
  describe("setTimbre's filter check (_checkFilter)", () => {
    const accepted = [
      ["each type", [{ fl: "lowpass", ff: 1000 }, { fl: "highpass", ff: 1000 }, { fl: "bandpass", ff: 1000 }]],
      ["fq and fk given", [{ fl: "lowpass", ff: 2, fk: 1, fq: 30 }, { fl: "bandpass", ff: 500, fk: 0, fq: 0.1 }]],
      ["g given as 0 (or the engine's loose \"0\")", [{ g: 0, fl: "highpass", ff: 3000 }, { g: "0", fl: "highpass", ff: 3000 }]],
      ["a filtered output next to a modulator", [{ fl: "lowpass", ff: 800 }, { g: 1, w: "sine", t: 0, f: 5, v: 0.01 }]],
      ["natural limits only (D-028): the smallest and largest normal floats", [{ fl: "lowpass", ff: FLOOR, fq: FLOOR }, { fl: "highpass", ff: FLOOR, fq: FLOOR }, { fl: "bandpass", ff: 3.4e38, fq: 3.4e38 }]],
      ["undefined fields count as absent", [{ fl: undefined, ff: undefined, fq: undefined, fk: undefined }, { fl: "lowpass", ff: 500, fq: undefined, fk: undefined }]],
    ];
    test.each(accepted)("accepts %s, and stores the filter fields as given (no fq or fk added)", (_, timbre) => {
      const { synth } = make(variant);
      const given = JSON.parse(JSON.stringify(timbre));
      synth.setTimbre(0, 5, timbre);
      expect(synth.program[5].p).toBe(timbre);
      timbre.forEach((op, i) => {
        for (const k of ["fl", "ff", "fq", "fk"]) expect(op[k]).toBe(given[i][k]);
      });
    });

    const rejected = [
      ["ff without fl", [{ ff: 1000 }], "TypeError", "ff without fl"],
      ["fq without fl", [{ fq: 2 }], "TypeError", "fq without fl"],
      ["fk without fl", [{ fk: 0 }], "TypeError", "fk without fl"],
      ["fl null", [{ fl: null, ff: 1000 }], "TypeError", "fl: null"],
      ["an unknown type", [{ fl: "notch", ff: 1000 }], "TypeError", "fl: notch"],
      ["the consumer's kind name", [{ fl: "LowPass", ff: 1000 }], "TypeError", "fl: LowPass"],
      ["a number type", [{ fl: 0, ff: 1000 }], "TypeError", "fl: 0"],
      ["a filter on an FM modulator", [{}, { g: 1, fl: "lowpass", ff: 1000 }], "TypeError", "fl on a modulator"],
      ["a filter on an AM modulator", [{}, { g: 11, fl: "lowpass", ff: 1000 }], "TypeError", "fl on a modulator"],
      ["no ff", [{ fl: "lowpass" }], "TypeError", "ff: undefined"],
      ["ff a string", [{ fl: "lowpass", ff: "1000" }], "TypeError", "ff: 1000"],
      ["ff 0", [{ fl: "lowpass", ff: 0 }], "RangeError", "ff: 0"],
      ["ff negative", [{ fl: "lowpass", ff: -1 }], "RangeError", "ff: -1"],
      ["ff NaN", [{ fl: "lowpass", ff: NaN }], "RangeError", "ff: NaN"],
      ["ff Infinity", [{ fl: "lowpass", ff: Infinity }], "RangeError", "ff: Infinity"],
      ["ff beyond the float range", [{ fl: "lowpass", ff: 1e39 }], "RangeError", "ff: 1e+39"],
      ["fq a string", [{ fl: "highpass", ff: 1000, fq: "2" }], "TypeError", "fq: 2"],
      ["fq null", [{ fl: "highpass", ff: 1000, fq: null }], "TypeError", "fq: null"],
      ["fq 0", [{ fl: "highpass", ff: 1000, fq: 0 }], "RangeError", "fq: 0"],
      ["fq negative", [{ fl: "highpass", ff: 1000, fq: -0.5 }], "RangeError", "fq: -0.5"],
      ["fq NaN", [{ fl: "highpass", ff: 1000, fq: NaN }], "RangeError", "fq: NaN"],
      ["fq beyond the float range (band-pass Q is set as given)", [{ fl: "bandpass", ff: 1000, fq: 1e39 }], "RangeError", "fq: 1e+39"],
      ["a low-pass fq below the normal floats (NaN coefficients in Chromium, review F1)", [{ fl: "lowpass", ff: 1000, fq: 1e-39 }], "RangeError", "fq: 1e-39"],
      ["a high-pass fq of 1e-300", [{ fl: "highpass", ff: 1000, fq: 1e-300 }], "RangeError", "fq: 1e-300"],
      ["a band-pass fq below the normal floats (one rule for every type)", [{ fl: "bandpass", ff: 1000, fq: 1e-39 }], "RangeError", "fq: 1e-39"],
      ["fq just under 2^-126", [{ fl: "lowpass", ff: 1000, fq: BELOW }], "RangeError", "fq: " + BELOW],
      ["the smallest double fq", [{ fl: "lowpass", ff: 1000, fq: 5e-324 }], "RangeError", "fq: 5e-324"],
      ["an ff the AudioParam stores as 0 Hz", [{ fl: "lowpass", ff: 1e-46 }], "RangeError", "ff: 1e-46"],
      ["a subnormal-float ff", [{ fl: "highpass", ff: 1e-40, fk: 1 }], "RangeError", "ff: 1e-40"],
      ["ff just under 2^-126", [{ fl: "bandpass", ff: BELOW }], "RangeError", "ff: " + BELOW],
      ["fk true", [{ fl: "lowpass", ff: 2, fk: true }], "TypeError", "fk: true"],
      ["fk 2", [{ fl: "lowpass", ff: 2, fk: 2 }], "RangeError", "fk: 2"],
      ["fk 0.5", [{ fl: "lowpass", ff: 2, fk: 0.5 }], "RangeError", "fk: 0.5"],
      ["fk NaN", [{ fl: "lowpass", ff: 2, fk: NaN }], "RangeError", "fk: NaN"],
      ["a later operator's bad field", [{ w: "square" }, { fl: "lowpass", ff: -5 }], "RangeError", "ff: -5"],
    ];
    test.each(rejected)("rejects %s before any change", (_, timbre, name, message) => {
      for (const [m, n] of [[0, 5], [1, 42]]) {
        const { synth } = make(variant);
        const slot = m ? synth.drummap[n - 35] : synth.program[n];
        const before = slot.p, saved = JSON.stringify(before), given = JSON.stringify(timbre, keep);
        let error = null;
        try {
          synth.setTimbre(m, n, timbre);
        } catch (e) {
          error = e;
        }
        expect(error && error.name).toBe(name);
        expect(error.message).toBe(message);
        expect(slot.p).toBe(before); // the slot keeps its timbre object
        expect(JSON.stringify(slot.p)).toBe(saved);
        expect(JSON.stringify(timbre, keep)).toBe(given); // the caller's operators were not filled with defaults
      }
    });

    test("a missing operator throws before anything changes", () => {
      const { synth } = make(variant);
      const before = synth.program[5].p;
      const timbre = [{ w: "square" }, null];
      let error = null;
      try {
        synth.setTimbre(0, 5, timbre);
      } catch (e) {
        error = e;
      }
      expect(error && error.name).toBe("TypeError");
      expect(synth.program[5].p).toBe(before);
      expect(timbre[0]).toEqual({ w: "square" });
    });

    test("the editor round trip reinstalls a filtered timbre as stored", () => {
      const { synth } = make(variant);
      synth.setTimbre(0, 5, [{ fl: "bandpass", ff: 1200, fq: 4 }, { g: 1, t: 0, f: 5, v: 0.01 }]);
      const stored = synth.program[5].p;
      expect(() => synth.setTimbre(0, 5, stored)).not.toThrow();
      expect(synth.program[5].p[0]).toMatchObject({ fl: "bandpass", ff: 1200, fq: 4, g: 0 });
      expect("fk" in synth.program[5].p[0]).toBe(false);
      expect("fl" in synth.program[5].p[1]).toBe(false);
    });

    test("every built-in timbre passes, in both qualities", () => {
      const { synth } = make(variant);
      for (const q of [0, 1]) expect(() => synth.setQuality(q)).not.toThrow();
    });
  });

  describe("graph and parameters", () => {
    test("no fl: no filter node, and the gain connects to the channel volume", () => {
      const s = make(variant);
      s.synth.setTimbre(0, 0, [{ w: "sawtooth", v: 0.3 }, { g: 1, t: 0, f: 5, v: 0.01 }]);
      const from = s.trace.length;
      s.synth.noteOn(3, 60, 100);
      expect(biquads(s.trace, from)).toEqual([]);
      const gains = calls(s.trace, from).filter(([op, id]) => op === "create" && id.startsWith("gain#")).map(([, id]) => id);
      const conn = calls(s.trace, from).filter(([op]) => op === "connect");
      expect(conn).toContainEqual(["connect", gains[0], s.synth.chvol[3]._id]);
      expect(voice(s.synth, 3, 60).q).toEqual([]);
    });

    test("a filtered output: oscillator -> gain -> BiquadFilter -> channel volume, with the defaults", () => {
      const s = make(variant);
      s.synth.setTimbre(0, 0, lead());
      const from = s.trace.length;
      s.synth.noteOn(2, 60, 100);
      const [b] = biquads(s.trace, from);
      expect(b).toEqual({ id: b.id, type: "lowpass", frequency: 1000, Q: SQRT1_2_DB });
      const c = calls(s.trace, from);
      const osc = c.find(([op, id]) => op === "create" && id.startsWith("osc#"))[1];
      const gain = c.find(([op, id]) => op === "create" && id.startsWith("gain#"))[1];
      const conn = c.filter(([op]) => op === "connect").map(([, a, z]) => [a, z]);
      expect(conn).toContainEqual([osc, gain]);
      expect(conn).toContainEqual([gain, b.id]);
      expect(conn).toContainEqual([b.id, s.synth.chvol[2]._id]);
      expect(conn.filter(([a]) => a === gain)).toEqual([[gain, b.id]]); // the gain no longer feeds the channel directly
      expect(voice(s.synth, 2, 60).q[0]._id).toBe(b.id);
    });

    test.each([
      ["lowpass", 2, 20 * Math.log10(2)],
      ["highpass", 2, 20 * Math.log10(2)],
      ["highpass", undefined, SQRT1_2_DB],
      ["lowpass", 30, 20 * Math.log10(30)],
      ["lowpass", 0.1, 20 * Math.log10(0.1)],
      ["bandpass", 5, 5],
      ["bandpass", undefined, Math.SQRT1_2],
      ["bandpass", 0.1, 0.1],
    ])("%s with fq %s sets Web Audio Q %d (dB for low- and high-pass, linear for band-pass)", (fl, fq, Q) => {
      const s = make(variant);
      s.synth.setTimbre(0, 0, lead({ fl, fq }));
      const from = s.trace.length;
      s.synth.noteOn(0, 60, 100);
      const [b] = biquads(s.trace, from);
      expect(b.type).toBe(fl);
      expect(b.Q).toBeCloseTo(Q, 12);
    });

    test("fk 1 tracks the note-on frequency across the keyboard; fk 0 stays fixed", () => {
      const s = make(variant);
      s.synth.setTimbre(0, 0, lead({ ff: 2, fk: 1 }));
      s.synth.setTimbre(0, 1, lead({ ff: 2000, fk: 0 }));
      s.synth.setProgram(1, 1);
      for (const n of [21, 36, 48, 60, 69, 72, 84, 90]) {
        const from = s.trace.length;
        s.synth.noteOn(0, n, 100);
        s.synth.noteOn(1, n, 100);
        const [tracked, fixed] = biquads(s.trace, from);
        expect(tracked.frequency).toBeCloseTo(2 * noteHz(n), 9);
        expect(fixed.frequency).toBe(2000);
      }
    });

    test("the basis includes master, channel and scale tuning", () => {
      const s = make(variant);
      s.synth.setTimbre(0, 0, lead({ ff: 1, fk: 1 }));
      const at = (ch, n) => {
        const from = s.trace.length;
        s.synth.noteOn(ch, n, 100);
        return biquads(s.trace, from)[0].frequency;
      };
      s.synth.send([0xf0, 0x7f, 0x7f, 0x04, 0x04, 0x00, 0x42, 0xf7]); // master coarse tuning +2 semitones
      expect(at(0, 60)).toBeCloseTo(noteHz(62), 9);
      s.synth.send([0xf0, 0x7f, 0x7f, 0x04, 0x04, 0x00, 0x40, 0xf7]); // back to 0
      s.synth.send([0xb1, 101, 0]); s.synth.send([0xb1, 100, 2]); s.synth.send([0xb1, 6, 0x43]); // channel coarse +3
      expect(at(1, 60)).toBeCloseTo(noteHz(63), 9);
      s.synth.send([0xb2, 101, 0]); s.synth.send([0xb2, 100, 1]); s.synth.send([0xb2, 6, 0x60]); s.synth.send([0xb2, 38, 0]); // channel fine +0.5
      expect(at(2, 60)).toBeCloseTo(noteHz(60.5), 9);
      s.synth.send([0xf0, 0x41, 0x10, 0x42, 0x12, 0x40, 0x14, 0x40, 0x40 + 25, 0x00, 0xf7]); // GS scale tuning, channel 4 (index 3), C +25 cents
      expect(at(3, 60)).toBeCloseTo(noteHz(60.25), 9);
    });

    test("the basis excludes operator ratio and offset, bend, pitch envelope and modulation", () => {
      const s = make(variant);
      s.synth.setTimbre(0, 0, lead({ ff: 3, fk: 1, t: 2.5, f: 37, p: 2, q: 0.05 }));
      s.synth.setBend(0, 16383); // full bend up
      s.synth.setModulation(0, 127);
      const from = s.trace.length;
      s.synth.noteOn(0, 57, 100);
      expect(biquads(s.trace, from)[0].frequency).toBeCloseTo(3 * noteHz(57), 9);
      // The filter is fixed: a later bend schedules nothing on it.
      const later = s.trace.length;
      s.synth.setBend(0, 0);
      expect(calls(s.trace, later).some(([, id]) => /^biquad#/.test(id))).toBe(false);
    });

    test.each([44100, 48000])("cutoffs at or above %d x 0.45 Hz are clamped there (Nyquist margin)", (sr) => {
      const s = make(variant, {}, sr);
      const top = CLAMP * sr;
      const cases = [
        [{ ff: 30000 }, 69, top], // fixed Hz above Nyquist
        [{ ff: sr / 2 }, 69, top], // exactly Nyquist
        [{ ff: top }, 69, top],
        [{ ff: top - 1 }, 69, top - 1], // just below the clamp: unchanged
        [{ ff: 8, fk: 1 }, 108, top], // key-tracked high note: 8 x 4186 Hz
        [{ ff: 16, fk: 1 }, 127, top],
        [{ ff: 8, fk: 1 }, 96, 8 * noteHz(96)], // 16.7 kHz: below the clamp at both rates
        [{ ff: FLOOR }, 69, FLOOR], // the smallest accepted value passes unchanged (a normal float, not 0 Hz)
      ];
      for (const [f, n, want] of cases) {
        s.synth.setTimbre(0, 0, lead(f));
        const from = s.trace.length;
        s.synth.noteOn(0, n, 100);
        expect(biquads(s.trace, from)[0].frequency).toBeCloseTo(want, 6);
      }
    });

    test("drums: a rhythm-channel timbre's output is filtered, with the drum note's frequency for fk 1", () => {
      const s = make(variant);
      s.synth.setTimbre(1, 42, hat());
      s.synth.setTimbre(1, 44, hat({ ff: 20, fk: 1 }));
      const from = s.trace.length;
      s.synth.noteOn(9, 42, 100);
      s.synth.noteOn(9, 44, 100);
      const [a, b] = biquads(s.trace, from);
      expect(a).toMatchObject({ type: "highpass", frequency: 3000, Q: SQRT1_2_DB });
      expect(b.frequency).toBeCloseTo(20 * noteHz(44), 9);
      expect(s.synth._src.filter((v) => v.ch === 9).map((v) => v.q[0]._id)).toEqual([a.id, b.id]);
      const conn = calls(s.trace, from).filter(([op]) => op === "connect").map(([, x, y]) => [x, y]);
      expect(conn).toContainEqual([a.id, s.synth.chvol[9]._id]);
    });

    test("filter fields written past setTimbre on a modulator are ignored: modulation is never filtered", () => {
      const s = make(variant);
      s.synth.program[0].p = [
        { g: 0, w: "sine", t: 1, f: 0, v: 0.3, a: 0, h: 0.01, d: 0.01, s: 1, r: 0.05, p: 1, q: 1, k: 0 },
        { g: 1, w: "sine", t: 0, f: 5, v: 0.01, a: 0, h: 0.01, d: 0.01, s: 1, r: 0.05, p: 1, q: 1, k: 0, fl: "lowpass", ff: 100 },
      ];
      const from = s.trace.length;
      s.synth.noteOn(0, 60, 100);
      expect(biquads(s.trace, from)).toEqual([]);
      const oscs = calls(s.trace, from).filter(([op, id]) => op === "create" && id.startsWith("osc#")).map(([, id]) => id);
      const gains = calls(s.trace, from).filter(([op, id]) => op === "create" && id.startsWith("gain#")).map(([, id]) => id);
      expect(calls(s.trace, from)).toContainEqual(["connect", gains[1], oscs[0] + ".frequency"]);
    });

    test("one filter per filtered output operator; unfiltered outputs connect directly", () => {
      const s = make(variant);
      s.synth.setTimbre(0, 0, [{ w: "sawtooth", fl: "lowpass", ff: 3, fk: 1 }, { w: "square", v: 0.1 }, { w: "sawtooth", t: 1.005, fl: "lowpass", ff: 3, fk: 1 }]);
      const from = s.trace.length;
      s.synth.noteOn(5, 60, 100);
      const v = voice(s.synth, 5, 60);
      expect(biquads(s.trace, from).length).toBe(2);
      expect([!!v.q[0], !!v.q[1], !!v.q[2]]).toEqual([true, false, true]);
      expect(calls(s.trace, from)).toContainEqual(["connect", v.g[1]._id, s.synth.chvol[5]._id]);
    });
  });

  describe("lifecycle: a filter is released with its voice", () => {
    test("melodic release and pruning", () => {
      const s = make(variant);
      s.synth.setTimbre(0, 0, lead());
      s.synth.noteOn(0, 60, 100);
      s.synth.noteOff(0, 60);
      expect(filterEdges(s.trace).length).toBe(2); // gain -> filter -> channel, while it sounds
      s.step(1000); // the timer prunes it 3.5 x r after the release
      expect(s.synth.notetab.length).toBe(0);
      expect(heldFilters(s.synth).length).toBe(1); // stopped, waiting in _gone until it ends
      s.ended();
      expect(filterEdges(s.trace)).toEqual([]);
      expect(heldFilters(s.synth)).toEqual([]);
    });

    test("voice stealing releases the stolen voices' filters and keeps the rest", () => {
      const s = make(variant, { voices: 3 });
      s.synth.setTimbre(0, 0, lead());
      for (let n = 60; n < 66; ++n) s.synth.noteOn(0, n, 100);
      s.ended();
      expect(s.synth.notetab.length).toBe(3);
      expect(biquads(s.trace).length).toBe(6);
      const live = s.synth.notetab.map((v) => v.q[0]._id).sort();
      expect([...new Set(filterEdges(s.trace).flat().filter((id) => id.startsWith("biquad#")))].sort()).toEqual(live);
      expect(filterEdges(s.trace).length).toBe(6);
    });

    test("all-sound-off, a caller's stopMIDI() (D-023) with a filtered hit scheduled ahead, and the hit's own end", () => {
      const s = make(variant);
      s.synth.setTimbre(0, 0, lead());
      s.synth.setTimbre(1, 42, hat());
      s.synth.noteOn(0, 60, 100);
      s.synth.allSoundOff(0);
      s.ended();
      expect(filterEdges(s.trace)).toEqual([]);
      // A hit that ends by itself.
      s.synth.noteOn(9, 42, 100);
      expect(filterEdges(s.trace).length).toBe(2);
      s.step(400);
      s.ended();
      expect(filterEdges(s.trace)).toEqual([]);
      expect(heldFilters(s.synth)).toEqual([]); // the timer dropped it from _src
      // A hit scheduled ahead, then a caller's stop.
      s.synth.noteOn(9, 42, 100, s.env.clock.ms / 1000 + 0.15);
      s.synth.stopMIDI();
      s.ended();
      expect(filterEdges(s.trace)).toEqual([]);
      expect(heldFilters(s.synth)).toEqual([]);
    });

    // Program 1 (not 0): the warm-up note setAudioContext() plays uses program 0.
    test("context replacement: the old graph's filters are disconnected (at once on a context the synth closes)", () => {
      const s = make(variant);
      s.synth.setTimbre(0, 1, lead());
      s.synth.setTimbre(1, 42, hat({ d: 2 }));
      s.synth.setProgram(0, 1);
      s.synth.setProgram(1, 1);
      s.synth.noteOn(0, 60, 100);
      s.synth.noteOn(9, 42, 100);
      s.synth.noteOn(1, 64, 100); s.synth.noteOff(1, 64);
      s.synth.allSoundOff(1); // a stopped voice waiting in _gone
      expect(filterEdges(s.trace).length).toBe(6); // three filtered voices: channel 0, the hit, and the one in _gone
      s.synth.setAudioContext(new s.Base());
      expect(filterEdges(s.trace)).toEqual([]);
      expect(heldFilters(s.synth)).toEqual([]);
    });

    test("context replacement on a caller-owned context: released when the sources end", () => {
      const s = make(variant, {}, 44100);
      s.synth.setTimbre(0, 1, lead());
      s.synth.setProgram(0, 1);
      s.synth.noteOn(0, 60, 100);
      s.synth.setAudioContext(new s.Base());
      expect(filterEdges(s.trace).length).toBe(2); // the caller's context stays open: wait for ended
      s.ended();
      expect(filterEdges(s.trace)).toEqual([]);
    });

    test("dispose() releases every filter", async () => {
      const s = make(variant);
      s.synth.setTimbre(0, 0, lead());
      s.synth.setTimbre(1, 42, hat({ d: 2 }));
      for (let n = 50; n < 70; n += 3) s.synth.noteOn(n % 4, n, 100);
      s.synth.noteOn(9, 42, 100);
      await s.synth.dispose();
      expect(filterEdges(s.trace)).toEqual([]);
      expect(heldFilters(s.synth)).toEqual([]);
    });

    /*
     * Review F2: filters on operator 1 and later, with operator 0 unfiltered (so a release of
     * q[0] in place of q[i] releases nothing), through each release path.
     */
    const later = [{ w: "square", v: 0.1, s: 1, r: 0.05 }, { w: "sawtooth", v: 0.2, s: 1, r: 0.05, fl: "lowpass", ff: 2, fk: 1 }, { w: "sawtooth", t: 1.01, v: 0.2, s: 1, r: 0.05, fl: "bandpass", ff: 900, fq: 3 }];
    const laterHat = (d = 0.04) => [{ w: "triangle", t: 0, f: 180, v: 0.3, d }, { w: "n1", t: 0, f: 440, v: 0.3, d: 0.04, fl: "highpass", ff: 3000 }];
    const onLater = (v) => [v.q[0], v.q[1] && v.q[1]._id, v.q[2] && v.q[2]._id];
    test("filters on operator 1 and later: released through prune and release", () => {
      const s = make(variant);
      s.synth.setTimbre(0, 1, later);
      s.synth.setProgram(4, 1);
      s.synth.noteOn(4, 60, 100);
      expect(onLater(voice(s.synth, 4, 60))[0]).toBeUndefined();
      expect(filterEdges(s.trace).length).toBe(4);
      s.synth.noteOff(4, 60);
      s.step(1000);
      s.ended();
      expect(filterEdges(s.trace)).toEqual([]);
      expect(heldFilters(s.synth)).toEqual([]);
    });
    test("filters on operator 1 and later: released through a drum hit's own end", () => {
      const s = make(variant);
      s.synth.setTimbre(1, 38, laterHat());
      s.synth.noteOn(9, 38, 100);
      expect(s.synth._src[s.synth._src.length - 1].q[0]).toBeUndefined();
      expect(filterEdges(s.trace).length).toBe(2);
      s.step(400);
      s.ended();
      expect(filterEdges(s.trace)).toEqual([]);
      expect(heldFilters(s.synth)).toEqual([]);
    });
    test("filters on operator 1 and later: released through replacement and dispose()", async () => {
      const s = make(variant);
      s.synth.setTimbre(0, 1, later);
      s.synth.setTimbre(1, 38, laterHat(2));
      s.synth.setProgram(4, 1);
      s.synth.noteOn(4, 60, 100);
      s.synth.noteOn(9, 38, 100);
      expect(filterEdges(s.trace).length).toBe(6);
      s.synth.setAudioContext(new s.Base()); // the synth's own context: torn down at once
      expect(filterEdges(s.trace)).toEqual([]);
      s.synth.setProgram(4, 1); // setAudioContext() reset the channels; the timbres stay
      s.synth.noteOn(4, 62, 100);
      s.synth.noteOn(9, 38, 100);
      expect(filterEdges(s.trace).length).toBe(6);
      await s.synth.dispose(); // the new context is the caller's: released when the sources end
      s.ended();
      expect(filterEdges(s.trace)).toEqual([]);
      expect(heldFilters(s.synth)).toEqual([]);
    });

    test("many notes, drum hits, steals, stops and replacements leave no filter connection", async () => {
      const s = make(variant, { voices: 8 });
      s.synth.setTimbre(0, 0, lead({ ff: 2, fk: 1 }));
      s.synth.setTimbre(0, 1, lead({ fl: "bandpass", ff: 900, fq: 4 }));
      s.synth.setTimbre(1, 42, hat());
      s.synth.setProgram(1, 1);
      let filters = 0;
      for (let k = 0; k < 300; ++k) {
        const t = s.env.clock.ms / 1000;
        if (k % 3 === 2) s.synth.noteOn(9, 42, 100, t + 0.01);
        else {
          s.synth.noteOn(k % 2, 40 + (k * 7) % 50, 100, t);
          s.synth.noteOff(k % 2, 40 + (k * 7) % 50, t + 0.05);
        }
        ++filters;
        if (k % 50 === 49) s.synth.stopMIDI();
        if (k === 150) s.synth.setAudioContext(new s.Base());
        s.step(60);
        s.ended();
      }
      // Plus one: the warm-up note setAudioContext() plays on channel 0, whose program is the filtered lead.
      expect(biquads(s.trace).length).toBe(filters + 1);
      s.step(2000);
      s.ended();
      expect(filterEdges(s.trace)).toEqual([]);
      expect(heldFilters(s.synth)).toEqual([]);
      await s.synth.dispose();
      expect(filterEdges(s.trace)).toEqual([]);
    });
  });
});

/*
 * With T11's registry (#26): a filter on an operator that plays a registered wave, and failed
 * allocation (review F3, PR #46 Codex LOW). A note whose wave cannot be resolved is dropped before
 * any source, gain or filter exists; setTimbre rejects an unknown wave before installing anything.
 */
describe.each(variants)("$name: filters with registered waves, and failed allocation", (variant) => {
  const PULSE8 = [0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5];
  test("a registered sample wave through a filter on the same operator: buffer at its home pitch, filter on the note frequency", () => {
    const s = make(variant);
    s.synth.setSampleWave("nPulse", PULSE8);
    s.synth.setTimbre(0, 0, [{ w: "nPulse", s: 1, r: 0.05, fl: "lowpass", ff: 2, fk: 1, fq: 3 }]);
    const from = s.trace.length;
    s.synth.noteOn(5, 60, 100);
    const c = calls(s.trace, from);
    const src = c.find(([op, id]) => op === "create" && id.startsWith("src#"))[1];
    const gain = c.find(([op, id]) => op === "create" && id.startsWith("gain#"))[1];
    const [bq] = biquads(s.trace, from);
    const k = Math.round(44100 / (440 * 8)), base = 44100 / (8 * k); // D-027 held storage
    expect(c.find(([op, id]) => op === "value" && id === src + ".playbackRate")[2]).toBeCloseTo(noteHz(60) / base, 12);
    expect(bq).toMatchObject({ type: "lowpass", Q: 20 * Math.log10(3) });
    expect(bq.frequency).toBeCloseTo(2 * noteHz(60), 9); // the note's frequency, not the buffer's home pitch
    const conn = c.filter(([op]) => op === "connect").map(([, x, y]) => [x, y]);
    expect(conn).toContainEqual([src, gain]);
    expect(conn).toContainEqual([gain, bq.id]);
    expect(conn).toContainEqual([bq.id, s.synth.chvol[5]._id]);
    s.synth.noteOff(5, 60);
    s.step(1000);
    s.ended();
    expect(filterEdges(s.trace)).toEqual([]);
    expect(heldFilters(s.synth)).toEqual([]);
  });

  test("a registered harmonic wave through a band-pass, and the pair through replacement and dispose()", async () => {
    const s = make(variant);
    s.synth.setHarmonicWave("wOdd", [0, 0, 0, 0], [0, 1, 0, 1 / 3]);
    s.synth.setSampleWave("nPulse", PULSE8);
    s.synth.setTimbre(0, 1, [{ w: "wOdd", s: 1, fl: "bandpass", ff: 1200, fq: 4 }, { w: "nPulse", s: 1, fl: "highpass", ff: 300 }]);
    s.synth.setProgram(5, 1);
    const from = s.trace.length;
    s.synth.noteOn(5, 64, 100);
    expect(calls(s.trace, from).some(([op]) => op === "setPeriodicWave")).toBe(true);
    expect(biquads(s.trace, from).map((x) => [x.type, x.frequency])).toEqual([["bandpass", 1200], ["highpass", 300]]);
    expect(filterEdges(s.trace).length).toBe(4);
    s.synth.setAudioContext(new s.Base()); // the synth's own context: torn down at once; waves rebuilt for the new one
    expect(filterEdges(s.trace)).toEqual([]);
    s.synth.setProgram(5, 1);
    s.synth.noteOn(5, 64, 100);
    expect(filterEdges(s.trace).length).toBe(4);
    await s.synth.dispose();
    s.ended();
    expect(filterEdges(s.trace)).toEqual([]);
    expect(heldFilters(s.synth)).toEqual([]);
  });

  test("failed allocation: setTimbre rejects an unknown wave next to a filter before installing anything", () => {
    const s = make(variant);
    const before = s.synth.program[0].p;
    const timbre = [{ w: "sine", s: 1, fl: "lowpass", ff: 1000 }, { w: "wmissing" }]; // PR #46 Codex LOW
    let error = null;
    try {
      s.synth.setTimbre(0, 0, timbre);
    } catch (e) {
      error = e;
    }
    expect(error && error.name).toBe("TypeError");
    expect(s.synth.program[0].p).toBe(before);
    expect(timbre[0]).toEqual({ w: "sine", s: 1, fl: "lowpass", ff: 1000 });
  });

  test("failed allocation: a note whose later operator's wave is missing creates no source, gain or filter", () => {
    const s = make(variant, { voices: 4 });
    const full = (o) => Object.assign({ g: 0, w: "sine", t: 1, f: 0, v: 0.3, a: 0, h: 0.01, d: 0.01, s: 1, r: 0.05, p: 1, q: 1, k: 0 }, o);
    s.synth.noteOn(1, 50, 100); // a sounding voice that must not be stolen for the dropped notes
    const voices = s.synth.notetab.length;
    for (const missing of ["wmissing", "nmissing"]) {
      // written past setTimbre, as TinyChip writes program slots: operator 0 is filtered, operator 1's wave is missing
      s.synth.program[0].p = [full({ fl: "lowpass", ff: 1000 }), full({ w: missing })];
      const from = s.trace.length;
      for (let k = 0; k < 3; ++k) s.synth.noteOn(0, 60 + k, 100);
      expect(calls(s.trace, from)).toEqual([]);
      expect(s.synth.notetab.length).toBe(voices);
    }
    expect(biquads(s.trace)).toEqual([]);
    expect(filterEdges(s.trace)).toEqual([]);
  });
});

describe("source and minified builds", () => {
  test("make identical WebAudio calls with filtered timbres", () => {
    const traces = variants.map((variant) => {
      const s = make(variant, {}, 48000);
      s.synth.setTimbre(0, 0, lead({ ff: 2, fk: 1, fq: 3 }));
      s.synth.setTimbre(0, 1, [{ w: "n0", fl: "bandpass", ff: 1200, fq: 4 }, { g: 1, t: 0, f: 5, v: 0.01 }]);
      s.synth.setTimbre(1, 42, hat());
      s.synth.setProgram(1, 1);
      for (const n of [36, 60, 96, 108]) s.synth.noteOn(0, n, 100);
      s.synth.noteOn(1, 60, 90);
      s.synth.noteOn(9, 42, 100);
      s.step(500);
      s.synth.allSoundOff(0);
      s.ended();
      return s.trace;
    });
    expect(traces[1]).toEqual(traces[0]);
    expect(traces[0].some((l) => l.includes("biquad#"))).toBe(true);
  });
});

/*
 * The pinned consumer fixture (tests/fixtures/consumer/filters-setup.json): onchain-tinysynth
 * SynthSettings with a filter on three timbres, hand-built from its Filter type (its v1 validation
 * still rejects filters), and the TinySynth timbres D-007's mapping gives.
 */
describe("consumer fixture (filters-setup.json)", () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(H.ROOT, "tests", "fixtures", "consumer", "filters-setup.json"), "utf8"));
  const WAVES = { Sine: "sine", Square: "square", Sawtooth: "sawtooth", Triangle: "triangle", WhiteNoise: "n0", MetallicNoise: "n1" };
  const KINDS = { LowPass: "lowpass", HighPass: "highpass", BandPass: "bandpass" };
  const FIELDS = [["volume", "v"], ["ratio", "t"], ["offset_hz", "f"], ["attack", "a"], ["hold", "h"], ["decay", "d"], ["sustain", "s"], ["release", "r"], ["pitch_ratio", "p"], ["pitch_time", "q"], ["key_scale", "k"]];
  const fx = (x) => x / 10000;
  const toOps = (timbre) => timbre.operators.map((o) => {
    const p = { g: o.route, w: WAVES[o.wave] };
    for (const [name, key] of FIELDS) p[key] = fx(o[name]);
    if (o.filter) Object.assign(p, { fl: KINDS[o.filter.kind], ff: fx(o.filter.cutoff), fk: o.filter.key_track ? 1 : 0, fq: fx(o.filter.q) });
    return p;
  });
  /* The consumer's SETTINGS grammar (src/settings.cairo), for these fields. */
  const encode = (s) => {
    const out = [1, s.quality, s.reverb, s.master_vol, s.voices, s.waves.length, s.timbres.length];
    for (const t of s.timbres) {
      out.push(t.drum ? 1 : 0, t.slot, t.operators.length);
      for (const o of t.operators) {
        out.push(o.route, Object.keys(WAVES).indexOf(o.wave), ...FIELDS.map(([name]) => o[name]));
        if (o.filter) out.push(1, Object.keys(KINDS).indexOf(o.filter.kind), o.filter.cutoff, o.filter.key_track ? 1 : 0, o.filter.q);
        else out.push(0);
      }
    }
    return out.join(",");
  };

  test("records its provenance, and its TinySynth timbres follow D-007's mapping", () => {
    expect(fixture.consumer.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(encode(fixture.settings)).toBe(fixture.settings_text);
    expect(fixture.tinysynth).toEqual(fixture.settings.timbres.map((t) => [t.drum ? 1 : 0, t.slot, toOps(t)]));
    const kinds = fixture.settings.timbres.flatMap((t) => t.operators.filter((o) => o.filter).map((o) => o.filter.kind));
    expect(new Set(kinds)).toEqual(new Set(["LowPass", "HighPass", "BandPass"]));
  });

  test.each(variants)("installs and plays on $name in both qualities, with the expected filters", (variant) => {
    for (const quality of [0, 1]) {
      const s = make(variant, { quality, useReverb: fixture.settings.reverb > 0 ? 1 : 0 }, 48000);
      s.synth.setQuality(quality);
      for (const [m, n, ops] of fixture.tinysynth) s.synth.setTimbre(m, n, JSON.parse(JSON.stringify(ops)));
      for (const [m, n, ops] of fixture.tinysynth) {
        const ch = m ? 9 : 0, note = m ? n : 60;
        if (!m) s.synth.setProgram(0, n);
        const from = s.trace.length;
        s.synth.noteOn(ch, note, 100);
        s.synth.noteOff(ch, note, s.env.clock.ms / 1000 + 0.1);
        const want = ops.filter((o) => o.fl && o.g === 0).map((o) => ({
          type: o.fl,
          frequency: Math.min(o.fk ? o.ff * noteHz(note) : o.ff, CLAMP * 48000),
          Q: o.fl === "bandpass" ? o.fq : 20 * Math.log10(o.fq),
        }));
        const got = biquads(s.trace, from);
        expect(got.length).toBe(want.length);
        got.forEach((b, i) => {
          expect(b.type).toBe(want[i].type);
          expect(b.frequency).toBeCloseTo(want[i].frequency, 9);
          expect(b.Q).toBeCloseTo(want[i].Q, 12);
        });
      }
      s.step(3000);
      s.ended();
      expect(filterEdges(s.trace)).toEqual([]);
    }
  });
});
