/*
 * Scheduler startup and lookahead contract for issue #68. These tests use the
 * hand-driven AudioContext clock and an independent MIDI tick-time oracle.
 */
import { describe, expect, test } from "vitest";
import { H, variants } from "./helpers.mjs";

const PPQ = 480;
const { noteOn, noteOff } = H.midi;
const secondsPerTick = 0.5 / PPQ;
const at = (tick) => tick * secondsPerTick;
const midi = (events, endTick = Math.max(0, ...events.map((e) => e.tick))) => {
  const lastTick = Math.max(0, ...events.map((e) => e.tick));
  return H.smf(0, PPQ, [[...H.trackBytes(events, false), ...H.vlq(endTick - lastTick), 0xff, 0x2f, 0x00]]);
};
const asArrayBuffer = (events, endTick) => H.toArrayBuffer(midi(events, endTick));
const expectTimes = (actual, expected) => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 9));
};
const calls = (trace) => trace.map((line) => JSON.parse(line));
const stopTimes = (trace, id) => calls(trace).filter(([op, node]) => op === "stop" && node === id).map(([, , time]) => time);
const expectStopTimes = (trace, id, expected) => {
  const actual = stopTimes(trace, id);
  expect(actual).toHaveLength(expected.length);
  actual.forEach((time, i) => expected[i] === null ? expect(time).toBe(null) : expect(time).toBeCloseTo(expected[i], 9));
};

function captureVoices(s) {
  const made = [];
  const note = s.synth._note;
  s.synth._note = (...args) => {
    const voice = note(...args);
    if (voice) made.push(voice);
    return voice;
  };
  return made;
}

function pendingVoice(s) {
  s.synth.noteOn(0, 60, 100, 0.1);
  const voice = s.synth.notetab.at(-1);
  s.synth.send([0xb0, 120, 0], 0.4);
  return voice;
}

function recordDispatch(s) {
  const records = [];
  const note = s.synth._note;
  s.synth._note = (t, ch, n, v, p) => {
    records.push({ target: t, dispatch: s.env.clock.ms / 1000, ch, n });
    return note(t, ch, n, v, p);
  };
  return records;
}

function noteGrid(endTick = 960) {
  const ticks = [];
  for (let t = 0; t <= endTick; t += 96) ticks.push(t);
  return { ticks, events: ticks.map((t, i) => noteOn(t, 0, 60 + i, 100)) };
}

