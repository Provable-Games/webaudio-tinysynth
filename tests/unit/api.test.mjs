/*
 * Public input and timbre contracts (#13) and URL loading (#14), T5, on the
 * mock WebAudio of tests/harness.js, for both builds.
 *
 * Numbers: every numeric argument is a number or a non-blank numeric string
 * (read with Number()), finite and in range; indices are integers. Misuse
 * throws a TypeError or RangeError before anything changes (no state, no
 * WebAudio call, no lazy context). A malformed raw message passed to send()
 * does nothing. Timbres are validated, copied and normalized; the caller's
 * objects are never modified. Expected values come from the MIDI
 * specification, tasks/T5.md, or upstream's own installed tables.
 *
 * loadMIDIUrl() runs against a mock XMLHttpRequest driven by each test.
 */
import vm from "node:vm";
import { describe, expect, test } from "vitest";
import { H, variants } from "./helpers.mjs";

const PPQ = 480;
const { noteOn, noteOff } = H.midi;
const song = (events) => H.toArrayBuffer(H.makeMidi(PPQ, events));
const SONG_A = song([noteOn(0, 0, 60, 100), noteOff(960, 0, 60)]); // maxTick 960
const SONG_B = song([noteOn(0, 0, 64, 100), noteOff(1920, 0, 64)]); // maxTick 1920
const SONG_C = song([noteOn(0, 0, 67, 100), noteOff(480, 0, 67)]); // maxTick 480
const flush = () => new Promise((resolve) => setImmediate(resolve));
const settle = (p) => p.then((v) => ["resolved", v], (e) => ["rejected", e]);

/*
 * A synth on the harness's mock WebAudio, as H.createSynth makes it ({synth,
 * env, trace, notes}), but its contexts report a 2 kHz sample rate, so the
 * generated noise and reverb buffers are short and construction is fast
 * (nothing here depends on the rate), and its AudioParams take only float32
 * values, as WebIDL makes real engines do: a value past the float32 range
 * throws a TypeError. `setup(sandbox)` runs before the library is loaded.
 */
function synthFor(variant, opts, setup) {
  const trace = [], notes = [];
  const env = H.createEnvironment(trace);
  const Base = env.sandbox.AudioContext;
  const P = Object.getPrototypeOf(new Base().createGain().gain);
  trace.length = 0;
  const f32 = (v) => { if (!Number.isFinite(Math.fround(v))) throw new TypeError("The provided float value is non-finite."); };
  const value = Object.getOwnPropertyDescriptor(P, "value");
  Object.defineProperty(P, "value", { get: value.get, set(v) { f32(v); value.set.call(this, v); } });
  for (const m of ["setValueAtTime", "linearRampToValueAtTime", "exponentialRampToValueAtTime", "setTargetAtTime"]) {
    const call = P[m];
    P[m] = function (v, ...rest) { f32(v); return call.call(this, v, ...rest); };
  }
  env.sandbox.AudioContext = class extends Base { constructor() { super(); this.sampleRate = 2000; } };
  if (setup) setup(env.sandbox);
  vm.runInContext(variant.source, env.sandbox, { filename: variant.name });
  const synth = new env.sandbox.WebAudioTinySynth(opts);
  const note = synth._note;
  synth._note = (...a) => { notes.push(a); return note(...a); };
  return { synth, env, trace, notes };
}

/* The error `fn` throws (from the library's realm, so read by name and message), or null. */
function thrown(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}

/* Everything a rejected call must leave as it was. */
function snapshot(s) {
  const y = s.synth;
  return JSON.stringify([H.playbackState(y), y.quality, y.masterVol, y.reverbLev, y.voices, y.loop, y.loopEnd, s.trace.length, y.getAudioContext() === null]);
}

/* The mock WebAudio calls since `from`, parsed. */
const calls = (trace, from = 0) => trace.slice(from).map((line) => JSON.parse(line));

/*
 * A legacy filler for the built-in tables, written from the README and
 * upstream's setTimbre: for each operator, every default key that is not an
 * own property, or is undefined, is appended in this order.
 */
const DEFAULTS = { g: 0, w: "sine", t: 1, f: 0, v: 0.5, a: 0, h: 0.01, d: 0.01, s: 0, r: 0.05, p: 1, q: 1, k: 0 };

/* The numeric contracts, one row per argument: [method, args(x), name in the message, lo, hi, integer, optional]. */
const T = [{ w: "square", v: 0.3 }];
const CONTRACTS = [
  ["noteOn", (x) => [x, 60, 100], "channel", 0, 15, true],
  ["noteOn", (x) => [0, x, 100], "note", 0, 127, true],
  ["noteOn", (x) => [0, 60, x], "velocity", 0, 127, false],
  ["noteOn", (x) => [0, 60, 100, x], "time", 0, null, false, true],
  ["noteOff", (x) => [x, 60], "channel", 0, 15, true],
  ["noteOff", (x) => [0, x], "note", 0, 127, true],
  ["noteOff", (x) => [0, 60, x], "time", 0, null, false, true],
  ["setProgram", (x) => [x, 5], "channel", 0, 15, true],
  ["setProgram", (x) => [0, x], "program", 0, 127, true],
  ["setBendRange", (x) => [x, 256], "channel", 0, 15, true],
  ["setBendRange", (x) => [0, x], "bend range", 0, 16383, false],
  ["setBend", (x) => [x, 8192], "channel", 0, 15, true],
  ["setBend", (x) => [0, x], "bend", 0, 16383, false],
  ["setBend", (x) => [0, 8192, x], "time", 0, null, false, true],
  ...["setModulation", "setChVol", "setPan", "setExpression", "setSustain"].flatMap((m) => [
    [m, (x) => [x, 64], "channel", 0, 15, true],
    [m, (x) => [0, x], "value", 0, 127, false],
    [m, (x) => [0, 64, x], "time", 0, null, false, true],
  ]),
  ["allSoundOff", (x) => [x], "channel", 0, 15, true],
  ["resetAllControllers", (x) => [x], "channel", 0, 15, true],
  ["setMasterVol", (x) => [x], "masterVol", 0, 3.4e38, false, true], // float32, the AudioParam range
  ["setReverbLev", (x) => [x], "reverbLev", 0, 4.25e37, false, true], // float32 / 8: the reverb gain is 8x
  ["setQuality", (x) => [x], "quality", 0, 1, true, true],
  ["setVoices", (x) => [x], "voices", 1, 0xffffffff, true],
  ["setLoopEnd", (x) => [x], "loopEnd", 0, null, true],
  ["getTimbreName", (x) => [x, 40], "m", 0, 1, true], // 40 is both a program and a drum
  ["getTimbreName", (x) => [0, x], "program", 0, 127, true],
  ["getTimbreName", (x) => [1, x], "drum", 35, 81, true],
  ["setTimbre", (x) => [x, 40, T], "m", 0, 1, true],
  ["setTimbre", (x) => [0, x, T], "program", 0, 127, true],
  ["setTimbre", (x) => [1, x, T], "drum", 35, 81, true],
  ["send", (x) => [[0x90, 60, 100], x], "time", 0, null, false, true],
];

