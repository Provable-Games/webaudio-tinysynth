/*
 * Short notes (#59, D-039, ledger L-15; tasks/T13.md): a note released before an operator's
 * attack ends, on the mock WebAudio of tests/harness.js, for both builds.
 *
 * An operator with attack a > 0 starts at 0 at the note-on time t and ramps to its level v at
 * t + a. A note-off at T cancels everything scheduled from T on. While the attack runs
 * (T <= t + a) that removes the whole ramp, so the release must put the ramp back up to T:
 * the operator then sounds while held, along its original line, and is released from its own
 * value there, v (T - t) / a. Upstream left it at 0 until T and set every operator from the
 * last operator's attack.
 *
 * The expected curves come from Web Audio's AudioParam rules (Web Audio API 1.0, "Computation
 * of Value"), evaluated below from the recorded calls, and from the note-on's own scheduling:
 * the release may not change anything before T, starts from the value the note-on's envelope
 * has at T, and then falls toward 0 with the operator's release time r. Notes whose attacks
 * have all ended at the note-off make exactly upstream's calls (raw 3d75aee, no patches).
 */
import { describe, expect, test } from "vitest";
import { H, variants, synthFor } from "./helpers.mjs";

/*
 * Tests that install two synths (each install generates the seeded buffers: about 0.43 s locally
 * and 1.25 s on the arm64 CI runner, tasks/T6.md §18.9) get more than Vitest's 5 s default.
 */
const INSTALLS_TIMEOUT = 60000;

const parse = (trace, from = 0, to = trace.length) => trace.slice(from, to).map((line) => JSON.parse(line));

/*
 * The automation each AudioParam holds after the recorded calls: the intrinsic value set with
 * `value`, and its events in time order (insertion order at equal times), cancellations applied.
 */
function automation(calls) {
  const params = new Map();
  const get = (id) => params.get(id) || params.set(id, { initial: undefined, events: [] }).get(id);
  for (const [op, id, ...a] of calls) {
    if (op === "value") {
      const p = get(id);
      if (p.events.length) throw new Error("value set on " + id + " while it has events: not modeled");
      p.initial = a[0];
    }
    else if (op === "setValueAtTime") get(id).events.push({ type: "set", v: a[0], t: a[1] });
    else if (op === "linearRamp") get(id).events.push({ type: "ramp", v: a[0], t: a[1] });
    else if (op === "setTargetAtTime") get(id).events.push({ type: "target", v: a[0], t: a[1], c: a[2] });
    else if (op === "cancel") get(id).events = get(id).events.filter((e) => e.t < a[0]);
  }
  for (const p of params.values()) p.events = p.events.map((e, i) => [e, i]).sort((x, y) => x[0].t - y[0].t || x[1] - y[1]).map((x) => x[0]);
  return params;
}

/*
 * The param's value at time `tau`. A set holds its value; a ramp runs linearly from the
 * previous event's time and value to its own; a setTarget starts from the value the curve has
 * at its time and approaches its target with time constant c. A ramp with no earlier event
 * (Web Audio starts it at the current time) is read only from its own time on here.
 */
function valueAt(p, tau) {
  let v = p.initial === undefined ? 1 : p.initial, t0 = -Infinity, target = null;
  const at = (x) => (target ? target.v + (v - target.v) * Math.exp(-(x - t0) / target.c) : v);
  for (const e of p.events) {
    if (e.t > tau) {
      if (e.type !== "ramp" || t0 === -Infinity) break;
      if (target) throw new Error("a ramp after a setTarget is not modeled");
      return v + (e.v - v) * (tau - t0) / (e.t - t0);
    }
    if (e.type === "ramp" && target) throw new Error("a ramp after a setTarget is not modeled");
    const start = e.type === "target" ? at(e.t) : e.v;
    target = e.type === "target" ? e : null;
    v = start;
    t0 = e.t;
  }
  return at(tau);
}

