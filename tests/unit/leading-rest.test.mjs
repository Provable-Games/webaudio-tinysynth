/*
 * Leading rest and getPlayStatus().startTime (T3.1, #21, D-023):
 *   - With a positive loopEnd, a pass that playMIDI() starts at tick 0 (after
 *     loadMIDI(), locateMIDI(0), a completed song, or a stop before the pass's
 *     first event) keeps its leading rest: tick 0 sounds 0.1 s after
 *     playMIDI(), and each event at its own tick's time, as on later passes.
 *   - With loopEnd unset, and after a seek to a later tick, the next event
 *     plays 0.1 s after playMIDI() as before (next-event positioning, D-005).
 *   - startTime is the AudioContext time at which tick 0 of the current pass
 *     sounds (or would have sounded, when the next event plays at once); it
 *     moves on at each wrap and is null when not playing.
 *
 * The first test reproduces the onchain consumer's player: load, setLoop(1),
 * setLoopEnd(maxTick), playMIDI(), then read startTime for its art.
 *
 * Oracle: the MIDI tempo map (120 BPM until the first tempo event): an event
 * at tick T of a pass sounds at startTime + seconds(0 -> T).
 */
import { describe, expect, test } from "vitest";
import { H, variants, synthFor, secondsAt } from "./helpers.mjs";

const PPQ = 96; // the consumer's fixtures use 96
const { noteOn, noteOff, tempo } = H.midi;
const close = (a, b, msg) => expect(a, msg).toBeCloseTo(b, 9);

/* A one-track file whose End-of-Track comes at `eotTick`, so maxTick is the bar line. */
function withEot(events, eotTick) {
  const last = events.reduce((m, e) => Math.max(m, e.tick), 0);
  return H.smf(0, PPQ, [[...H.trackBytes(events, false), ...H.vlq(eotTick - last), 0xff, 0x2f, 0x00]]);
}
const notesAt = (ticks, len = 48) => ticks.flatMap((t, i) => [noteOn(t, 0, 60 + i, 100), noteOff(t + len, 0, 60 + i)]);

/* Fixtures: tempo events [[tick, us]], note-on ticks, and the file (End-of-Track at a bar line). */
function fixture(tempos, ticks, eot) {
  return { tempos, ticks, eot, bytes: withEot([...tempos.map(([t, us]) => tempo(t, us)), ...notesAt(ticks)], eot) };
}
const FIXTURES = {
  /* A beat of rest before the first note, 100 BPM from bar 2, two bars. */
  "a beat of leading rest, then a tempo change": fixture([[384, 600000]], [96, 192, 288, 480, 576, 672], 768),
  /* The first event is a tempo event at tick 100 (80 BPM); the first note at 240. */
  "a tempo event inside the leading rest": fixture([[100, 750000]], [240, 336, 480, 600], 768),
  /* A tempo event at tick 0 (100 BPM): the first event is at tick 0, as before. */
  "a tempo event at tick 0": fixture([[0, 600000]], [96, 192, 288], 384),
};
const CONSUMER = FIXTURES["a beat of leading rest, then a tempo change"];

/* Seconds from tick 0 to `tick` under the fixture's tempo map, 120 BPM before its first tempo event. */
const at = (fx, tick) => secondsAt(PPQ, fx.tempos.length && fx.tempos[0][0] === 0 ? fx.tempos : [[0, 500000], ...fx.tempos], tick);

const load = (s, fx) => s.synth.loadMIDI(H.toArrayBuffer(fx.bytes));
const now = (s) => s.synth.getAudioContext().currentTime;
const startTime = (s) => s.synth.getPlayStatus().startTime;

/* Run until startTime has taken `passes` more values (one per wrap); returns every value seen, the first included. */
function wraps(s, passes) {
  const seen = [startTime(s)];
  const ok = H.runUntil(s.env, () => {
    const v = startTime(s);
    if (v !== seen[seen.length - 1]) seen.push(v);
    return seen.length > passes;
  }, 120000);
  if (!ok) throw new Error("only " + (seen.length - 1) + " wraps");
  return seen;
}