/* Values each contract accepts and rejects. `optional` arguments accept undefined and null (now, or the current value). */
function cases(lo, hi, integer, optional) {
  const top = hi === null ? 1e9 : hi;
  const accept = [lo, top, lo + 1, String(lo + 1), " " + (lo + 1) + " "];
  if (!integer) accept.push(lo + 0.5);
  if (optional) accept.push(undefined, null);
  const range = [lo - 1, NaN, Infinity, -Infinity, "abc", "1x"];
  const over = hi > 2 ** 53 ? hi * 1.03 : hi + 1; // hi + 1 rounds back to hi above 2^53
  if (hi !== null) range.push(over, String(over));
  if (integer) range.push(lo + 0.5, String(lo + 0.5));
  const type = ["", "  ", true, false, {}, [], () => 1];
  if (!optional) type.push(undefined, null);
  return { accept, range, type };
}

for (const variant of variants) {
  describe(variant.name + ": numeric contracts (#13)", () => {
    for (const [method, args, name, lo, hi, integer, optional] of CONTRACTS) {
      test(method + ": " + name + " " + lo + "-" + (hi === null ? "finite" : hi) + (integer ? ", integer" : "") + (optional ? ", optional" : ""), () => {
        const { accept, range, type } = cases(lo, hi, integer, optional);
        const fails = [];
        for (const [kind, values] of [["RangeError", range], ["TypeError", type]]) {
          for (const x of values) {
            const s = synthFor(variant, { lazy: true }); // a rejected call must not create the context either
            const before = snapshot(s);
            const e = thrown(() => s.synth[method](...args(x)));
            if (!e || e.name !== kind || !e.message.startsWith(name + " ")) fails.push([String(x), e ? e.name + ": " + e.message : "no error"]);
            else if (snapshot(s) !== before) fails.push([String(x), "state changed"]);
          }
        }
        for (const x of accept) {
          const s = synthFor(variant);
          const e = thrown(() => s.synth[method](...args(x)));
          if (e) fails.push([String(x), "rejected: " + e.message]);
        }
        expect(fails).toEqual([]);
      });
    }

    test("masterVol and reverbLev stay within float32: past it a RangeError before any change, and a lazy synth then starts and disposes normally (review F1)", async () => {
      const probe = synthFor(variant);
      expect(thrown(() => { probe.synth.out.gain.value = 1e39; }).name).toBe("TypeError"); // control: the mock is float32-strict
      for (const [m, limit, past] of [["setMasterVol", 3.4e38, 3.5e38], ["setReverbLev", 4.25e37, 4.3e37]]) {
        const s = synthFor(variant);
        const before = snapshot(s);
        for (const x of [past, 1e39, Number.MAX_VALUE]) expect(thrown(() => s.synth[m](x)).name).toBe("RangeError");
        expect(snapshot(s)).toBe(before);
        expect(thrown(() => s.synth[m](limit))).toBe(null);
        const lazy = synthFor(variant, { lazy: true });
        expect(thrown(() => lazy.synth[m](1e39)).name).toBe("RangeError");
        lazy.synth.noteOn(0, 60, 100);
        expect([lazy.synth.getAudioContext() !== null, lazy.synth._own]).toEqual([true, 1]);
        await lazy.synth.dispose();
        expect(calls(lazy.trace).filter((c) => c[0] === "close").length).toBe(1);
      }
    });

    test("a negative loopEnd written to the property (not validated, unlike setLoopEnd) cannot make a zero-length loop spin: it plays once and stops (review F4)", () => {
      const s = synthFor(variant);
      s.synth.loadMIDI(song([noteOn(0, 0, 60, 100), noteOff(0, 0, 60)]));
      s.synth.setLoop(1);
      s.synth.loopEnd = -480;
      const from = s.notes.length;
      s.synth.playMIDI();
      for (let i = 0; i < 50; ++i) s.env.step();
      expect(s.synth.getPlayStatus()).toEqual({ play: 0, maxTick: 0, curTick: 0 });
      expect(s.notes.length - from).toBe(1);
    });

    test("numeric strings are read with Number() and stored as numbers", () => {
      const s = synthFor(variant);
      const y = s.synth;
      y.setProgram("1", "40");
      y.setBendRange(" 2 ", "512");
      y.setSustain("3", "127");
      y.setMasterVol("0.25");
      y.setReverbLev("0.5");
      y.setVoices("32");
      y.setLoopEnd("1920");
      expect([y.pg[1], y.brange[2], y.sustain[3], y.masterVol, y.reverbLev, y.voices, y.loopEnd]).toEqual([40, 512, 127, 0.25, 0.5, 32, 1920]);
      expect(y.out.gain.value).toBe(0.25);
      expect(y.rev.gain.value).toBe(4);
      const from = s.trace.length;
      y.noteOn("0", "69", "127", "2");
      const started = calls(s.trace, from).filter((c) => c[0] === "start");
      expect(started.length).toBeGreaterThan(0);
      expect(started.every((c) => c[2] === 2)).toBe(true);
      expect(s.notes.at(-1).slice(0, 4)).toEqual([2, 0, 69, 127]);
    });

    test("setQuality: 0 and \"0\" select quality 0 (a legacy \"0\" selected 1); 2 and true are rejected", () => {
      const ref = synthFor(variant, { quality: 0 }).synth;
      for (const q of [0, "0", " 0 "]) {
        const s = synthFor(variant, { quality: 1 });
        s.synth.setQuality(q);
        expect(s.synth.quality).toBe(0);
        expect(JSON.stringify(s.synth.program)).toBe(JSON.stringify(ref.program));
      }
      const s = synthFor(variant, { quality: 1 });
      const before = JSON.stringify(s.synth.program);
      expect(thrown(() => s.synth.setQuality(2)).name).toBe("RangeError");
      expect(thrown(() => s.synth.setQuality(true)).name).toBe("TypeError");
      expect(thrown(() => synthFor(variant, { quality: "1.5" })).name).toBe("RangeError");
      expect([s.synth.quality, JSON.stringify(s.synth.program)]).toEqual([1, before]);
    });

    test("an invalid constructor option throws before any context is created", () => {
      const env = H.createEnvironment([]);
      let made = 0;
      const Base = env.sandbox.AudioContext;
      env.sandbox.AudioContext = class extends Base { constructor() { super(); ++made; } };
      vm.runInContext(variant.source, env.sandbox, { filename: variant.name });
      for (const opt of [{ quality: 2 }, { voices: 0 }, { voices: 1.5 }, { quality: "x" }]) {
        const e = thrown(() => new env.sandbox.WebAudioTinySynth(opt));
        expect(e && e.name).toBe("RangeError");
      }
      expect(made).toBe(0);
      new env.sandbox.WebAudioTinySynth({ quality: "0", voices: "8" });
      expect(made).toBe(1);
    });

    test("valid calls still sound in both quality modes, and a rejected one leaves the voices as they were", () => {
      for (const quality of [0, 1]) {
        const s = synthFor(variant, { quality });
        s.synth.noteOn(0, 60, 100, 1);
        s.synth.noteOn(9, 38, 100, 1);
        const voices = s.synth.notetab.length;
        expect(voices).toBe(2); // the warm-up note and the new one; drums are not voices
        const from = s.trace.length;
        for (const bad of [[16, 60, 100], [0, 128, 100], [0, 60, 128], [0, 60, NaN], [0, 60, 100, -1], [0, 60.5, 100]])
          expect(thrown(() => s.synth.noteOn(...bad))).not.toBe(null);
        expect([s.trace.length, s.synth.notetab.length]).toEqual([from, voices]);
      }
    });
  });

  describe(variant.name + ": raw messages through send() (#13)", () => {
    const MALFORMED = [
      ["empty", []], ["note-on without velocity", [0x90, 60]], ["note-on alone", [0x90]], ["program change alone", [0xc0]],
      ["controller without value", [0xb0, 7]], ["pitch bend without MSB", [0xe0, 0]],
      ["data byte 0x80", [0x90, 60, 0x80]], ["data byte 0xff", [0xb0, 7, 0xff]], ["negative data byte", [0x90, -1, 100]],
      ["fractional data byte", [0x90, 60.5, 100]], ["NaN data byte", [0x90, 60, NaN]], ["string data byte", [0x90, "60", 100]],
      ["null data byte", [0xc0, null]], ["no status byte", [60, 100, 0]], ["status 0x100", [0x100, 60, 100]],
      ["fractional status", [0x90 + 0.5, 60, 100]], ["string status", ["144", 60, 100]], ["NaN status", [NaN, 60, 100]],
      ["status past a byte (int32 wrap)", [2 ** 32 + 0x90, 60, 100]],
      ["SysEx master coarse tuning with a byte 0x80", [0xf0, 0x7f, 0x7f, 0x04, 0x04, 0x00, 0x80, 0xf7]],
      ["SysEx master fine tuning with NaN", [0xf0, 0x7f, 0x7f, 0x04, 0x03, NaN, 0x40, 0xf7]],
      ["GS scale tuning with undefined", [0xf0, 0x41, 0x10, 0x42, 0x12, 0x40, 0x11, 0x40, undefined, 0x00, 0xf7]],
      ["GS rhythm part with 0xf7 inside", [0xf0, 0x41, 0x10, 0x42, 0x12, 0x40, 0x11, 0x15, 0xf7, 0x00, 0xf7]],
    ];
    test("a malformed message does nothing: no state change and no WebAudio call", () => {
      const s = synthFor(variant);
      s.synth.noteOn(0, 60, 100, 1); // a sounding voice that a stray message must not touch
      const fails = [];
      for (const [name, msg] of MALFORMED) {
        const before = snapshot(s);
        const e = thrown(() => s.synth.send(msg, 2));
        if (e || snapshot(s) !== before) fails.push(name + (e ? ": " + e.message : ": changed"));
      }
      expect(fails).toEqual([]);
    });

    test("no malformed message puts a non-finite value into the WebAudio graph", () => {
      const s = synthFor(variant);
      const from = s.trace.length;
      for (const [, msg] of MALFORMED) s.synth.send(msg);
      s.synth.noteOn(0, 64, 100, 1); // a note after them all still has finite parameters
      expect(calls(s.trace, from).filter((c) => c.slice(2).some((x) => x === null))).toEqual([]);
    });

    test("well-formed messages still work, as arrays and as Uint8Arrays, with a SysEx 0xf7 terminator", () => {
      const s = synthFor(variant);
      const y = s.synth;
      y.send(new Uint8Array([0xc3, 40]));
      y.send([0xb3, 7, 64]);
      y.send([0xf0, 0x7f, 0x7f, 0x04, 0x04, 0x00, 0x42, 0xf7]); // master coarse tuning +2
      y.send([0xf0, 0x41, 0x10, 0x42, 0x12, 0x40, 0x12, 0x40, 0x50, 0x00, 0xf7]); // block 2 is channel 2: C +16 cents
      y.send([0xf0, 0x41, 0x10, 0x42, 0x12, 0x40, 0x12, 0x15, 0x01, 0x00, 0xf7]); // channel 2 becomes a rhythm part
      expect([y.pg[3], y.vol[3], y.masterTuningC, y.scaleTuning[1][0], y.rhythm[1]]).toEqual([40, 3 * 64 * 64 / (127 * 127), 2, 0.16, 1]);
      const from = s.trace.length;
      y.send(Uint8Array.of(0x93, 69, 100), 1);
      expect(s.notes.at(-1).slice(0, 4)).toEqual([1, 3, 69, 100]);
      expect(calls(s.trace, from).some((c) => c[0] === "start")).toBe(true);
      y.send([0xff]); // system reset
      expect([y.pg[3], y.masterTuningC]).toEqual([0, 0]);
    });

    test("a msg that is not an object, or a bad time, throws before anything changes", () => {
      const s = synthFor(variant, { lazy: true });
      const before = snapshot(s);
      for (const msg of [undefined, null, 0x90, "\x90<d", true]) expect(thrown(() => s.synth.send(msg)).name).toBe("TypeError");
      // a byte that cannot become a number at all: a TypeError, still before any change
      for (const msg of [[Symbol("x"), 60, 100], [0x90, 1n, 100], [0xf0, 0x7f, Symbol("x"), 0xf7]]) expect(thrown(() => s.synth.send(msg)).name).toBe("TypeError");
      for (const t of [-1, NaN, Infinity, "soon"]) expect(thrown(() => s.synth.send([0x90, 60, 100], t)).name).toBe("RangeError");
      expect(snapshot(s)).toBe(before);
    });
  });

  describe(variant.name + ": timbres (#13, ledger L-09)", () => {
    const deepFreeze = (o) => { Object.values(o).forEach((v) => v && typeof v === "object" && deepFreeze(v)); return Object.freeze(o); };

    test("the installed built-in tables equal upstream's in both quality modes (so the editor shows the same patch text)", () => {
      for (const quality of [0, 1]) {
        const fork = synthFor(variant, { quality }).synth;
        const up = synthFor({ source: H.referenceSource(), name: "upstream" }, { quality }).synth;
        expect(fork.program.map((x) => JSON.stringify(x.p))).toEqual(up.program.map((x) => JSON.stringify(x.p)));
        expect(fork.drummap.map((x) => JSON.stringify(x.p))).toEqual(up.drummap.map((x) => JSON.stringify(x.p)));
      }
    });

    test("built-in tables are copied: installing them fills no defaults into them, and editing an installed copy leaves them alone", () => {
      const s = synthFor(variant, { quality: 1 });
      const y = s.synth;
      const tables = () => JSON.stringify([y.program0, y.program1, y.drummap0, y.drummap1]);
      const before = tables();
      expect(Object.keys(y.program1[0][0])).toEqual(["w", "v", "d", "r"]); // as written in the source: no default filled in
      expect(Object.keys(y.program[0].p[0])).toEqual(["w", "v", "d", "r", "g", "t", "f", "a", "h", "s", "p", "q", "k"]);
      expect(y.program[0].p).not.toBe(y.program1[0]);
      y.program[0].p[0].v = 0.9; // soundedit's direct edit (T9A E6): the sound changes, the built-in table does not
      expect(y.program1[0][0].v).not.toBe(0.9);
      y.setQuality(0);
      y.setQuality(1);
      expect(y.program[0].p[0].v).toBe(y.program1[0][0].v);
      expect(tables()).toBe(before);
    });

    test("the caller's timbre is never modified, frozen ones work, and later caller edits do not reach the synth", () => {
      for (const quality of [0, 1]) {
        const s = synthFor(variant, { quality });
        const mine = [{ w: "square", v: "0.4", d: 0.2 }, { g: 1, t: 2, v: 30, extra: { keep: 1 } }];
        const copy = JSON.stringify(mine);
        s.synth.setTimbre(0, 5, mine);
        expect(JSON.stringify(mine)).toBe(copy);
        const installed = s.synth.program[5].p;
        expect(installed).not.toBe(mine);
        expect(installed[0]).not.toBe(mine[0]);
        expect(installed).toEqual([
          { w: "square", v: 0.4, d: 0.2, g: 0, t: 1, f: 0, a: 0, h: 0.01, s: 0, r: 0.05, p: 1, q: 1, k: 0 },
          { g: 1, t: 2, v: 30, extra: { keep: 1 }, w: "sine", f: 0, a: 0, h: 0.01, d: 0.01, s: 0, r: 0.05, p: 1, q: 1, k: 0 },
        ]);
        expect(Object.keys(installed[0])).toEqual(["w", "v", "d", "g", "t", "f", "a", "h", "s", "r", "p", "q", "k"]); // upstream's key order
        mine[0].v = 0.9;
        mine.push({ w: "sine" });
        expect(installed[0].v).toBe(0.4);
        expect(installed.length).toBe(2);
        const frozen = deepFreeze([{ w: "triangle", v: 0.2 }]);
        s.synth.setTimbre(1, 38, frozen);
        expect(s.synth.drummap[3].p[0]).toMatchObject({ w: "triangle", v: 0.2, g: 0, d: 0.01 });
      }
    });

    test("instances are isolated: one synth's setTimbre or edit does not reach another", () => {
      const s = synthFor(variant);
      const other = new s.synth.constructor({ quality: 1 });
      const before = JSON.stringify(other.program);
      s.synth.setTimbre(0, 0, [{ w: "sawtooth" }]);
      s.synth.program[1].p[0].v = 7;
      expect(JSON.stringify(other.program)).toBe(before);
      expect(s.synth.program[2].p).not.toBe(other.program[2].p);
    });

    test("missing and undefined fields take the defaults; unknown keys such as b and c are kept and do not change the sound", () => {
      const s = synthFor(variant);
      s.synth.setTimbre(0, 7, [{ w: "sine", v: undefined, b: 0, c: 0 }]);
      expect(s.synth.program[7].p[0]).toEqual({ ...DEFAULTS, b: 0, c: 0 });
      const play = (p) => {
        const t = synthFor(variant);
        t.synth.setTimbre(0, 0, p);
        const from = t.trace.length;
        t.synth.noteOn(0, 60, 100, 1);
        return calls(t.trace, from).map((c) => c.filter((x) => typeof x !== "string" || !x.includes("#")));
      };
      expect(play([{ w: "square", v: 0.3, b: 5, c: "x" }])).toEqual(play([{ w: "square", v: 0.3 }]));
    });

    test("a __proto__ key is kept as data: it cannot supply fields or link the installed copy to the caller's object (review F2)", () => {
      const s = synthFor(variant);
      const p = JSON.parse('[{"__proto__":{"w":"square","g":3},"v":0.3}]');
      const linked = Object.getOwnPropertyDescriptor(p[0], "__proto__").value;
      s.synth.setTimbre(0, 5, p);
      const op = s.synth.program[5].p[0];
      expect(Object.getPrototypeOf(op)).toBe(null);
      expect([op.w, op.g, Object.prototype.hasOwnProperty.call(op, "w")]).toEqual(["sine", 0, true]);
      expect(JSON.stringify(s.synth.program[5].p)).toBe('[{"__proto__":{"w":"square","g":3},"v":0.3,"g":0,"w":"sine","t":1,"f":0,"a":0,"h":0.01,"d":0.01,"s":0,"r":0.05,"p":1,"q":1,"k":0}]');
      linked.w = "saw";
      expect(s.synth.program[5].p[0].w).toBe("sine");
      s.synth.setTimbre(0, 6, [{ ["__proto__"]: { w: "saw" } }]);
      expect(s.synth.program[6].p[0].w).toBe("sine");
      const from = s.trace.length;
      s.synth.send([0xc0, 5]);
      s.synth.noteOn(0, 60, 100, 1);
      expect(calls(s.trace, from).filter((c) => c[0] === "type").map((c) => c[2])).toEqual(["sine"]); // not the caller's later "saw"
    });

    test("rejections: waves, routing, fields, operators and arrays, with nothing installed", () => {
      const GOOD = { w: "sine", v: 0.5 };
      const BAD = [
        ["unknown wave", [{ w: "saw" }], "TypeError", "operator 0 w"],
        ["unregistered w name", [{ w: "w1" }], "TypeError", "operator 0 w"],
        ["unknown n name", [{ w: "n2" }], "TypeError", "operator 0 w"],
        ["wave that is not a string", [{ w: 5 }], "TypeError", "operator 0 w"],
        ["null wave", [{ w: null }], "TypeError", "operator 0 w"],
        ["FM from operator 0", [{ g: 1 }], "RangeError", "operator 0 g"],
        ["AM from operator 0", [{ g: 11 }], "RangeError", "operator 0 g"],
        ["FM into itself", [GOOD, { g: 2 }], "RangeError", "operator 1 g"],
        ["FM into a later operator", [GOOD, GOOD, { g: 3 }, GOOD], "RangeError", "operator 2 g"],
        ["AM into itself", [GOOD, { g: 12 }], "RangeError", "operator 1 g"],
        ["fractional routing", [GOOD, { g: 1.5 }], "RangeError", "operator 1 g"],
        ["negative routing", [GOOD, { g: -1 }], "RangeError", "operator 1 g"],
        ["string routing", [GOOD, { g: "x" }], "RangeError", "operator 1 g"],
        ["null field", [{ v: null }], "TypeError", "operator 0 v"],
        ["boolean field", [{ k: true }], "TypeError", "operator 0 k"],
        ...["t", "f", "v", "a", "h", "d", "s", "r", "p", "q", "k"].flatMap((k) => [
          ["NaN " + k, [GOOD, { [k]: NaN }], "RangeError", "operator 1 " + k],
          ["Infinity " + k, [GOOD, { [k]: Infinity }], "RangeError", "operator 1 " + k],
        ]),
        ...["a", "h", "d", "r", "q"].map((k) => ["negative " + k, [{ [k]: -0.01 }], "RangeError", "operator 0 " + k]),
        ["operator null", [GOOD, null], "TypeError", "operator 1 "],
        ["operator number", [5], "TypeError", "operator 0 "],
        ["operator string", ["sine"], "TypeError", "operator 0 "],
        ["hole", [, GOOD], "TypeError", "operator 0 "], // eslint-disable-line no-sparse-arrays -- a sparse array on purpose
        ["empty", [], "TypeError", "timbre"],
        ["not an array", GOOD, "TypeError", "timbre"],
        ["array-like", { length: 1, 0: GOOD }, "TypeError", "timbre"],
        ["undefined", undefined, "TypeError", "timbre"],
      ];
      for (const quality of [0, 1]) {
        const s = synthFor(variant, { quality });
        const before = snapshot(s);
        const fails = [];
        for (const [name, p, kind, prefix] of BAD) {
          const e = thrown(() => s.synth.setTimbre(0, 3, p));
          if (!e || e.name !== kind || !e.message.startsWith(prefix)) fails.push([name, e ? e.name + ": " + e.message : "accepted"]);
        }
        expect(fails).toEqual([]);
        expect(snapshot(s)).toBe(before);
      }
    });

    test("accepted: every routing to an earlier operator, natural limits, and negative values where the field allows", () => {
      const s = synthFor(variant);
      const ops = (n, last) => [...Array.from({ length: n }, () => ({ w: "sine" })), last];
      const ok = [
        ops(1, { g: 1 }), ops(1, { g: 11 }), ops(2, { g: 2 }), ops(2, { g: 12 }), ops(10, { g: 10 }), ops(10, { g: 20 }),
        ops(11, { g: 10 }), ops(11, { g: 21 }),
        [{ t: 0, f: -2, v: 0, a: 0, h: 0, d: 0, s: 0, r: 0, p: 0, q: 0, k: -1.2 }],
        [{ t: -1, f: -20000, v: -1, s: -1, p: -1, k: -8 }],
        [{ t: 1e6, f: 1e6, v: 1e6, a: 1e6, h: 1e6, d: 1e6, s: 1e6, r: 1e6, p: 1e6, q: 1e6, k: 1e6 }],
        [{ w: "w9999" }, { w: "n0", g: 1 }, { w: "n1", g: 12 }, { w: "square" }, { w: "sawtooth" }, { w: "triangle" }],
      ];
      for (const p of ok) expect(thrown(() => s.synth.setTimbre(0, 3, p))).toBe(null);
      const bad11 = ops(11, { g: 11 + 11 }); // AM target 11 is the operator itself
      expect(thrown(() => s.synth.setTimbre(0, 3, bad11)).name).toBe("RangeError");
    });

    test("slots: programs 0-127 and drums 35-81; out of range now throws instead of doing nothing", () => {
      const s = synthFor(variant);
      expect([s.synth.getTimbreName(0, 0), s.synth.getTimbreName(1, 35), s.synth.getTimbreName("1", "81"), s.synth.getTimbreName(0, 127)])
        .toEqual(["Acoustic Grand Piano", "Acoustic Bass Drum", "Open Triangle", "Gunshot"]);
      s.synth.setTimbre(1, 81, [{ w: "n1" }]);
      expect(s.synth.drummap[46].p[0].w).toBe("n1");
      const before = snapshot(s);
      for (const [m, n] of [[0, 128], [1, 34], [1, 82], [2, 40], [-1, 0], [0, -1]])
        expect(thrown(() => s.synth.setTimbre(m, n, [{}])).name).toBe("RangeError");
      expect(snapshot(s)).toBe(before);
    });

    test("soundedit's round trip (mock level): read, edit with placeholder operators, setTimbre, play, setQuality, reapply", () => {
      for (const quality of [0, 1]) {
        const s = synthFor(variant, { quality });
        const y = s.synth;
        const prog = 24;
        const name = y.getTimbreName(0, prog);
        expect(name).toBe("Acoustic Guitar (nylon)");
        // ViewParam/ViewDef: the editor shows the installed patch as JSON.
        const shown = JSON.stringify(y.program[prog].p);
        // Edit(): a fresh array from the form (numbers from +input.value), padded with the editor's placeholder operator.
        const form = JSON.parse(shown);
        form[0].v = +"0.9";
        while (form.length < 4) form.push({ g: 0, w: "sine", v: 0, t: 0, f: 0, a: 0, h: 0, d: 1, s: 0, r: 1, b: 0, c: 0, p: 1, q: 1, k: 0 });
        const saved = JSON.stringify(form);
        y.setTimbre(0, prog, form);
        expect(JSON.stringify(form)).toBe(saved);
        expect(JSON.stringify(y.program[prog].p)).toBe(saved); // every key the form had, in the same order: the patch text round-trips
        y.send([0xc0, prog]);
        const from = s.trace.length;
        y.noteOn(0, 60, 127, 1);
        const edited = calls(s.trace, from);
        expect(edited.filter((c) => c[0] === "start").length).toBe(4);
        expect(s.notes.at(-1)[4][0].v).toBe(0.9);
        // setQuality() reinstalls the built-ins, so the editor reapplies its patch.
        y.setQuality(quality);
        expect(JSON.stringify(y.program[prog].p)).toBe(shown);
        y.setTimbre(0, prog, JSON.parse(saved));
        expect(JSON.stringify(y.program[prog].p)).toBe(saved);
        const again = s.trace.length;
        y.noteOn(0, 60, 127, 1);
        const replayed = calls(s.trace, again);
        const shape = (cs) => cs.map((c) => c.filter((x) => typeof x !== "string" || !x.includes("#")));
        expect(shape(replayed)).toEqual(shape(edited));
        expect(y.getTimbreName(0, prog)).toBe(name);
      }
    });
  });

  describe(variant.name + ": loadMIDIUrl (#14, ledger L-10)", () => {
    /*
     * A mock XMLHttpRequest. The test answers each request with respond(),
     * fail() or browserAbort(); abort() fires the abort event at once, as
     * browsers do. respond() after an abort() simulates a stale response.
     */
    function withXHR(opts, setup) {
      const s = synthFor(variant, opts, setup);
      const reqs = [];
      s.env.sandbox.XMLHttpRequest = class {
        constructor() { reqs.push(this); this.status = 0; this.response = null; this.sent = false; this.aborted = false; }
        open(method, url) { if (url === "bad url") throw new SyntaxError("bad url"); this.method = method; this.url = String(url); }
        send() { this.sent = true; }
        abort() { this.aborted = true; this.status = 0; if (this.onabort) this.onabort(); }
        respond(status, body) { this.status = status; this.response = body === undefined ? new ArrayBuffer(0) : body; if (this.onload) this.onload(); }
        fail() { if (this.onerror) this.onerror(); }
        browserAbort() { if (this.onabort) this.onabort(); }
      };
      s.reqs = reqs;
      return s;
    }
    const tick = (s) => s.synth.getPlayStatus().maxTick;
    const pending = (s) => s.synth._pend.size;

    test("success: one GET, the song is installed, and the promise resolves with the response's ArrayBuffer", async () => {
      const s = withXHR();
      s.synth.loadMIDI(SONG_A);
      const p = s.synth.loadMIDIUrl("song.mid");
      expect(typeof p.then).toBe("function");
      expect(s.reqs.map((r) => [r.method, r.url, r.responseType, r.sent])).toEqual([["GET", "song.mid", "arraybuffer", true]]);
      expect(tick(s)).toBe(960);
      s.reqs[0].respond(200, SONG_B);
      expect(await settle(p)).toEqual(["resolved", SONG_B]);
      expect([tick(s), pending(s)]).toEqual([1920, 0]);
    });

    test("status policy: 200-299 install; anything else rejects HTTP_STATUS with the status, and the song is kept", async () => {
      for (const [status, body, expected] of [[200, SONG_B, "ok"], [203, SONG_B, "ok"], [299, SONG_B, "ok"], [404, SONG_B, 404], [500, SONG_B, 500],
        [199, SONG_B, 199], [304, SONG_B, 304], [0, SONG_B, 0]]) {
        const s = withXHR();
        s.synth.loadMIDI(SONG_A);
        const before = snapshot(s);
        const p = s.synth.loadMIDIUrl("x.mid");
        s.reqs[0].respond(status, body);
        const [how, v] = await settle(p);
        if (expected === "ok") expect([how, tick(s)]).toEqual(["resolved", 1920]);
        else {
          expect([how, v.code, v.status, v.message]).toEqual(["rejected", "HTTP_STATUS", expected, "HTTP_STATUS"]);
          expect(snapshot(s)).toBe(before);
        }
      }
    });

    test("an empty 204 or malformed bytes reject with loadMIDI()'s error and keep the last valid song", async () => {
      for (const [status, body, code] of [[204, undefined, "SMF_INVALID_HEADER"], [200, new Uint8Array([1, 2, 3]).buffer, "SMF_INVALID_HEADER"],
        [200, SONG_B.slice(0, 30), "SMF_TRUNCATED"]]) {
        const s = withXHR();
        s.synth.loadMIDI(SONG_A);
        const before = snapshot(s);
        const p = s.synth.loadMIDIUrl("x.mid");
        s.reqs[0].respond(status, body);
        const [how, e] = await settle(p);
        expect([how, e.code]).toEqual(["rejected", code]);
        expect(snapshot(s)).toBe(before);
      }
    });

    test("a network error, or a request the browser aborts, rejects NETWORK_ERROR", async () => {
      for (const end of ["fail", "browserAbort"]) {
        const s = withXHR();
        s.synth.loadMIDI(SONG_A);
        const p = s.synth.loadMIDIUrl("x.mid");
        s.reqs[0][end]();
        const [how, e] = await settle(p);
        expect([how, e.code, tick(s), pending(s)]).toEqual(["rejected", "NETWORK_ERROR", 960, 0]);
      }
    });

    test("cancellation: opts.signal aborts the request and rejects with its reason; a late response installs nothing", async () => {
      const s = withXHR();
      s.synth.loadMIDI(SONG_A);
      const ac = new AbortController();
      const p = s.synth.loadMIDIUrl("x.mid", { signal: ac.signal });
      ac.abort();
      const [how, e] = await settle(p);
      expect([how, e.name, s.reqs[0].aborted, pending(s)]).toEqual(["rejected", "AbortError", true, 0]);
      s.reqs[0].respond(200, SONG_B);
      expect(tick(s)).toBe(960);
      const custom = new AbortController();
      const q = s.synth.loadMIDIUrl("y.mid", { signal: custom.signal });
      custom.abort("changed my mind");
      expect(await settle(q)).toEqual(["rejected", "changed my mind"]);
    });

    test("an abort with no reason or a falsy one rejects with an AbortError and never resolves (review F3, F6)", async () => {
      for (const reason of [0, "", null, false, NaN]) {
        const s = withXHR();
        s.synth.loadMIDI(SONG_A);
        const ac = new AbortController();
        const p = s.synth.loadMIDIUrl("x.mid", { signal: ac.signal });
        ac.abort(reason);
        const [how, e] = await settle(p);
        expect([String(reason), how, e && e.name, e && e.message, s.reqs[0].aborted, tick(s)]).toEqual([String(reason), "rejected", "AbortError", "Aborted", true, 960]);
        const pre = new AbortController();
        pre.abort(reason);
        const [how2, e2] = await settle(s.synth.loadMIDIUrl("y.mid", { signal: pre.signal }));
        expect([how2, e2 && e2.name, s.reqs.length]).toEqual(["rejected", "AbortError", 1]);
      }
      // A signal from an engine without AbortSignal.reason (before 2022).
      const s = withXHR();
      let fire = null;
      const old = { aborted: false, addEventListener: (type, f) => { fire = f; }, removeEventListener: () => {} };
      const p = s.synth.loadMIDIUrl("x.mid", { signal: old });
      old.aborted = true;
      fire();
      const [how, e] = await settle(p);
      expect([how, e.name, e.message, s.reqs[0].aborted]).toEqual(["rejected", "AbortError", "Aborted", true]);
      expect((await settle(s.synth.loadMIDIUrl("y.mid", { signal: { aborted: true } })))[1].name).toBe("AbortError");
    });

    test("that AbortError is a DOMException where the global scope has one", async () => {
      const s = withXHR(undefined, (sandbox) => { sandbox.DOMException = DOMException; });
      const ac = new AbortController();
      const p = s.synth.loadMIDIUrl("x.mid", { signal: ac.signal });
      ac.abort(0);
      const [how, e] = await settle(p);
      expect([how, e instanceof DOMException, e.name, e.message]).toEqual(["rejected", true, "AbortError", "Aborted"]);
    });

    test("an already aborted signal rejects without a request; a signal that is not an AbortSignal rejects TypeError without a request", async () => {
      const s = withXHR();
      const ac = new AbortController();
      ac.abort();
      expect((await settle(s.synth.loadMIDIUrl("x.mid", { signal: ac.signal })))[1].name).toBe("AbortError");
      expect(s.reqs.length).toBe(0);
      for (const signal of [{}, "x", 1]) {
        const [how, e] = await settle(s.synth.loadMIDIUrl("x.mid", { signal }));
        expect([how, e.name]).toEqual(["rejected", "TypeError"]);
      }
      expect(s.reqs.every((r) => !r.sent)).toBe(true);
      expect(pending(s)).toBe(0);
      const p = s.synth.loadMIDIUrl("x.mid", { signal: null }); // null: no signal
      expect(s.reqs.at(-1).sent).toBe(true);
      s.reqs.at(-1).respond(200, SONG_B);
      expect((await settle(p))[0]).toBe("resolved");
    });

    test("the signal's listener is removed once the load settles", async () => {
      const s = withXHR();
      const added = [], removed = [];
      const signal = { aborted: false, addEventListener: (t, f) => added.push([t, f]), removeEventListener: (t, f) => removed.push([t, f]) };
      const p = s.synth.loadMIDIUrl("x.mid", { signal });
      s.reqs[0].respond(200, SONG_B);
      await p;
      expect(added.length).toBe(1);
      expect(removed).toEqual(added);
    });

    test("races: a newer loadMIDIUrl() aborts and rejects the older one, whose late response installs nothing", async () => {
      const s = withXHR();
      s.synth.loadMIDI(SONG_A);
      const older = s.synth.loadMIDIUrl("old.mid");
      const newer = s.synth.loadMIDIUrl("new.mid");
      expect(s.reqs[0].aborted).toBe(true);
      const [how, e] = await settle(older);
      expect([how, e.code]).toEqual(["rejected", "LOAD_SUPERSEDED"]);
      s.reqs[0].respond(200, SONG_B); // stale
      expect(tick(s)).toBe(960);
      s.reqs[1].respond(200, SONG_C);
      expect((await settle(newer))[0]).toBe("resolved");
      expect(tick(s)).toBe(480);
    });

    test("races: a direct loadMIDI() wins over a pending URL load; a failed direct load does not", async () => {
      const s = withXHR();
      const p = s.synth.loadMIDIUrl("x.mid");
      s.synth.loadMIDI(SONG_C);
      s.reqs[0].respond(200, SONG_B);
      const [how, e] = await settle(p);
      expect([how, e.code, tick(s)]).toEqual(["rejected", "LOAD_SUPERSEDED", 480]);
      const q = s.synth.loadMIDIUrl("y.mid");
      expect(thrown(() => s.synth.loadMIDI(new Uint8Array([0, 1]).buffer)).code).toBe("SMF_INVALID_HEADER");
      s.reqs[1].respond(200, SONG_B);
      expect((await settle(q))[0]).toBe("resolved");
      expect(tick(s)).toBe(1920);
    });

    test("a newer call that never starts (bad url, aborted signal, open() throwing) leaves the older load alone", async () => {
      const s = withXHR();
      const p = s.synth.loadMIDIUrl("x.mid");
      const ac = new AbortController();
      ac.abort();
      for (const call of [() => s.synth.loadMIDIUrl(""), () => s.synth.loadMIDIUrl("y.mid", { signal: ac.signal }), () => s.synth.loadMIDIUrl("bad url")])
        expect((await settle(call()))[0]).toBe("rejected");
      expect([s.reqs[0].aborted, pending(s)]).toEqual([false, 1]);
      s.reqs[0].respond(200, SONG_B);
      expect((await settle(p))[0]).toBe("resolved");
    });

    test("dispose() during a load rejects SYNTH_DISPOSED at once; the response that arrives later installs nothing", async () => {
      const s = withXHR();
      s.synth.loadMIDI(SONG_A);
      const p = s.synth.loadMIDIUrl("x.mid");
      const d = s.synth.dispose();
      const [how, e] = await settle(p);
      expect([how, e.code, e.message, pending(s)]).toEqual(["rejected", "SYNTH_DISPOSED", "SYNTH_DISPOSED", 0]);
      expect(s.reqs[0].aborted).toBe(false); // settled and discarded, not aborted (supervisor decision, tasks/T5.md section 5)
      await d;
      const from = s.trace.length;
      s.reqs[0].respond(200, SONG_B);
      expect([s.synth.song, tick(s), s.trace.length]).toEqual([null, 960, from]);
      const after = await settle(s.synth.loadMIDIUrl("y.mid"));
      expect([after[0], after[1].code, s.reqs.length]).toEqual(["rejected", "SYNTH_DISPOSED", 1]);
    });

    test("never throws: a missing url or a disposed synth reject without a request, and loadMIDIfromSrc() routes the same way", async () => {
      const s = withXHR();
      for (const url of [undefined, null, ""]) {
        const [how, e] = await settle(s.synth.loadMIDIUrl(url));
        expect([how, e.name, e.message]).toEqual(["rejected", "TypeError", "url"]);
      }
      expect((await settle(s.synth.loadMIDIfromSrc()))[1].message).toBe("url");
      expect(s.reqs.length).toBe(0);
      s.synth.src = "from-src.mid";
      const p = s.synth.loadMIDIfromSrc();
      expect(s.reqs[0].url).toBe("from-src.mid");
      s.reqs[0].respond(200, SONG_B);
      expect((await settle(p))[0]).toBe("resolved");
      expect(tick(s)).toBe(1920);
    });

    test("fire-and-forget: ignored rejections of every kind are handled (Vitest fails on an unhandled one)", async () => {
      const s = withXHR();
      s.synth.loadMIDIUrl();
      s.synth.loadMIDIUrl("a.mid");
      s.synth.loadMIDIUrl("b.mid"); // supersedes a.mid
      s.reqs[1].respond(404);
      s.synth.loadMIDIUrl("c.mid");
      s.reqs[2].respond(200, new ArrayBuffer(3));
      s.synth.loadMIDIUrl("d.mid");
      s.reqs[3].fail();
      const ac = new AbortController();
      s.synth.loadMIDIUrl("e.mid", { signal: ac.signal });
      ac.abort();
      s.synth.loadMIDIUrl("f.mid");
      s.synth.dispose();
      s.synth.loadMIDIUrl("g.mid");
      await flush();
      await flush();
      expect(pending(s)).toBe(0);
    });

    test("a lazy synth creates its context only when a response is installed", async () => {
      const s = withXHR({ lazy: true });
      const p = s.synth.loadMIDIUrl("x.mid");
      expect(s.synth.getAudioContext()).toBe(null);
      s.reqs[0].respond(200, SONG_B);
      await p;
      expect([s.synth.getAudioContext() !== null, tick(s)]).toEqual([true, 1920]);
    });
  });
}

