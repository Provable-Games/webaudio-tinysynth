/*
 * T5.2 (#13 follow-up, tasks/T5.2.md), on the mock WebAudio of
 * tests/harness.js made as strict as WebIDL makes real engines (Firefox in
 * particular), for both builds:
 *
 *   - setTimbre: the times a, h, d, r and q must be finite as float32 (d, r
 *     and q are setTargetAtTime time constants, WebIDL floats).
 *   - _note: a valid timbre and valid channel state never make a note write a
 *     value that is not finite as float32, and never make it throw part-way.
 *     A note whose values overflow (an FM chain, a large k, a pitch envelope,
 *     a sustain level, at this note and tuning) is dropped before any voice is
 *     stolen or any node made.
 *   - tsmode: a converted time is clamped at currentTime.
 *   - send(): an empty array-like SysEx is a malformed no-op.
 *   - loadMIDIUrl(): opts.signal is read inside the promise, so a throwing
 *     getter rejects.
 *
 * Expected values come from the WebIDL float conversion (2^128 - 2^103 is the
 * smallest magnitude that rounds past the largest float32), the operator
 * formulas in tasks/T5.2.md, or the times the caller passed.
 */
import vm from "node:vm";
import { describe, expect, test } from "vitest";
import { H, variants } from "./helpers.mjs";

const MAXF = 3.4028234663852886e38; // the largest float32
const EDGE = 3.4028235677973362e38; // the largest double that still rounds to it
const OVER = 3.4028235677973366e38; // 2^128 - 2^103: rounds past it, so WebIDL throws
const SR = 2000; // the mock contexts' sample rate: short generated buffers, fast construction

/*
 * A synth on the harness's mock WebAudio ({synth, env, trace}), with WebIDL's
 * checks on every AudioParam and scheduling call, as real engines make them:
 * a value or time constant that is not finite as float32, or a time that is
 * not a finite double, throws a TypeError; a negative time or time constant
 * throws a RangeError. `offset` makes performance.now() lead the context clock
 * by that many milliseconds (a page that made its context later than it
 * loaded). `setup(sandbox)` runs before the library is loaded.
 */