/* Each note-on time in `notes` is start + seconds(0 -> its tick). */
function expectAligned(fx, notes, start, ticks, msg) {
  expect(notes.map((n) => n[2]), msg).toEqual(ticks.map((t) => 60 + fx.ticks.indexOf(t)));
  notes.forEach((n, i) => close(n[0], start + at(fx, ticks[i]), msg + ", note at tick " + ticks[i]));
}

describe.each(variants)("$name: leading rest and startTime (D-023)", (variant) => {
  test.each([0, 1])("the consumer's player (quality %i): the first event lands at startTime + its tick; later passes keep the alignment", (quality) => {
    const s = synthFor(variant, { quality });
    // player.js: loadMIDI, setLoop(1), setLoopEnd(maxTick), playMIDI(), then startTime for the art.
    load(s, CONSUMER);
    s.synth.setLoop(1);
    s.synth.setLoopEnd(s.synth.maxTick);
    expect(s.synth.maxTick).toBe(768);
    const t0 = now(s);
    s.synth.playMIDI();
    expect(startTime(s)).toBe(t0 + 0.1); // tick 0 sounds 0.1 s from now
    expect(s.synth.getPlayStatus().curTick).toBe(96);
    const starts = wraps(s, 3);
    const n = CONSUMER.ticks.length, period = at(CONSUMER, 768);
    expect(s.notes.length).toBeGreaterThanOrEqual(3 * n);
    // The first event (tick 96, a beat at 120 BPM) lands at startTime + 96 x 60 / 120 / 96 s.
    close(s.notes[0][0], starts[0] + 96 * (60 / 120 / PPQ));
    for (let k = 0; k < 3; ++k) {
      if (k) close(starts[k] - starts[k - 1], period, "pass " + (k + 1) + " starts one loop later");
      expectAligned(CONSUMER, s.notes.slice(k * n, (k + 1) * n), starts[k], CONSUMER.ticks, "pass " + (k + 1));
    }
  });

  test.each(Object.keys(FIXTURES))("%s: with loopEnd, every pass from tick 0 sounds at startTime + its ticks", (name) => {
    const fx = FIXTURES[name];
    const s = synthFor(variant);
    load(s, fx);
    s.synth.setLoop(1);
    s.synth.setLoopEnd(fx.eot);
    const t0 = now(s);
    s.synth.playMIDI();
    const starts = wraps(s, 3);
    expect(starts[0]).toBe(t0 + 0.1);
    const n = fx.ticks.length;
    for (let k = 0; k < 3; ++k) {
      if (k) close(starts[k] - starts[k - 1], at(fx, fx.eot), name + ", pass " + (k + 1));
      expectAligned(fx, s.notes.slice(k * n, (k + 1) * n), starts[k], fx.ticks, "pass " + (k + 1));
    }
  });

  test("loopEnd unset: the first event plays 0.1 s after playMIDI(), as upstream; startTime is the virtual tick 0", () => {
    const fx = fixture([], [96, 192, 288], 384); // 120 BPM throughout
    const s = synthFor(variant);
    load(s, fx);
    s.synth.setLoop(1);
    const t0 = now(s);
    s.synth.playMIDI();
    expect(startTime(s)).toBeCloseTo(t0 + 0.1 - at(fx, 96), 12); // in the past: the rest is not played
    const starts = wraps(s, 2);
    const n = fx.ticks.length;
    expect(s.notes[0][0]).toBe(t0 + 0.1);
    expectAligned(fx, s.notes.slice(0, n), starts[0], fx.ticks, "pass 1");
    // The default loop starts the next pass on the last event (the note-off at 336): its first event plays then.
    close(starts[1], starts[0] + at(fx, 336) - at(fx, 96));
    expectAligned(fx, s.notes.slice(n, 2 * n), starts[1], fx.ticks, "pass 2");
  });

  test("a seek into the leading rest keeps next-event positioning; the next pass starts one loop after the virtual tick 0", () => {
    const s = synthFor(variant);
    load(s, CONSUMER);
    s.synth.setLoop(1);
    s.synth.setLoopEnd(768);
    s.synth.locateMIDI(48);
    expect(s.synth.getPlayStatus().curTick).toBe(96);
    const t0 = now(s);
    s.synth.playMIDI();
    close(startTime(s), t0 + 0.1 - at(CONSUMER, 96));
    const starts = wraps(s, 2);
    const n = CONSUMER.ticks.length;
    expect(s.notes[0][0]).toBe(t0 + 0.1);
    expectAligned(CONSUMER, s.notes.slice(0, n), starts[0], CONSUMER.ticks, "pass 1");
    close(starts[1], starts[0] + at(CONSUMER, 768));
    expectAligned(CONSUMER, s.notes.slice(n, 2 * n), starts[1], CONSUMER.ticks, "pass 2");
  });

  test("a seek past the tempo change: startTime is the resumed position's virtual tick 0 under the tempo map", () => {
    const s = synthFor(variant);
    load(s, CONSUMER);
    s.synth.setLoop(1);
    s.synth.setLoopEnd(768);
    s.synth.locateMIDI(500);
    const cur = s.synth.getPlayStatus().curTick;
    expect(cur).toBe(528); // the note-off of the note at 480
    const t0 = now(s);
    s.synth.playMIDI();
    close(startTime(s), t0 + 0.1 - at(CONSUMER, cur));
    const starts = wraps(s, 2);
    const rest = CONSUMER.ticks.filter((t) => t >= cur);
    expectAligned(CONSUMER, s.notes.slice(0, rest.length), starts[0], rest, "rest of pass 1");
    close(starts[1], starts[0] + at(CONSUMER, 768));
    expectAligned(CONSUMER, s.notes.slice(rest.length, rest.length + CONSUMER.ticks.length), starts[1], CONSUMER.ticks, "pass 2");
  });

  test("locateMIDI(0) then playMIDI() keeps the leading rest, as a fresh play does; so does locateMIDI(0) while playing", () => {
    const s = synthFor(variant);
    load(s, CONSUMER);
    s.synth.setLoop(1);
    s.synth.setLoopEnd(768);
    s.synth.playMIDI();
    H.runUntil(s.env, () => s.notes.length >= 3, 10000);
    s.synth.stopMIDI();
    s.synth.locateMIDI(0);
    let from = s.notes.length, t0 = now(s);
    s.synth.playMIDI();
    expect(startTime(s)).toBe(t0 + 0.1);
    H.runUntil(s.env, () => s.notes.length >= from + 2, 10000);
    expectAligned(CONSUMER, s.notes.slice(from, from + 2), t0 + 0.1, [96, 192], "after locateMIDI(0)");
    from = s.notes.length;
    t0 = now(s);
    s.synth.locateMIDI(0); // while playing: restarts at once
    expect(startTime(s)).toBe(t0 + 0.1);
    H.runUntil(s.env, () => s.notes.length >= from + 2, 10000);
    expectAligned(CONSUMER, s.notes.slice(from, from + 2), t0 + 0.1, [96, 192], "after locateMIDI(0) while playing");
  });

  test("replaying a completed song keeps the leading rest on every pass", () => {
    const s = synthFor(variant);
    load(s, CONSUMER);
    s.synth.setLoop(0);
    s.synth.setLoopEnd(768);
    for (let pass = 1; pass <= 3; ++pass) {
      const from = s.notes.length, t0 = now(s);
      s.synth.playMIDI();
      expect(startTime(s), "pass " + pass).toBe(t0 + 0.1);
      expect(H.runUntil(s.env, () => s.synth.getPlayStatus().play === 0, 20000)).toBe(true);
      expect(startTime(s)).toBe(null);
      expectAligned(CONSUMER, s.notes.slice(from), t0 + 0.1, CONSUMER.ticks, "pass " + pass);
      H.runUntil(s.env, () => false, 500);
    }
  });

  test("a stop before the pass's first event, then play, starts the pass from tick 0 again, on the first or a later pass", () => {
    const s = synthFor(variant);
    load(s, CONSUMER);
    s.synth.setLoop(1);
    s.synth.setLoopEnd(768);
    s.synth.playMIDI();
    H.runUntil(s.env, () => now(s) >= 0.3, 1000); // the first note sounds at 0.6 s, scheduled from 0.4 s
    expect(s.notes).toHaveLength(0);
    s.synth.stopMIDI();
    let t0 = now(s);
    s.synth.playMIDI();
    expect(startTime(s)).toBe(t0 + 0.1);
    // A later pass: start from a seek (next-event), stop between the wrap and the next pass's first event.
    s.synth.stopMIDI();
    s.synth.locateMIDI(48);
    s.synth.playMIDI();
    const starts = wraps(s, 1);
    const sent = s.notes.length;
    s.synth.stopMIDI();
    expect(s.synth.getPlayStatus().curTick).toBe(96);
    expect(now(s)).toBeLessThan(starts[1] + at(CONSUMER, 96) - 0.2); // its first note was not scheduled yet
    t0 = now(s);
    s.synth.playMIDI();
    expect(startTime(s)).toBe(t0 + 0.1);
    H.runUntil(s.env, () => s.notes.length >= sent + 2, 10000);
    expectAligned(CONSUMER, s.notes.slice(sent, sent + 2), t0 + 0.1, [96, 192], "after the stop on pass 2");
  });

  test("a stop after the first event resumes at the next event (next-event, as before), startTime its virtual tick 0", () => {
    const s = synthFor(variant);
    load(s, CONSUMER);
    s.synth.setLoop(1);
    s.synth.setLoopEnd(768);
    s.synth.playMIDI();
    H.runUntil(s.env, () => s.notes.length >= 4, 10000); // past the tempo change
    s.synth.stopMIDI();
    const cur = s.synth.getPlayStatus().curTick, from = s.notes.length, t0 = now(s);
    expect(cur).toBeGreaterThan(384);
    s.synth.playMIDI();
    close(startTime(s), t0 + 0.1 - at(CONSUMER, cur));
    H.runUntil(s.env, () => s.notes.length >= from + 1, 10000);
    const next = CONSUMER.ticks.filter((t) => t >= cur)[0];
    close(s.notes[from][0], t0 + 0.1 + at(CONSUMER, next) - at(CONSUMER, cur));
  });

  test("startTime is null when not playing, and is not enumerable: the keys and JSON stay as upstream", async () => {
    const s = synthFor(variant);
    const status = () => s.synth.getPlayStatus();
    expect(status().startTime).toBe(null); // no song
    load(s, CONSUMER);
    expect(status().startTime).toBe(null); // loaded, not playing
    s.synth.setLoop(0);
    s.synth.setLoopEnd(768);
    s.synth.playMIDI();
    expect(typeof status().startTime).toBe("number");
    expect(Object.keys(status())).toEqual(["play", "maxTick", "curTick"]);
    expect(JSON.stringify(status())).toBe(JSON.stringify({ play: 1, maxTick: 768, curTick: 96 }));
    expect(Object.getOwnPropertyDescriptor(status(), "startTime")).toMatchObject({ enumerable: false, writable: false });
    s.synth.stopMIDI();
    expect(status().startTime).toBe(null); // stopped
    s.synth.playMIDI();
    expect(H.runUntil(s.env, () => status().play === 0, 20000)).toBe(true);
    expect(status().startTime).toBe(null); // ended
    s.synth.setLoop(1);
    s.synth.playMIDI();
    expect(typeof status().startTime).toBe("number");
    s.synth.loadMIDI(H.toArrayBuffer(CONSUMER.bytes));
    expect(status().startTime).toBe(null); // a load stops
    s.synth.playMIDI();
    await s.synth.dispose();
    expect(status().startTime).toBe(null); // disposed
  });
});