describe.each(variants)("$name: scheduler lookahead (#68)", (variant) => {
  test("preparation finishes before one anchor; chord and metallic hat share the requested onset", () => {
    const s = H.createSynth(variant.source, variant.name);
    const records = [];
    const prewarm = s.synth.prewarm.bind(s.synth);
    let preparedAt;
    s.synth.prewarm = () => {
      s.env.skip(40); // model bounded preparation before the single start-clock read
      prewarm();
      preparedAt = s.synth.getAudioContext().currentTime;
    };
    const note = s.synth._note;
    s.synth._note = (t, ch, n, v, p) => {
      records.push({ target: t, dispatch: s.env.clock.ms / 1000, ch, n });
      s.env.skip(3); // bounded per-note graph construction after the anchor
      return note(t, ch, n, v, p);
    };
    const events = [noteOn(0, 0, 60, 100), noteOn(0, 0, 64, 100), noteOn(0, 9, 42, 100)];
    s.synth.loadMIDI(asArrayBuffer(events, 480));
    s.synth.playMIDI();

    const anchor = preparedAt;
    const origin = anchor + 0.1;
    expect(s.synth.preroll).toBe(0.5);
    expect(s.synth.getPlayStatus().initialStartTime).toBe(origin);
    expect(records.map((r) => [r.ch, r.n, r.target])).toEqual([
      [0, 60, origin], [0, 64, origin], [9, 42, origin],
    ]);
    expect(Object.getOwnPropertyDescriptor(s.synth.noiseBuf, "n1").get).toBeUndefined();
    expectTimes(records.map((r) => r.target - r.dispatch), [0.1, 0.097, 0.094]);
    s.synth.stopMIDI();
  });

  test.each([40, 150, 250, 400, 800, 1000])("startup preparation stall %i ms is included before the clock anchor", (stallMs) => {
    const s = H.createSynth(variant.source, variant.name);
    const { ticks, events } = noteGrid(288);
    s.synth.loadMIDI(asArrayBuffer(events, 480));
    const records = recordDispatch(s);
    const prewarm = s.synth.prewarm.bind(s.synth);
    s.synth.prewarm = () => {
      s.env.skip(stallMs);
      return prewarm();
    };
    s.synth.playMIDI();

    const anchor = stallMs / 1000;
    const origin = anchor + 0.1;
    expect(s.synth.getPlayStatus().initialStartTime).toBe(origin);
    expectTimes(records.map((r) => r.target), ticks.map((t) => origin + at(t)));
    expect(Math.max(...records.map((r) => r.dispatch - r.target))).toBeLessThanOrEqual(0);
    s.synth.stopMIDI();
  });

  test.each([0, 59].flatMap((phase) => [40, 150, 250, 400, 800, 1000].map((stall) => [phase, stall])))(
    "mid-song stall phase %i ms / %i ms preserves the independent onset grid", (phaseMs, stallMs) => {
      const s = H.createSynth(variant.source, variant.name, { voices: 256 });
      const { ticks, events } = noteGrid(4800);
      s.env.skip(phaseMs);
      s.synth.loadMIDI(asArrayBuffer(events, 4800));
      const records = recordDispatch(s);
      const windows = [];
      const schedule = s.synth._scheduleMIDI;
      s.synth._scheduleMIDI = (until) => {
        windows.push({ at: s.env.clock.ms / 1000, until });
        return schedule(until);
      };
      const origin = s.synth.getAudioContext().currentTime + 0.1;
      s.synth.playMIDI();
      expect(H.runUntil(s.env, () => s.env.clock.ms / 1000 >= origin + 1.2, 3000)).toBe(true);
      const previousHorizon = windows.at(-1).until;
      s.env.skip(stallMs);
      s.env.step();
      const resumedAt = s.env.clock.ms / 1000;
      expect(H.runUntil(s.env, () => s.synth.getPlayStatus().play === 0, 20000)).toBe(true);

      const expected = ticks.map((t) => origin + at(t));
      expectTimes(records.map((r) => r.target), expected);
      const requestedTimestampLateness = Math.max(0, ...records.map((r) => r.dispatch - r.target));
      const firstMissed = expected.find((t) => t >= previousHorizon - 1e-9 && t <= resumedAt + 1e-9);
      const expectedLateness = firstMissed === undefined ? 0 : resumedAt - firstMissed;
      expect(requestedTimestampLateness).toBeCloseTo(expectedLateness, 8);
      if (stallMs <= 400) expect(requestedTimestampLateness).toBeCloseTo(0, 8);
      else expect(requestedTimestampLateness).toBeGreaterThan(0);
      expect(s.synth.getPlayStatus().initialStartTime).toBe(origin);
    }
  );

  test("a 50 ms loop keeps each note on its own grid and retains the first run origin", () => {
    const s = H.createSynth(variant.source, variant.name);
    s.synth.loadMIDI(asArrayBuffer([noteOn(0, 0, 60, 100)], 0));
    s.synth.setLoop(1);
    s.synth.setLoopEnd(48); // 48 ticks at 120 BPM / 480 PPQ = 50 ms
    const records = recordDispatch(s);
    s.synth.playMIDI();
    const origin = 0.1;

    expectTimes(records.map((r) => r.target), Array.from({ length: 9 }, (_, i) => origin + i * 0.05));
    expect(s.synth.getPlayStatus().initialStartTime).toBe(origin);
    expect(s.synth.getPlayStatus().startTime).toBeCloseTo(origin + 9 * 0.05, 9);
    s.synth.stopMIDI();
  });

  test("a 25 second loop rest moves the scheduler cursor but not the run origin", () => {
    const s = H.createSynth(variant.source, variant.name);
    s.synth.loadMIDI(asArrayBuffer([noteOn(0, 0, 60, 100), noteOff(0, 0, 60)], 24000));
    s.synth.setLoop(1);
    s.synth.setLoopEnd(24000);
    const records = recordDispatch(s);
    s.synth.playMIDI();

    expectTimes(records.map((r) => r.target), [0.1]);
    expect(s.synth.getPlayStatus()).toEqual(H.playStatus(1, 24000, 0, 25.1, 0.1));
    s.synth.stopMIDI();
  });

  test("the 60 ms timer keeps the third-tick prune phase for off=.35 and release=.03", () => {
    const s = H.createSynth(variant.source, variant.name);
    s.synth.loadMIDI(asArrayBuffer([noteOn(1000, 0, 60, 100), noteOff(1100, 0, 60)], 2000));
    s.synth.setLoop(0);
    s.synth.setLoopEnd(2000); // preserve the leading rest so the first note stays beyond startup lookahead
    s.synth.setTimbre(0, 0, [{ w: "sine", v: 0.5, d: 0.1, r: 0.03 }]);
    s.synth.noteOn(0, 60, 100, 0);
    s.synth.noteOff(0, 60, 0.35);
    const voice = s.synth.notetab.at(-1);
    expect(voice.e).toBeCloseTo(0.455, 9);
    const prunedAt = [];
    const prune = s.synth._pruneNote;
    s.synth._pruneNote = (nt, t) => {
      if (nt === voice) prunedAt.push(s.env.clock.ms / 1000);
      return prune(nt, t);
    };
    s.synth.playMIDI(); // startup fill must not alter the 60 ms / third-tick cleanup phase
    expect(s.synth.getPlayStatus().play).toBe(1); // its first MIDI event is beyond the 0.5 s horizon
    expect(H.runUntil(s.env, () => prunedAt.length > 0, 1000)).toBe(true);
    expect(prunedAt).toEqual([0.54]);
  });

  test("looped CC123 stops the prior voice at its event time and leaves the next onset intact", () => {
    const s = H.createSynth(variant.source, variant.name, { voices: 8 });
    const events = [noteOn(0, 0, 60, 100), noteOff(240, 0, 60), { tick: 288, bytes: [0xb0, 123, 0] }];
    s.synth.loadMIDI(asArrayBuffer(events, 288));
    s.synth.setLoop(1);
    s.synth.setLoopEnd(288);
    s.synth.setTimbre(0, 0, [{ w: "sine", v: 0.5, d: 0.1, r: 0.03 }]);
    s.synth.setModulation(0, 60);
    const made = captureVoices(s);
    s.synth.playMIDI();

    const first = made[0];
    expect(first.t).toBeCloseTo(0.1, 9);
    expect(made[1].t).toBeCloseTo(0.4, 9);
    expectTimes(s.notes.map((n) => n[0]), [0.1, 0.4]);
    expect(first._stopAt).toBeCloseTo(0.4, 9);
    expect(s.synth._gone.has(first)).toBe(true);
    expect(s.synth.notetab.includes(first)).toBe(false);
    expectStopTimes(s.trace, first.o[0]._id, [0.4]);
    expectTimes(calls(s.trace).filter(([op, id]) => op === "cancel" && id === first.g[0].gain._id).map(([, , time]) => time), [0.35]);
    expect(calls(s.trace)).not.toContainEqual(["disconnect", s.synth.chmod[0]._id, first.o[0].detune._id]);

    expect(H.runUntil(s.env, () => made.length >= 3, 1000)).toBe(true);
    const second = made[1];
    expect(second.t).toBeCloseTo(0.4, 9);
    expect(made[2].t).toBeCloseTo(0.7, 9);
    expect(second._stopAt).toBeCloseTo(0.7, 9);
    expectStopTimes(s.trace, second.o[0]._id, [0.7]);
    expectTimes(s.notes.map((n) => n[0]), [0.1, 0.4, 0.7]);
    expect(H.runUntil(s.env, () => s.env.clock.ms >= 420, 500)).toBe(true);
    first.o.forEach((o) => o.onended());
    expect(calls(s.trace)).toContainEqual(["disconnect", s.synth.chmod[0]._id, first.o[0].detune._id]);
    expect(s.synth._gone.has(first)).toBe(false);
    s.synth.stopMIDI();
  });

  test("the voice cap schedules the selected cut at the incoming onset and keeps attack automation", () => {
    const s = H.createSynth(variant.source, variant.name, { voices: 1 });
    s.synth.setTimbre(0, 0, [{ w: "sine", v: 0.5, a: 0.3, d: 0.1, r: 0.01 }]);
    s.synth.noteOn(0, 60, 100, 0.1);
    const first = s.synth.notetab.at(-1);
    const target = calls(s.trace).find(([op, id]) => op === "setTargetAtTime" && id === first.g[0].gain._id);
    const from = s.trace.length;

    s.synth.noteOn(0, 62, 100, 0.2);

    expect(target).toBeDefined();
    expect(first._stopAt).toBeCloseTo(0.2, 9);
    expect(s.synth._gone.has(first)).toBe(true);
    expect(s.synth.notetab.includes(first)).toBe(false);
    expectStopTimes(s.trace, first.o[0]._id, [0.2]);
    const afterCut = calls(s.trace.slice(from));
    expect(afterCut.some(([op, id]) => op === "cancel" && id === first.g[0].gain._id)).toBe(false);
    expect(afterCut.some(([op, id, value]) => op === "value" && id === first.g[0].gain._id && value === 0)).toBe(false);
    expect(afterCut.some(([op, id, dest]) => op === "disconnect" && id === first.o[0]._id && dest === null)).toBe(false);
  });

  test("a nonoverlapping cap eviction preserves the release and uses the shared third-tick cleanup", () => {
    const s = H.createSynth(variant.source, variant.name, { voices: 1 });
    s.synth.setTimbre(0, 0, [{ w: "sine", v: 0.5, d: 0.1, r: 0.01 }]);
    s.synth.noteOn(0, 60, 100, 0.1);
    const first = s.synth.notetab.at(-1);
    s.synth.noteOff(0, 60, 0.2);
    expect(first.e).toBeCloseTo(0.235, 9);
    const from = s.trace.length;

    s.synth.noteOn(0, 62, 100, 0.4);

    expect(first._stopAt).toBeCloseTo(0.4, 9);
    expect(s.synth._gone.has(first)).toBe(true);
    expectStopTimes(s.trace, first.o[0]._id, [0.4]);
    expect(calls(s.trace.slice(from)).some(([op, id]) => op === "cancel" && id === first.g[0].gain._id)).toBe(false);
    for (let i = 0; i < 6; ++i) s.env.step(); // existing third-tick cleanup fires at 360 ms
    expect(s.env.clock.ms).toBe(360);
    expect(first._stopAt).toBeCloseTo(0.36, 9);
    expectStopTimes(s.trace, first.o[0]._id, [0.4, null]);
    expect(s.synth._gone.has(first)).toBe(true); // source and routes remain owned until onended
  });

  test("timestamped sound-off keeps the earliest cut; immediate allSoundOff still wins", () => {
    const s = H.createSynth(variant.source, variant.name);
    s.synth.noteOn(0, 60, 100, 0.1);
    const voice = s.synth.notetab.at(-1);

    s.synth.send([0xb0, 120, 0], 0.4);
    const ended = voice.o.map((o) => o.onended);
    s.synth.send([0xb0, 123, 0], 0.6); // a later stop must not postpone the first one
    s.synth.send([0xb0, 120, 0], 0.3); // an earlier stop replaces it
    expectStopTimes(s.trace, voice.o[0]._id, [0.4, 0.3]);
    expect(voice.o.map((o) => o.onended)).toEqual(ended);
    expect(s.synth._gone.has(voice)).toBe(true);

    s.synth.allSoundOff(0);
    expectStopTimes(s.trace, voice.o[0]._id, [0.4, 0.3, null]);
    expect(voice.o.map((o) => o.onended)).toEqual(ended);
    ended.forEach((fn) => fn());
    expect(s.synth._gone.has(voice)).toBe(false);
  });

  test.each(["stopMIDI", "locateMIDI"])("%s reaches a pending future-cut voice", (operation) => {
    const s = H.createSynth(variant.source, variant.name);
    if (operation === "locateMIDI")
      s.synth.loadMIDI(asArrayBuffer([noteOn(0, 0, 62, 100)], 960));
    const voice = pendingVoice(s);
    const ended = voice.o.map((o) => o.onended);

    if (operation === "stopMIDI") s.synth.stopMIDI();
    else s.synth.locateMIDI(0);

    expectStopTimes(s.trace, voice.o[0]._id, [0.4, null]);
    expect(voice.o.map((o) => o.onended)).toEqual(ended);
    expect(s.synth._gone.has(voice)).toBe(true);
    ended.forEach((fn) => fn());
    expect(s.synth._gone.has(voice)).toBe(false);
  });

  test.each(["dispose", "context replacement"])("%s tears down a pending future-cut voice", async (operation) => {
    const s = H.createSynth(variant.source, variant.name);
    const voice = pendingVoice(s);
    const old = s.synth.getAudioContext();

    if (operation === "dispose") {
      await s.synth.dispose();
      expect(() => s.synth.allSoundOff(0)).not.toThrow();
    }
    else {
      s.synth.setAudioContext(new old.constructor());
      expect(old.state).toBe("closed");
    }

    expectStopTimes(s.trace, voice.o[0]._id, [0.4, null]);
    expect(s.synth._gone.size).toBe(0);
    expect(voice.o[0].onended).toBe(null);
  });

  test("playMIDI while the scheduler is active is idempotent", () => {
    const s = H.createSynth(variant.source, variant.name);
    s.synth.loadMIDI(asArrayBuffer([noteOn(0, 0, 60, 100), noteOff(960, 0, 60)], 960));
    s.synth.playMIDI();
    expect(s.synth.getPlayStatus().play).toBe(1);
    const status = s.synth.getPlayStatus();
    const notes = s.notes.slice();
    const trace = s.trace.slice();

    s.synth.playMIDI();

    expect(s.synth.getPlayStatus()).toEqual(status);
    expect(s.notes).toEqual(notes);
    expect(s.trace).toEqual(trace);
    s.synth.stopMIDI();
  });

  test("allSoundOff remains a no-op before a lazy context exists", () => {
    const s = H.createSynth(variant.source, variant.name, { lazy: true });
    expect(s.synth.getAudioContext()).toBe(null);
    expect(() => s.synth.allSoundOff(0)).not.toThrow();
    expect(s.synth.getAudioContext()).toBe(null);
  });

  test("stop at 300 ms cancels the queued 600 ms note and resumes at the scheduler cursor", () => {
    const s = H.createSynth(variant.source, variant.name);
    const events = [
      { tick: 0, bytes: [0xc0, 5] },
      noteOn(0, 0, 60, 100), noteOff(96, 0, 60),
      { tick: 432, bytes: [0xb0, 7, 64] }, // 550 ms under the independently calculated 120 BPM grid
      noteOn(480, 0, 62, 100), noteOff(528, 0, 62),
      noteOn(576, 0, 64, 100), noteOff(624, 0, 64),
      noteOn(720, 0, 65, 100), noteOff(768, 0, 65),
    ];
    s.synth.loadMIDI(asArrayBuffer(events, 960));
    s.synth.setLoop(0);
    s.synth.setTimbre(0, 5, [{ w: "sine", d: 0.1, r: 0.03 }]);
    s.synth.setProgram(0, 5);
    s.synth.playMIDI();
    expect(s.notes.map((n) => n[0])).toEqual([0.1]); // initial fixed cutoff is anchor + .5 s
    expect(H.runUntil(s.env, () => s.env.clock.ms >= 300, 400)).toBe(true);

    expect(s.notes.some((n) => Math.abs(n[0] - 0.6) < 1e-9 && n[2] === 62)).toBe(true);
    expect(s.synth.vol[0]).toBeCloseTo(3 * 64 * 64 / (127 * 127), 12);
    const traceStart = s.trace.length;
    const starts = new Map();
    for (const line of s.trace) {
      const [op, id, target] = JSON.parse(line);
      if (op === "start") starts.set(id, target);
    }
    const noteAt600 = [...starts].filter(([, target]) => Math.abs(target - 0.6) < 1e-9).map(([id]) => id);
    expect(noteAt600).toHaveLength(1);

    s.synth.stopMIDI();
    const stopped = new Set(s.trace.slice(traceStart).map((line) => JSON.parse(line))
      .filter(([op]) => op === "stop").map(([, id]) => id));
    expect(noteAt600.some((id) => stopped.has(id))).toBe(true);
    const resumeTraceStart = s.trace.length;
    const resumedFrom = s.notes.length;
    s.synth.playMIDI();

    expectTimes(s.notes.slice(resumedFrom).map((n) => n[0]), [0.4]); // .85 s event shifts to the next resume cursor
    expect(s.notes.slice(resumedFrom).some((n) => n[2] === 62)).toBe(false); // cancelled .60 s event is not rewound/replayed
    const gainId = s.synth.chvol[0].gain._id;
    const expectedVolume = 3 * 64 * 64 / (127 * 127);
    const restored = s.trace.slice(resumeTraceStart).map((line) => JSON.parse(line)).some(([op, id, value, time]) =>
      op === "setValueAtTime" && id === gainId && Math.abs(value - expectedVolume) < 1e-12 && Math.abs(time - 0.3) < 1e-9);
    expect(restored).toBe(true); // controller state already submitted through the old cursor is restored at resume time
  });

  test("startup processes at most 1000 events and a tick-zero loop cannot spin", () => {
    const s = H.createSynth(variant.source, variant.name);
    const dense = Array.from({ length: 1500 }, (_, i) => ({ tick: 0, bytes: [0xb0, 7, i % 128] }));
    s.synth.loadMIDI(asArrayBuffer(dense, 0));
    let calls = 0;
    const send = s.synth.send.bind(s.synth);
    s.synth.send = (...args) => { ++calls; return send(...args); };
    s.synth.playMIDI();
    expect(calls).toBe(1000);
    expect(s.synth.getPlayStatus().play).toBe(1);
    s.env.step();
    expect(calls).toBe(1500);
    expect(s.synth.getPlayStatus().play).toBe(0);

    const loop = H.createSynth(variant.source, variant.name);
    loop.synth.loadMIDI(asArrayBuffer([noteOn(0, 0, 60, 100)], 0));
    loop.synth.setLoop(1);
    const loopRecords = recordDispatch(loop);
    loop.synth.playMIDI();
    expect(loopRecords).toHaveLength(1);
    expect(loop.synth.getPlayStatus().play).toBe(0);
  });
});