function synthFor(variant, opts, { offset = 0, setup } = {}) {
  const trace = [];
  const env = H.createEnvironment(trace);
  const Base = env.sandbox.AudioContext;
  const probe = new Base();
  const P = Object.getPrototypeOf(probe.createGain().gain);
  const S = Object.getPrototypeOf(Object.getPrototypeOf(probe.createOscillator())); // start(), stop()
  trace.length = 0;
  const float = (v, what) => {
    if (typeof v !== "number" || !Number.isFinite(Math.fround(v))) throw new TypeError(what + ": " + v + " is not a finite float");
  };
  const time = (t, what) => {
    if (typeof t !== "number" || !Number.isFinite(t)) throw new TypeError(what + ": " + t + " is not a finite double");
    if (t < 0) throw new RangeError(what + ": " + t + " is negative");
  };
  const value = Object.getOwnPropertyDescriptor(P, "value");
  Object.defineProperty(P, "value", { get: value.get, set(v) { float(v, "value"); value.set.call(this, v); } });
  for (const m of ["setValueAtTime", "linearRampToValueAtTime", "exponentialRampToValueAtTime"]) {
    const call = P[m];
    P[m] = function (v, t) { float(v, m + " value"); time(t, m + " time"); return call.call(this, v, t); };
  }
  const target = P.setTargetAtTime;
  P.setTargetAtTime = function (v, t, c) {
    float(v, "setTargetAtTime value"); time(t, "setTargetAtTime time"); float(c, "timeConstant");
    if (c < 0) throw new RangeError("timeConstant: " + c + " is negative");
    return target.call(this, v, t, c);
  };
  const cancel = P.cancelScheduledValues;
  P.cancelScheduledValues = function (t) { time(t, "cancelScheduledValues"); return cancel.call(this, t); };
  const start = S.start, stop = S.stop;
  S.start = function (t) { time(t, "start"); return start.call(this, t); };
  S.stop = function (t) { if (t !== undefined) time(t, "stop"); return stop.call(this, t); };
  env.sandbox.AudioContext = class extends Base { constructor() { super(); this.sampleRate = SR; } };
  if (offset) env.sandbox.performance = { now: () => env.clock.ms + offset };
  if (setup) setup(env.sandbox);
  vm.runInContext(variant.source, env.sandbox, { filename: variant.name });
  const synth = new env.sandbox.WebAudioTinySynth(opts);
  return { synth, env, trace };
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

/* The mock WebAudio calls since `from`, parsed. */
const calls = (trace, from = 0) => trace.slice(from).map((line) => JSON.parse(line));

/* Midi note n's frequency at the default tuning. */
const hz = (n) => 440 * Math.pow(2, (n - 69) / 12);

/* Program 5, an otherwise unused slot, for the timbres under test; program 0 stays a plain valid tone. */
const PROG = 5;

/*
 * Timbres that pass setTimbre, each at a note where one of its AudioParam
 * values is not finite as float32 (the value and why, in the label), and a
 * note where every value fits (null: none does). Operators are numbered from 0.
 */
const DROPPED = [
  ["an FM chain: operator 10's pitch, f(60)·1e40", [{}, ...Array.from({ length: 10 }, (_, i) => ({ g: i + 1, t: 1e4, v: 1 }))], 60, null],
  ["FM depth: operator 1's level, f(60)·1e37", [{}, { g: 1, v: 1e37 }], 60, 0],
  ["a large k: 2^(67/12·30) at note 127", [{ k: 30 }], 127, 60],
  ["a large k on an FM operator: f(127)·2^(67/12·25)", [{}, { g: 1, v: 1, k: 25 }], 127, 60],
  ["0 times an overflow: v 0, 2^(67/12·1000) is Infinity, NaN", [{ v: 0, k: 1000 }], 127, 60],
  ["the pitch-envelope target, f(60)·1e37", [{ p: 1e37 }], 60, 0],
  ["the pitch alone, f(60)·1e37, while its envelope target, ·1e-3, fits", [{ t: 1e37, p: 1e-3 }], 60, 0],
  ["the sustain level, 1e39·vp", [{ v: 1, s: 1e39 }], 60, null],
  ["AM: operator 1's level, 1e39", [{}, { g: 11, v: 1e39 }], 60, null],
  ["a noise operator's playback rate, f(60)·1e39/440", [{ w: "n0", t: 1e39 }], 60, null],
  ["FM into a noise operator's playback rate, (f(60)/440)·1e39", [{ w: "n0" }, { g: 1, v: 1e39 }], 60, null],
  ["the note: f(127)·1e35, while f(60)·1e35 fits", [{ t: 1e35 }], 127, 60],
];

for (const variant of variants) {
  describe(variant.name + ": setTimbre: times finite as float32 (T5.2)", () => {
    test("a, h, d, r and q accept up to the largest float32 and reject what rounds past it, naming the operator, before anything changes", () => {
      const { synth, trace } = synthFor(variant, { lazy: true });
      for (const k of ["a", "h", "d", "r", "q"]) {
        for (const ok of [0, 1e-45, MAXF, EDGE, String(MAXF)]) {
          synth.setTimbre(0, PROG, [{}, { g: 1, [k]: ok }]);
          expect(synth.program[PROG].p[1][k]).toBe(Number(ok));
        }
        const before = JSON.stringify(synth.program[PROG].p);
        for (const bad of [OVER, 1e39, "1e39", Number.MAX_VALUE]) {
          const e = thrown(() => synth.setTimbre(0, PROG, [{}, { g: 1, [k]: bad }]));
          expect([e && e.name, e && e.message]).toEqual(["RangeError", "operator 1 " + k + " out of range: " + Number(bad)]);
        }
        for (const [bad, name] of [[-1, "RangeError"], [Infinity, "RangeError"], [NaN, "RangeError"], [true, "TypeError"]]) {
          const e = thrown(() => synth.setTimbre(0, PROG, [{ [k]: bad }]));
          expect([e && e.name, e && e.message]).toEqual([name, "operator 0 " + k + (name === "TypeError" ? " is not a number" : " out of range: " + bad)]);
        }
        expect(JSON.stringify(synth.program[PROG].p)).toBe(before);
      }
      expect([trace.length, synth.getAudioContext()]).toEqual([0, null]);
    });

    test("t, f, v, s, p and k stay finite doubles: what they compute is checked per note", () => {
      const { synth, trace } = synthFor(variant);
      for (const k of ["t", "f", "v", "s", "p", "k"]) {
        for (const x of [1e39, -1e39, Number.MAX_VALUE]) {
          synth.setTimbre(0, PROG, [{ [k]: x }]);
          expect(synth.program[PROG].p[0][k]).toBe(x);
        }
      }
      // A k of 1e39 plays at note 60, where key tracking is 2^0.
      synth.setTimbre(0, PROG, [{ k: 1e39 }]);
      synth.setProgram(0, PROG);
      const from = trace.length;
      synth.noteOn(0, 60, 100);
      expect(calls(trace, from).filter((c) => c[0] === "setValueAtTime" && /^gain#/.test(c[1])).map((c) => c[2])).toEqual([100 * 100 / 16384 * 0.5]);
    });
  });

  describe(variant.name + ": _note: computed AudioParam values (T5.2)", () => {
    for (const [label, timbre, note, fits] of DROPPED) {
      test("dropped before anything is made or stolen: " + label, () => {
        const { synth, trace } = synthFor(variant, { voices: 1 });
        synth.setTimbre(0, PROG, timbre);
        synth.noteOn(1, 60, 100); // a sounding voice on program 0, the one voice allowed
        const voice = synth.notetab[0];
        synth.setProgram(0, PROG);
        const from = trace.length;
        expect(thrown(() => synth.noteOn(0, note, 100))).toBe(null);
        expect(calls(trace, from)).toEqual([]); // no node, no voice stolen, no value written
        expect(synth.notetab).toEqual([voice]);
        synth.noteOff(0, note);
        if (fits !== null) { // the same timbre at a note where every value fits plays
          expect(thrown(() => synth.noteOn(0, fits, 100))).toBe(null);
          expect(calls(trace, from).filter((c) => c[0] === "start").length).toBe(timbre.length);
        }
        synth.setProgram(0, 0);
        synth.noteOn(0, 64, 100); // the synth still plays
        expect(calls(trace, from).some((c) => c[0] === "start")).toBe(true);
      });
    }

    test("a drum whose values overflow is dropped too, and nothing is tracked", () => {
      const { synth, trace } = synthFor(variant);
      synth.setTimbre(1, 38, [{ w: "n0", t: 1e40 }]); // f(38)·1e40/440 = 1.7e39
      const from = trace.length, src = synth._src.length;
      expect(thrown(() => synth.noteOn(9, 38, 100))).toBe(null);
      expect([calls(trace, from), synth._src.length]).toEqual([[], src]);
      synth.noteOn(9, 36, 100);
      expect(calls(trace, from).some((c) => c[0] === "start")).toBe(true);
    });

    test("the value depends on tuning: master coarse tuning +63 (SysEx) drops a note that fits without it", () => {
      const { synth, trace } = synthFor(variant);
      synth.setTimbre(0, PROG, [{ t: 1e35 }]);
      synth.setProgram(0, PROG);
      let from = trace.length;
      synth.noteOn(0, 60, 100);
      expect(calls(trace, from).filter((c) => c[0] === "start").length).toBe(1);
      synth.send([0xf0, 0x7f, 0x7f, 0x04, 0x04, 0x00, 0x7f, 0xf7]); // master coarse tuning: +63 semitones
      expect(synth.masterTuningC).toBe(63);
      from = trace.length;
      expect(thrown(() => synth.noteOn(0, 60, 100))).toBe(null);
      expect(calls(trace, from)).toEqual([]);
    });

    test("the boundary is the float32 range itself: a level of the largest float32 is written, one that rounds past it drops the note", () => {
      const { synth, trace } = synthFor(variant);
      synth.setProgram(0, PROG);
      for (const [v, plays] of [[MAXF, true], [EDGE, true], [OVER, false]]) {
        synth.setTimbre(0, PROG, [{}, { g: 11, v }]); // AM: operator 1's level is v exactly
        const from = trace.length;
        synth.noteOn(0, 60, 100);
        const set = calls(trace, from).filter((c) => c[0] === "setValueAtTime" && c[2] === v);
        expect([set.length, calls(trace, from).length > 0]).toEqual(plays ? [1, true] : [0, false]);
        synth.allSoundOff(0);
      }
    });

    test("an underflow is a value: k 30 at note 0 plays with a level that rounds to 0 as float32", () => {
      const { synth, trace } = synthFor(variant);
      synth.setTimbre(0, PROG, [{ k: 30 }]);
      synth.setProgram(0, PROG);
      const from = trace.length;
      synth.noteOn(0, 0, 100);
      const level = 100 * 100 / 16384 * 0.5 * Math.pow(2, -150);
      expect(Math.fround(level)).toBe(0);
      expect(calls(trace, from).filter((c) => c[0] === "setValueAtTime" && /^gain#/.test(c[1]) && c[2] === level).length).toBe(1);
    });

    test("valid notes write the same values as before: FM, AM, noise, k and a pitch envelope against the operator formulas", () => {
      const { synth, trace } = synthFor(variant);
      synth.setTimbre(0, PROG, [{ v: 0.4, k: -0.5, p: 2, q: 0.1 }, { g: 1, t: 3, v: 2 }, { g: 11, t: 0.5, v: 0.3 }, { w: "n0", t: 2, f: 1, v: 0.2, s: 0.5 }, { g: 4, v: 5 }]);
      synth.setProgram(0, PROG);
      const from = trace.length;
      synth.noteOn(0, 72, 90);
      const f = hz(72), fp = [f, f * 3, f * 0.5, f * 2 + 1, f * 2 + 1];
      const got = calls(trace, from);
      const values = got.filter((c) => c[0] === "value" && /\.(frequency|playbackRate)$/.test(c[1])).map((c) => c[2]);
      expect(values).toEqual([fp[0], fp[1], fp[2], fp[3] / 440, fp[4]]);
      expect(got.filter((c) => c[0] === "setTargetAtTime" && /\.frequency$/.test(c[1])).map((c) => c[2])).toEqual([fp[0] * 2]);
      const levels = got.filter((c) => c[0] === "setValueAtTime" && /^gain#/.test(c[1])).map((c) => c[2]);
      expect(levels).toEqual([90 * 90 / 16384 * 0.4 * Math.pow(2, (72 - 60) / 12 * -0.5), fp[0] * 2, 0.3, 90 * 90 / 16384 * 0.2, fp[3] / 440 * 5]);
    });
  });

  describe(variant.name + ": tsmode times are clamped at currentTime (T5.2)", () => {
    // performance.now() leads the context clock by 5 s: a page that made its context 5 s after it loaded.
    const OFFSET = 5000;
    const started = (trace, from) => calls(trace, from).filter((c) => c[0] === "start").map((c) => c[2]);
    const times = (trace, from) => calls(trace, from).filter((c) => /^(setValueAtTime|linearRamp|setTargetAtTime|cancel|start|stop)$/.test(c[0])).map((c) => c[c[0] === "setTargetAtTime" ? 3 : c[0] === "cancel" || c[0] === "start" || c[0] === "stop" ? 2 : 3]);

    test("a time from before the context started (negative once converted) or already past plays now; a future time is kept", () => {
      const { synth, env, trace } = synthFor(variant, { quality: 0 }, { offset: OFFSET });
      synth.setTsMode(1);
      H.runUntil(env, () => false, 1000);
      const now = env.clock.ms / 1000, perf = env.clock.ms + OFFSET;
      let from = trace.length;
      expect(thrown(() => synth.noteOn(0, 60, 100, 1))).toBe(null); // 0.001 s - 5 s: negative
      expect(started(trace, from)).toEqual([now]);
      from = trace.length;
      synth.noteOn(0, 62, 100, perf - 500); // 0.5 s ago
      expect(started(trace, from)).toEqual([now]);
      from = trace.length;
      synth.noteOn(0, 64, 100, perf + 250); // 0.25 s ahead
      expect(started(trace, from)[0]).toBeCloseTo(now + 0.25, 9);
      from = trace.length;
      for (const call of [
        () => synth.noteOff(0, 60, 1), () => synth.noteOff(0, 62, perf - 500), () => synth.setBend(0, 9000, 1), () => synth.setModulation(0, 10, 1),
        () => synth.setChVol(0, 90, 1), () => synth.setPan(0, 30, 1), () => synth.setExpression(0, 100, 1), () => synth.setSustain(0, 0, 1),
        () => synth.send([0x90, 67, 100], 1), () => synth.send([0xb0, 7, 80], perf - 500),
      ]) expect(thrown(call)).toBe(null);
      const ts = times(trace, from);
      expect(ts.length).toBeGreaterThan(10);
      expect(ts.every((t) => t >= now)).toBe(true); // now, or now plus an envelope offset (t+a+h)
      expect(calls(trace, from).filter((c) => c[0] === "cancel" || c[0] === "start").map((c) => c[2])).toEqual(Array(5).fill(now)); // notes 60 and 62 released by noteOff, again by sustain off; note 67 (one operator)
    });

    test("tsmode 0 is unchanged: a past context time is passed through, 0 and omitted mean now", () => {
      const { synth, env, trace } = synthFor(variant, { quality: 0 }, { offset: OFFSET });
      H.runUntil(env, () => false, 1000);
      const now = env.clock.ms / 1000;
      const from = trace.length;
      synth.noteOn(0, 60, 100, now / 2);
      synth.noteOn(0, 62, 100, 0);
      synth.noteOn(0, 64, 100);
      expect(started(trace, from)).toEqual([now / 2, now, now]);
    });

    test("with a performance.now() that leads, the negative conversion is the case clamped: no AudioParam time below currentTime", () => {
      const { synth, env, trace } = synthFor(variant, { quality: 0 }, { offset: OFFSET });
      synth.setTsMode(1);
      H.runUntil(env, () => false, 300);
      const now = env.clock.ms / 1000;
      const from = trace.length;
      expect(thrown(() => synth.noteOn(0, 60, 100, 1))).toBe(null); // 0.001 - 5 s
      expect(thrown(() => synth.noteOn(9, 38, 100, OFFSET - 1))).toBe(null); // -0.001 s: a drum, with its stop() time
      expect(thrown(() => synth.noteOff(0, 60, 2))).toBe(null);
      const ts = times(trace, from);
      expect(ts.length).toBeGreaterThan(4);
      expect(ts.every((t) => t >= now)).toBe(true);
      expect(started(trace, from)).toEqual([now, now]);
    });

    test("without a context (lazy before first use, and after dispose()) a tsmode noteOff does nothing and does not throw", async () => {
      const { synth, trace } = synthFor(variant, { lazy: true }, { offset: OFFSET });
      synth.setTsMode(1);
      expect(thrown(() => synth.noteOff(0, 60, 1000))).toBe(null);
      expect([synth.getAudioContext(), trace.length]).toEqual([null, 0]);
      synth.noteOn(0, 60, 100);
      await synth.dispose();
      const from = trace.length;
      expect(thrown(() => synth.noteOff(0, 60, 1000))).toBe(null);
      expect(calls(trace, from)).toEqual([]);
    });
  });

  describe(variant.name + ": send(): an empty array-like SysEx (T5.2, Codex LOW)", () => {
    test("length 0 is malformed: no WebAudio call and no lazy context; one byte or more is well formed, as before", () => {
      const { synth, trace } = synthFor(variant, { lazy: true });
      for (const msg of [{ 0: 0xf0, length: 0 }, { 0: 0xf0, 1: 0xf7, length: 0 }, { 0: 0xf0, length: -1 }, { 0: 0xf0, length: 0.5 }, { 0: 0xf0 }]) {
        expect(thrown(() => synth.send(msg))).toBe(null);
        expect([synth.getAudioContext(), trace.length]).toEqual([null, 0]);
      }
      synth.send({ 0: 0xf0, length: 1 });
      expect(synth.getAudioContext()).not.toBe(null);
      for (const msg of [[0xf0], [0xf0, 0xf7], new Uint8Array([0xf0])]) expect(thrown(() => synth.send(msg))).toBe(null);
    });
  });

  describe(variant.name + ": loadMIDIUrl(): opts.signal is read inside the promise (T5.2, Codex LOW)", () => {
    function withXHR() {
      const reqs = [];
      const s = synthFor(variant, { lazy: true }, {
        setup: (sandbox) => {
          sandbox.XMLHttpRequest = class {
            constructor() { reqs.push(this); this.status = 0; this.response = null; }
            open(method, url) { this.url = url; }
            send() { this.sent = true; }
            abort() { this.aborted = true; if (this.onabort) this.onabort(); }
            respond(status, body) { this.status = status; this.response = body; this.onload(); }
          };
        },
      });
      s.reqs = reqs;
      return s;
    }

    test("a throwing signal getter, or opts that throw on any read, reject with that error; nothing is sent and an older load is kept", async () => {
      const s = withXHR();
      const older = s.synth.loadMIDIUrl("older.mid").then((v) => ["resolved", v.byteLength], (e) => ["rejected", e.code]);
      const boom = new Error("boom");
      const hostile = [
        { get signal() { throw boom; } },
        new Proxy({}, { get() { throw boom; } }),
      ];
      for (const opts of hostile) {
        let p = null;
        expect(thrown(() => { p = s.synth.loadMIDIUrl("song.mid", opts); })).toBe(null);
        expect(typeof (p && p.then)).toBe("function");
        await expect(p).rejects.toBe(boom);
      }
      expect(s.reqs.map((r) => r.url)).toEqual(["older.mid"]);
      const bytes = H.toArrayBuffer(H.makeMidi(480, [H.midi.noteOn(0, 0, 60, 100), H.midi.noteOff(480, 0, 60)]));
      s.reqs[0].respond(200, bytes);
      expect(await older).toEqual(["resolved", bytes.byteLength]);
    });
  });
}