/* The operator gains a note created, in operator order (calls of one _note). */
const gainsOf = (calls) => calls.filter(([op, id]) => op === "create" && /^gain#/.test(id)).map(([, id]) => id + ".gain");

/* |x - y| within a relative 1e-9 (plus 1e-15 absolute). */
const near = (x, y) => Math.abs(x - y) <= 1e-9 * Math.max(Math.abs(x), Math.abs(y)) + 1e-15;

/*
 * Plays `program` (installed timbre p) at C4 from t, releases it at T, and returns what the
 * checks need: the note-on's calls, the release's calls, and both automations.
 */
function playNote(s, ch, n, t, T) {
  const from = s.trace.length;
  s.synth.noteOn(ch, n, 100, t);
  const mid = s.trace.length;
  s.synth.noteOff(ch, n, T);
  const on = parse(s.trace, from, mid);
  return { from, on, off: parse(s.trace, mid), uncut: automation(on), cut: automation(parse(s.trace, from)), gains: gainsOf(on) };
}

/* The automation of `id` from the calls since trace index `from`. */
const curve = (s, from, id) => automation(parse(s.trace, from)).get(id);

/*
 * The release invariant for one note (operators p, note-on t, release T): for every operator,
 *   1. before T the curve is the note-on's envelope (nothing before T changes);
 *   2. the release starts from that envelope's value at T (r > 0: the setTarget's start);
 *   3. the release is the operator's own: setTarget(0, T, r), or setValueAtTime(0, T) for r = 0,
 *      and nothing is scheduled after it.
 * Returns the failures as strings (empty when the note is right).
 */
function releaseProblems(note, p, t, T) {
  const out = [];
  if (note.gains.length !== p.length) return ["expected " + p.length + " operator gains, found " + note.gains.length];
  note.gains.forEach((id, k) => {
    const u = note.uncut.get(id), c = note.cut.get(id);
    const times = []; // from the note-on to just before the note-off (none for a zero-length note)
    if (T > t) for (let i = 0; i <= 16; ++i) times.push(t + (T - t) * (i < 16 ? i / 16 : 1 - 1e-9));
    for (const tau of times) {
      if (!near(valueAt(c, tau), valueAt(u, tau))) out.push("op " + k + ": at " + tau + " the gain is " + valueAt(c, tau) + ", its envelope " + valueAt(u, tau));
    }
    if (p[k].r > 0 && !near(valueAt(c, T), valueAt(u, T))) out.push("op " + k + ": the release starts from " + valueAt(c, T) + ", the envelope is at " + valueAt(u, T));
    const last = c.events[c.events.length - 1];
    const release = p[k].r > 0 ? { type: "target", v: 0, t: T, c: p[k].r } : { type: "set", v: 0, t: T };
    if (JSON.stringify(last) !== JSON.stringify(release)) out.push("op " + k + ": the last event is " + JSON.stringify(last) + ", expected " + JSON.stringify(release));
    if (!note.off.some(([op, pid, x]) => op === "cancel" && pid === id && x === T)) out.push("op " + k + ": not released at " + T);
  });
  return out;
}

/* Durations: zero, the T6 §18.5 grid, and each operator's attack exactly (T = t + a, as the note-on computes it). */
const durationsFor = (p) => [...new Set([0, 0.025, 0.045, 0.07, 0.15, 0.3, 0.5, 1.2, ...p.map((o) => o.a).filter((a) => a > 0)])];

/* Quality-1 programs whose output operator's attack is shorter than the last operator's (T6 §18.5, "A related defect"). */
const RELEASE_LEVEL = [23, 50, 86, 88, 123];
/* Programs silent with a 0.07 s note before the fix (T6 §18.5): silent while held. */
const SHORT = { 0: [91, 101, 119, 122, 123, 126], 1: [40, 41, 42, 43, 44, 101, 102, 103, 119, 122, 125, 126] };

const attackRamp = (on, id) => on.find(([op, pid]) => op === "linearRamp" && pid === id);

describe.each(variants)("$name: short notes (#59)", (variant) => {
  describe.each([0, 1])("quality %i", (quality) => {
    test("every built-in program, at every duration and at each operator's exact attack end: the release changes nothing before the note-off and starts from each operator's own envelope value", () => {
      const s = synthFor(variant, { quality });
      const problems = [];
      let t = 1, checked = 0;
      for (let n = 0; n < 128; ++n) {
        s.synth.setProgram(0, n);
        const p = s.synth.program[n].p;
        for (const D of durationsFor(p)) {
          const T = t + D;
          const note = playNote(s, 0, 60, t, T);
          for (const x of releaseProblems(note, p, t, t + D)) problems.push("program " + n + ", D " + D + ": " + x);
          checked += p.length;
          t += 3;
        }
      }
      expect(problems.slice(0, 10)).toEqual([]);
      expect(checked).toBeGreaterThan(128 * 8);
    });

    test("the programs that were silent with a 0.07 s note (T6 §18.5) sound while held: every operator still in its attack ramps to v D / a at the note-off", () => {
      const s = synthFor(variant, { quality });
      const D = 0.07;
      let t = 1;
      for (const n of SHORT[quality]) {
        s.synth.setProgram(0, n);
        const p = s.synth.program[n].p;
        const note = playNote(s, 0, 60, t, t + D);
        let ramped = 0;
        note.gains.forEach((id, k) => {
          const r = attackRamp(note.on, id);
          if (!r || p[k].a < D) return;
          const [, , v, end] = r; // the note-on's ramp: level v at t + a
          expect(end).toBe(t + p[k].a);
          const ramp = note.off.find(([op, pid]) => op === "linearRamp" && pid === id);
          expect(ramp, "program " + n + " op " + k).toEqual(["linearRamp", id, expect.any(Number), t + D]);
          expect(ramp[2]).toBeCloseTo(v * D / p[k].a, 12);
          expect(valueAt(note.cut.get(id), t + D / 2)).toBeCloseTo(v * (D / 2) / p[k].a, 12); // halfway through the hold
          if (p[k].g === 0) ++ramped;
        });
        expect(ramped, "program " + n + ": an output operator in its attack").toBeGreaterThan(0);
        t += 3;
      }
    });
  });

  test.each(RELEASE_LEVEL)("release level, quality-1 program %i: an operator whose attack has ended is released from its own value, one still in its attack from v D / a with its own a", (n) => {
    const s = synthFor(variant, { quality: 1 });
    s.synth.setProgram(0, n);
    const p = s.synth.program[n].p;
    const out = p.filter((o) => o.g === 0 && o.a > 0);
    const last = p[p.length - 1].a;
    const D = (Math.min(...out.map((o) => o.a)) + last) / 2;
    expect(out.some((o) => o.a < D) && D < last).toBe(true); // an output operator's attack has ended, the last operator's has not
    const t = 1, T = t + D;
    const note = playNote(s, 0, 60, t, T);
    expect(releaseProblems(note, p, t, T)).toEqual([]);
    note.gains.forEach((id, k) => {
      // what is set before the release (r = 0 releases with setValueAtTime(0))
      const level = note.off.filter(([op, pid, v]) => pid === id && (op === "linearRamp" || (op === "setValueAtTime" && v !== 0)));
      if (p[k].a < D) {
        expect(level, "op " + k + " (attack ended): nothing is set before its release").toEqual([]);
      } else {
        const [, , v] = attackRamp(note.on, id);
        expect(level).toEqual([["linearRamp", id, expect.any(Number), T]]);
        expect(level[0][2]).toBeCloseTo(v * D / p[k].a, 12); // its own attack, not the last operator's
      }
    });
  });

  describe("edge cases (one sine operator)", () => {
    const op = (x) => [Object.assign({ w: "sine", v: 0.5, a: 0.2, h: 0.5, d: 0.3, s: 0.4, r: 0.1 }, x)];
    const level = 100 * 100 / 16384 * 0.5; // velocity 100, v 0.5, C4 (README, Timbre Object Structure)
    const setup = (timbre) => {
      const s = synthFor(variant);
      s.synth.setTimbre(0, 0, timbre);
      return s;
    };
    const releaseCalls = (note) => note.off.filter(([, id]) => id === note.gains[0]);

    test("a short note: cancel at T, ramp on to v D / a at T, release from there with r", () => {
      const s = setup(op());
      const note = playNote(s, 0, 60, 1, 1.07);
      const id = note.gains[0];
      expect(releaseCalls(note)).toEqual([["cancel", id, 1.07], ["linearRamp", id, expect.any(Number), 1.07], ["setTargetAtTime", id, 0, 1.07, 0.1]]);
      expect(releaseCalls(note)[1][2]).toBeCloseTo(level * 0.07 / 0.2, 12);
      expect(releaseProblems(note, s.synth.program[0].p, 1, 1.07)).toEqual([]);
    });

    test("a = 0: as upstream, nothing is set unless the note-off is at the note-on time, where the level is set again", () => {
      const s = setup(op({ a: 0 }));
      const late = playNote(s, 0, 60, 1, 1.07);
      expect(releaseCalls(late)).toEqual([["cancel", late.gains[0], 1.07], ["setTargetAtTime", late.gains[0], 0, 1.07, 0.1]]);
      const zero = playNote(s, 0, 60, 4, 4);
      expect(releaseCalls(zero)).toEqual([["cancel", zero.gains[0], 4], ["setValueAtTime", zero.gains[0], level, 4], ["setTargetAtTime", zero.gains[0], 0, 4, 0.1]]);
      expect(releaseProblems(zero, s.synth.program[0].p, 4, 4)).toEqual([]);
    });

    test("T exactly at the attack's end: the ramp to v is put back, so the hold is the whole attack (upstream set v at T after a silent hold)", () => {
      const s = setup(op());
      const t = 1.1, T = t + 0.2; // the note-on's own t + a
      const note = playNote(s, 0, 60, t, T);
      const id = note.gains[0];
      expect(releaseCalls(note)).toEqual([["cancel", id, T], ["linearRamp", id, level, T], ["setTargetAtTime", id, 0, T, 0.1]]);
      expect(valueAt(note.cut.get(id), t + 0.1)).toBeCloseTo(level / 2, 12);
    });

    test("T at the note-on time with a > 0: a zero-length ramp to 0, so the note stays silent (no NaN)", () => {
      const s = setup(op());
      const note = playNote(s, 0, 60, 2, 2);
      expect(releaseCalls(note)).toEqual([["cancel", note.gains[0], 2], ["linearRamp", note.gains[0], 0, 2], ["setTargetAtTime", note.gains[0], 0, 2, 0.1]]);
    });

    test("a note-off before its own note-on releases nothing: the note keeps its whole envelope, as upstream", () => {
      const s = setup(op());
      const note = playNote(s, 0, 60, 2, 1.5);
      expect(note.off).toEqual([]);
      expect(s.synth.notetab.filter((v) => v.f === 0)).toHaveLength(1);
    });

    test("r = 0: the ramp to v D / a, then setValueAtTime(0) at T", () => {
      const s = setup(op({ r: 0 }));
      const note = playNote(s, 0, 60, 1, 1.07);
      const id = note.gains[0];
      expect(releaseCalls(note).map((c) => c.slice(0, 2).concat(c[3]))).toEqual([["cancel", id, undefined], ["linearRamp", id, 1.07], ["setValueAtTime", id, 1.07]]);
      expect(releaseProblems(note, s.synth.program[0].p, 1, 1.07)).toEqual([]);
    });

    test("sustain pedal: a note-off under the pedal releases nothing; the pedal-up releases at its own time, from the ramp's value there", () => {
      const s = setup(op());
      s.synth.setSustain(0, 127, 0.5);
      const note = playNote(s, 0, 60, 1, 1.03);
      expect(note.off).toEqual([]);
      const from = s.trace.length;
      s.synth.setSustain(0, 0, 1.12);
      const id = note.gains[0];
      const up = parse(s.trace, from).filter(([, pid]) => pid === id);
      expect(up).toEqual([["cancel", id, 1.12], ["linearRamp", id, expect.any(Number), 1.12], ["setTargetAtTime", id, 0, 1.12, 0.1]]);
      expect(up[1][2]).toBeCloseTo(level * 0.12 / 0.2, 12);
    });

    test("sustain pedal: a pedal-up after the attack has ended sets nothing and releases from the current value, as upstream", () => {
      const s = setup(op());
      s.synth.setSustain(0, 127, 0.5);
      const note = playNote(s, 0, 60, 1, 1.03);
      const from = s.trace.length;
      s.synth.setSustain(0, 0, 1.5);
      const id = note.gains[0];
      expect(parse(s.trace, from).filter(([, pid]) => pid === id)).toEqual([["cancel", id, 1.5], ["setTargetAtTime", id, 0, 1.5, 0.1]]);
    });

    test("a second release (pedal-up) later in the attack does not ramp back up: the release keeps running from where it started", () => {
      const s = setup(op());
      const note = playNote(s, 0, 60, 1, 1.05);
      const id = note.gains[0];
      const from = s.trace.length;
      s.synth.setSustain(0, 0, 1.1); // re-releases every released note on the channel (upstream behavior)
      expect(parse(s.trace, from).filter(([, pid]) => pid === id)).toEqual([["cancel", id, 1.1], ["setTargetAtTime", id, 0, 1.1, 0.1]]);
      const c = curve(s, note.from, id), at105 = level * 0.05 / 0.2;
      expect(valueAt(c, 1.05)).toBeCloseTo(at105, 12);
      expect(valueAt(c, 1.1)).toBeCloseTo(at105 * Math.exp(-0.05 / 0.1), 12); // still the first release's curve
    });

    test("a second release at the same time ramps the same way again (cancelScheduledValues removed the first)", () => {
      const s = setup(op());
      const note = playNote(s, 0, 60, 1, 1.05);
      const id = note.gains[0];
      const from = s.trace.length;
      s.synth.setSustain(0, 0, 1.05);
      const again = parse(s.trace, from).filter(([, pid]) => pid === id);
      expect(again).toEqual(releaseCalls(note));
      expect(valueAt(curve(s, note.from, id), 1.025)).toBeCloseTo(level * 0.025 / 0.2, 12); // the hold is still the ramp
    });

    test("drums: a note-off on a rhythm channel does nothing", () => {
      const s = setup(op());
      s.synth.setTimbre(1, 38, op());
      const from = s.trace.length;
      s.synth.noteOn(9, 38, 100, 1);
      const mid = s.trace.length;
      s.synth.noteOff(9, 38, 1.05);
      expect(parse(s.trace, mid)).toEqual([]);
      expect(parse(s.trace, from, mid).some(([op]) => op === "linearRamp")).toBe(true);
    });

    test("allSoundOff and stopMIDI during the attack prune the voice: no ramp, the gain at 0 with no events", () => {
      for (const stop of [(y) => y.allSoundOff(0), (y) => y.stopMIDI()]) {
        const s = setup(op());
        const from = s.trace.length;
        s.synth.noteOn(0, 60, 100, 1);
        const id = gainsOf(parse(s.trace, from))[0];
        const mid = s.trace.length;
        stop(s.synth);
        const calls = parse(s.trace, mid).filter(([, pid]) => pid === id);
        expect(calls).toEqual([["cancel", id, 0], ["value", id, 0]]);
        expect(s.synth.notetab).toHaveLength(0);
      }
    }, INSTALLS_TIMEOUT);

    test("a note the T5.2 guard skips has no voice, so its note-off makes no call", () => {
      const s = setup([{ w: "sine", a: 0.2, k: 200 }]); // 2^((72-60)/12*200) overflows float32 at note 72
      const from = s.trace.length;
      s.synth.noteOn(0, 72, 100, 1);
      s.synth.noteOff(0, 72, 1.05);
      expect(parse(s.trace, from)).toEqual([]);
    });

    test("a filtered output operator (#27): its gain ramps the same way, and the filter gets no automation", () => {
      const s = setup(op({ fl: "lowpass", ff: 2000 }));
      const note = playNote(s, 0, 60, 1, 1.07);
      const id = note.gains[0];
      expect(note.on.some(([op, x]) => op === "create" && /^biquad#/.test(x))).toBe(true);
      expect(note.off).toEqual([["cancel", id, 1.07], ["linearRamp", id, expect.any(Number), 1.07], ["setTargetAtTime", id, 0, 1.07, 0.1]]);
    });

    test("a two-operator timbre: each operator's release level comes from its own attack (the last operator's attack no longer counts for the others)", () => {
      const s = setup([{ w: "sine", v: 0.5, a: 0.02, h: 1, r: 0.1 }, { w: "sine", t: 1.5, v: 0.5, a: 0.4, h: 1, r: 0.1 }]);
      const note = playNote(s, 0, 60, 1, 1.1);
      const [g0, g1] = note.gains;
      expect(note.off).toEqual([["cancel", g1, 1.1], ["linearRamp", g1, expect.any(Number), 1.1], ["setTargetAtTime", g1, 0, 1.1, 0.1], ["cancel", g0, 1.1], ["setTargetAtTime", g0, 0, 1.1, 0.1]]);
      expect(note.off[1][2]).toBeCloseTo(level * 0.1 / 0.4, 12);
      expect(valueAt(note.cut.get(g0), 1.1)).toBeCloseTo(level, 12); // operator 0 held its level: released from it, not from level * 0.1 / 0.4
    });
  });

  describe("notes whose attacks have all ended make exactly upstream's calls (raw 3d75aee, no patches)", () => {
    const upstream = { source: H.upstreamSource(), name: "upstream@3d75aee" };
    test.each([0, 1])("quality %i: every built-in program, released after its longest attack", (quality) => {
      const run = (v) => {
        const s = synthFor(v, { quality });
        const maxA = Math.max(...s.synth.program.flatMap((x) => x.p.map((o) => o.a)));
        const from = s.trace.length;
        let t = 1;
        for (const D of [maxA + 0.1, 2]) {
          for (let n = 0; n < 128; ++n) {
            s.synth.setProgram(0, n);
            s.synth.noteOn(0, 60, 100, t);
            s.synth.noteOff(0, 60, t + D);
            t += 3;
          }
        }
        return s.trace.slice(from);
      };
      const fork = run(variant), up = run(upstream);
      expect(fork.length).toBeGreaterThan(2000);
      expect(fork).toEqual(up);
    }, INSTALLS_TIMEOUT);
  });
});
