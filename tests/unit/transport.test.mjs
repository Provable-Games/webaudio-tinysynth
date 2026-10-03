/*
 * Transport: replaying a completed song (#10) and seeking (#21), under the
 * D-005 contract (tasks/T3.md):
 *   - locateMIDI(tick) restores the state loadMIDI installs (reset() defaults,
 *     scale and master tuning 0, 120 BPM), then applies the tempo and
 *     channel-state events before tick, without notes. Playback resumes at the
 *     first event at or after tick.
 *   - playMIDI() on a completed song is locateMIDI(0) plus play; a song stopped
 *     before its end resumes with its current state.
 *
 * Oracles: the MIDI tempo map (120 BPM until the first tempo event) and the
 * MIDI specification for controller values, and "seek then play sounds like
 * playing through": from any history, the notes after locateMIDI(T) build the
 * same audio graph (oscillators, frequencies, detune, envelopes, release) on
 * the same channel settings as the same notes of an uninterrupted first play.
 * Hang-prone looping cases are in tests/node/transport-scheduler.test.cjs.
 */
import { beforeAll, describe, expect, test } from "vitest";
import { H, variants, synthFor, secondsAt } from "./helpers.mjs";

const PPQ = 480;
const { noteOn, noteOff, tempo } = H.midi;
const cc = (tick, ch, n, v) => ({ tick, bytes: [0xb0 | ch, n, v] });
const program = (tick, ch, p) => ({ tick, bytes: [0xc0 | ch, p] });
const sysex = (tick, data) => ({ tick, bytes: [0xf0, data.length, ...data] });
/* Registered parameter `lsb` (MSB 0) on `ch`: select it, then data entry MSB and, if given, LSB. */
const rpn = (tick, ch, lsb, msb, dataLsb) => [cc(tick, ch, 101, 0), cc(tick, ch, 100, lsb), cc(tick, ch, 6, msb)]
  .concat(dataLsb === undefined ? [] : [cc(tick, ch, 38, dataLsb)]);
/* Roland GS data set (address 40 xx yy, one data byte) with its checksum. */
const gs = (tick, part, addr, value) => sysex(tick, [0x41, 0x10, 0x42, 0x12, 0x40, part, addr, value,
  (128 - ((0x40 + part + addr + value) % 128)) % 128, 0xf7]);

/* Seconds from tick 0 to `tick` under the tempo events [[tick, us], ...], 120 BPM before the first one. */
const at = (tempos, tick) => secondsAt(PPQ, tempos.length && tempos[0][0] === 0 ? tempos : [[0, 500000], ...tempos], tick);
const close = (a, b) => expect(a).toBeCloseTo(b, 9);

/* A file with one track whose End-of-Track comes `eotTick` after tick 0. */
function withEot(events, eotTick) {
  const last = events.reduce((m, e) => Math.max(m, e.tick), 0);
  return H.smf(0, PPQ, [[...H.trackBytes(events, false), ...H.vlq(eotTick - last), 0xff, 0x2f, 0x00]]);
}

/* Start a pass now; returns its start (currentTime + 0.1 s, when the first event plays) and runs it to its end. */
function playPass(s, tailMs = 0) {
  const from = s.notes.length;
  const start = s.synth.getAudioContext().currentTime + 0.1;
  s.synth.playMIDI();
  if (!H.runUntil(s.env, () => s.synth.getPlayStatus().play === 0, 10 * 60 * 1000)) throw new Error("the pass did not end");
  H.runUntil(s.env, () => false, tailMs);
  return { start, times: s.notes.slice(from).map((n) => n[0] - start), notes: s.notes.slice(from) };
}

/* ---------- #10: replaying a completed song ---------- */

/* The issue's fixture: no tempo event at tick 0, 60 BPM from tick 960. */
const ISSUE10 = { tempos: [[960, 1000000]], ev: [noteOn(0, 0, 60, 100), noteOff(120, 0, 60), noteOn(240, 0, 62, 100), noteOff(480, 0, 62),
  tempo(960, 1000000), noteOn(1200, 0, 64, 100), noteOff(1320, 0, 64), noteOn(1440, 0, 65, 100), noteOff(1560, 0, 65), noteOn(1680, 0, 67, 100), noteOff(1800, 0, 67)] };
const REPLAY_FIXTURES = {
  "delayed first tempo (issue #10)": ISSUE10,
  "tempo at tick 0, then two changes": {
    tempos: [[0, 600000], [960, 400000], [1920, 1000000]],
    ev: [tempo(0, 600000), tempo(960, 400000), tempo(1920, 1000000)].concat(
      [0, 480, 960, 1440, 1920, 2400].flatMap((t, i) => [noteOn(t, 0, 60 + i, 100), noteOff(t + 240, 0, 60 + i)])),
  },
  "leading rest, first tempo before the first note": {
    tempos: [[100, 750000], [1000, 455000]],
    ev: [tempo(100, 750000), tempo(1000, 455000)].concat([240, 480, 960, 1200, 1700].flatMap((t, i) => [noteOn(t, 0, 60 + i, 100), noteOff(t + 120, 0, 60 + i)])),
  },
};
const noteTicks = (ev) => ev.filter((e) => (e.bytes[0] & 0xf0) === 0x90 && e.bytes[2] > 0).map((e) => e.tick).sort((a, b) => a - b);
const firstTick = (ev) => Math.min(...ev.map((e) => e.tick));

describe.each(variants)("$name: replaying a completed song (#10)", (variant) => {
  test.each(Object.keys(REPLAY_FIXTURES))("%s: every pass follows the song's tempo map from its initial tempo", (name) => {
    const fx = REPLAY_FIXTURES[name];
    const s = synthFor(variant);
    const bytes = H.makeMidi(PPQ, fx.ev);
    s.synth.loadMIDI(H.toArrayBuffer(bytes));
    s.synth.setLoop(0);
    const ticks = noteTicks(fx.ev), first = firstTick(fx.ev);
    const expected = ticks.map((t) => at(fx.tempos, t) - at(fx.tempos, first));
    for (let pass = 1; pass <= 3; ++pass) {
      const p = playPass(s, pass * 700);
      expect(p.times, "pass " + pass).toHaveLength(expected.length);
      p.times.forEach((t, i) => close(t, expected[i]));
      expect(s.synth.getPlayStatus()).toEqual({ play: 0, maxTick: Math.max(...fx.ev.map((e) => e.tick)), curTick: Math.max(...fx.ev.map((e) => e.tick)) });
    }
  });

  test("the issue's case: the first two note-ons are 0.25 s apart on every pass", () => {
    const s = synthFor(variant);
    s.synth.loadMIDI(H.toArrayBuffer(H.makeMidi(PPQ, ISSUE10.ev)));
    s.synth.setLoop(0);
    for (let pass = 0; pass < 3; ++pass) close(playPass(s).times[1], 0.25);
  });

  test("stopMIDI then playMIDI before the end resumes at the current tempo", () => {
    const s = synthFor(variant);
    s.synth.loadMIDI(H.toArrayBuffer(H.makeMidi(PPQ, ISSUE10.ev)));
    s.synth.setLoop(0);
    s.synth.playMIDI();
    H.runUntil(s.env, () => s.notes.length === 3, 10000); // the note at tick 1200 (60 BPM) has been scheduled
    s.synth.stopMIDI();
    const cur = s.synth.getPlayStatus().curTick;
    expect(cur).toBeGreaterThan(960);
    expect(cur).toBeLessThanOrEqual(1440);
    H.runUntil(s.env, () => false, 1000);
    const p = playPass(s);
    // 60 BPM from the stop position: 480 ticks per second.
    const rest = noteTicks(ISSUE10.ev).filter((t) => t >= cur);
    expect(p.times).toHaveLength(rest.length);
    p.times.forEach((t, i) => close(t, (rest[i] - cur) / 480));
  });

  test("after locateMIDI past a tempo change, play continues at that tempo; the next replay starts at the initial tempo", () => {
    const s = synthFor(variant);
    s.synth.loadMIDI(H.toArrayBuffer(H.makeMidi(PPQ, ISSUE10.ev)));
    s.synth.setLoop(0);
    s.synth.locateMIDI(1300);
    const cur = s.synth.getPlayStatus().curTick;
    expect(cur).toBe(1320); // the first event at or after 1300
    const rest = noteTicks(ISSUE10.ev).filter((t) => t >= cur);
    const p = playPass(s);
    p.times.forEach((t, i) => close(t, (rest[i] - cur) / 480));
    const replay = playPass(s);
    const ticks = noteTicks(ISSUE10.ev);
    expect(replay.times).toHaveLength(ticks.length);
    replay.times.forEach((t, i) => close(t, at(ISSUE10.tempos, ticks[i])));
  });

  test("with no voice left, playMIDI on a completed song makes the same calls as locateMIDI(0) then playMIDI", () => {
    const [a, b] = [synthFor(variant), synthFor(variant)];
    for (const s of [a, b]) {
      s.synth.loadMIDI(H.toArrayBuffer(H.makeMidi(PPQ, ISSUE10.ev)));
      s.synth.setLoop(0);
      s.synth.setProgram(0, 7);
      playPass(s, 6000);
      expect(s.synth.notetab).toHaveLength(0);
      s.synth.setProgram(0, 40); // a manual override after the end
      s.synth.send([0xb0, 7, 20]);
    }
    const [fa, fb] = [a.trace.length, b.trace.length];
    b.synth.locateMIDI(0);
    const pa = playPass(a, 2000), pb = playPass(b, 2000);
    expect(a.trace.slice(fa)).toEqual(b.trace.slice(fb));
    expect(pa.notes).toEqual(pb.notes);
    // The replay restored program 0 from the seek baseline (D-005).
    expect(pa.notes.every((n) => n[4] === a.synth.program[0].p)).toBe(true);
  });

  test("a replay at the end lets the previous pass's scheduled and sounding notes play, as upstream; locateMIDI(0) stops them", () => {
    // Three short notes in the last 0.2 s: the song reports its end while they are still scheduled.
    const bytes = H.makeMidi(PPQ, [noteOn(0, 0, 60, 100), noteOff(240, 0, 60), noteOn(1800, 0, 62, 100), noteOff(1820, 0, 62),
      noteOn(1840, 0, 64, 100), noteOff(1860, 0, 64), noteOn(1880, 0, 65, 100), noteOff(1900, 0, 65)]);
    /* Oscillators of the first pass that are stopped before they start or cut at once, after `restart` at the end. */
    const cut = (source, restart) => {
      const s = H.createSynth(source, "replay");
      s.synth.loadMIDI(H.toArrayBuffer(bytes));
      s.synth.setLoop(0);
      s.synth.playMIDI();
      H.runUntil(s.env, () => s.synth.getPlayStatus().play === 0, 5000);
      const now = s.env.clock.ms / 1000, from = s.trace.length;
      const started = new Map(s.trace.map((l) => JSON.parse(l)).filter(([op, id, t]) => op === "start" && id.startsWith("osc#") && t > 0).map(([, id, t]) => [id, t]));
      restart(s.synth);
      const stopped = s.trace.slice(from).map((l) => JSON.parse(l)).filter(([op, id, t]) => op === "stop" && started.has(id) && t === null).map(([, id]) => id);
      return { now, scheduled: [...started.values()].filter((t) => t > now).length, stopped, neverStarted: stopped.filter((id) => started.get(id) > now).length };
    };
    const reference = cut(H.referenceSource(), (y) => y.playMIDI());
    const replay = cut(variant.source, (y) => y.playMIDI());
    const seek = cut(variant.source, (y) => { y.locateMIDI(0); y.playMIDI(); });
    expect(reference.scheduled).toBeGreaterThanOrEqual(3); // the last three notes had not started when play became 0
    expect(replay.scheduled).toBe(reference.scheduled);
    expect([reference.stopped, replay.stopped]).toEqual([[], []]);
    expect(seek.neverStarted).toBe(seek.scheduled); // a user seek still stops every voice
  });

  test("a stopped song keeps manual overrides when resumed, and loses them on replay after its end", () => {
    const s = synthFor(variant);
    s.synth.loadMIDI(H.toArrayBuffer(H.makeMidi(PPQ, ISSUE10.ev)));
    s.synth.setLoop(0);
    s.synth.playMIDI();
    H.runUntil(s.env, () => s.notes.length === 1, 10000);
    s.synth.stopMIDI();
    s.synth.setProgram(0, 40);
    const resumed = playPass(s);
    expect(resumed.notes.every((n) => n[4] === s.synth.program[40].p)).toBe(true);
    s.synth.setProgram(0, 40);
    const replay = playPass(s);
    expect(replay.notes).toHaveLength(5);
    expect(replay.notes.every((n) => n[4] === s.synth.program[0].p)).toBe(true);
  });
});

/* ---------- #21: seeking ---------- */

/*
 * Delayed tempo, programs, volume, pan, expression, modulation, sustain, bend
 * range (RPN 0), bend, fine and coarse tuning (RPN 1 and 2), an NRPN whose data
 * entry must be ignored, universal master coarse and fine tuning, GS scale
 * tuning, a GS rhythm part, reset-all-controllers, and notes between them.
 */
const RICH_TEMPOS = [[240, 400000], [2160, 1000000]];
const RICH = [
  noteOn(0, 0, 60, 100), noteOff(120, 0, 60), noteOn(0, 9, 38, 90),
  tempo(240, 400000),
  program(480, 0, 40), cc(480, 0, 7, 90), cc(480, 0, 10, 20), cc(480, 0, 11, 70), cc(480, 0, 1, 50),
  noteOn(480, 0, 62, 100), noteOff(600, 0, 62),
  ...rpn(720, 0, 0, 12, 0), { tick: 720, bytes: [0xe0, 0x00, 0x60] }, // bend range 12 semitones, then bend +4096
  noteOn(960, 0, 64, 100), noteOff(1080, 0, 64),
  cc(1200, 0, 64, 127), // sustain on
  ...rpn(1200, 1, 1, 0x50, 0x10), ...rpn(1200, 1, 2, 0x42), // channel 2: fine tuning +2064/8192 semitone, coarse +2
  cc(1200, 1, 99, 1), cc(1200, 1, 98, 1), cc(1200, 1, 6, 0x10), // NRPN: this data entry changes nothing
  program(1200, 1, 20), cc(1200, 1, 10, 100),
  noteOn(1440, 1, 65, 100), noteOff(1560, 1, 65), noteOn(1440, 0, 67, 100), noteOff(1560, 0, 67),
  sysex(1680, [0x7f, 0x7f, 0x04, 0x04, 0x00, 0x42, 0xf7]), // master coarse tuning +2
  gs(1680, 0x11, 0x40, 0x50), // scale tuning of part 1 (channel 1), C: +16 cents
  gs(1680, 0x13, 0x15, 0x01), // part 3 (channel 3) becomes a rhythm part
  noteOn(1920, 0, 72, 100), noteOff(2040, 0, 72), noteOn(1920, 1, 65, 100), noteOff(2040, 1, 65), noteOn(1920, 2, 36, 100),
  cc(1920, 0, 64, 0), // sustain off
  tempo(2160, 1000000), cc(2160, 0, 121, 0), // reset all controllers on channel 1
  sysex(2160, [0x7f, 0x7f, 0x04, 0x03, 0x00, 0x50, 0xf7]), // master fine tuning +2048/8192 semitone
  noteOn(2400, 0, 60, 100), noteOff(2640, 0, 60),
];
const RICH_BYTES = H.makeMidi(PPQ, RICH);
const RICH_NOTES = RICH.map((e, i) => ({ e, i })).sort((a, b) => a.e.tick - b.e.tick || a.i - b.i).map((x) => x.e)
  .filter((e) => (e.bytes[0] & 0xf0) === 0x90 && e.bytes[2] > 0).map((e) => e.tick);
const TARGETS = [1920, 0, 2400, 700, 1440, 300, 960, 480, 1500, 2500, 1300];
/* The first retained event at or after `tick`, where playback resumes. */
const resumeTick = (tick) => Math.min(...RICH.map((e) => e.tick).filter((t) => t >= tick));

const MODES = [0, 1].flatMap((quality) => variants.map((variant) => ({ name: variant.name + ", quality " + quality, variant, quality })));
const ROUND = (x) => Math.round(x * 1e8) / 1e8;
const untimed = (n) => {
  const c = { ...n };
  delete c.t;
  return c;
};
const TIME_ARG = { setValueAtTime: 1, linearRamp: 1, expRamp: 1, setTargetAtTime: 1, start: 0, stop: 0, cancel: 0 };

/* Record every note the synth makes from now on, with its channel's engine state at that moment. */
function recordNotes(s) {
  const out = [];
  const inner = s.synth._note;
  s.synth._note = (t, ch, n, v, p) => {
    const y = s.synth;
    const rec = {
      t, ch, n, v, p, from: s.trace.length,
      state: JSON.stringify({
        tempo: y.song.tempo, pg: y.pg[ch], vol: y.vol[ch], ex: y.ex[ch], bend: y.bend[ch], brange: y.brange[ch], rpnidx: y.rpnidx[ch],
        sustain: y.sustain[ch], rhythm: y.rhythm[ch], tuningC: y.tuningC[ch], tuningF: y.tuningF[ch], scale: y.scaleTuning[ch],
        masterC: y.masterTuningC, masterF: y.masterTuningF,
      }),
    };
    inner(t, ch, n, v, p);
    rec.to = s.trace.length;
    out.push(rec);
  };
  return out;
}

/* Channel node ids by name (chvol3, chpan3, chmod3), to name connections. */
function channelNames(synth) {
  const names = new Map();
  for (let i = 0; i < 16; ++i) {
    names.set(synth.chvol[i]._id, "chvol" + i).set(synth.chmod[i]._id, "chmod" + i).set(synth.chpan[i]._id, "chpan" + i);
  }
  return names;
}

/*
 * What one note did to the audio graph: every call on the nodes it created,
 * to the end of the trace, with node ids replaced by kind and creation order,
 * channel nodes by name, and times relative to the note's start. Plus the
 * effective volume, pan and modulation of its channel when it starts.
 */
function describeNote(s, entries, rec, names) {
  const own = new Map();
  for (let i = rec.from; i < rec.to; ++i) if (entries[i][0] === "create") own.set(entries[i][1], entries[i][1].split("#")[0] + own.size);
  const node = (id) => String(id).split(".")[0];
  const local = (id) => (id === null ? null : (own.get(node(id)) || names.get(node(id)) || "other") + (String(id).includes(".") ? "." + String(id).split(".")[1] : ""));
  const calls = [];
  for (let i = rec.from; i < entries.length; ++i) {
    const [op, id, ...args] = entries[i];
    const linked = op === "connect" || op === "disconnect";
    if (!own.has(node(id)) && !(linked && own.has(node(args[0])))) continue;
    const a = args.map((x, k) => (linked && k === 0 ? local(x) : k === TIME_ARG[op] && typeof x === "number" && x !== 0 ? ROUND(x - rec.t) : typeof x === "number" ? ROUND(x) : x));
    calls.push([op, local(id), ...a]);
  }
  const param = (id) => {
    let v;
    for (let i = 0; i < rec.from; ++i) {
      const [op, pid, a0, a1] = entries[i];
      if (pid === id && (op === "value" || (op === "setValueAtTime" && a1 <= rec.t + 1e-9))) v = ROUND(a0);
    }
    return v;
  };
  const y = s.synth, ch = rec.ch;
  const timbre = y.rhythm[ch] ? "drum " + y.drummap.findIndex((d) => d.p === rec.p) : "program " + y.program.findIndex((d) => d.p === rec.p);
  return {
    ch, n: rec.n, v: rec.v, timbre, state: rec.state, calls,
    channel: { vol: param(y.chvol[ch].gain._id), pan: param(y.chpan[ch].pan._id), mod: param(y.chmod[ch].gain._id) },
  };
}

/* Play from the current position to the end (plus a tail, so every voice is released and pruned) and describe its notes. */
function playAndDescribe(s, names) {
  const recs = recordNotes(s);
  const p = playPass(s, 6000);
  const entries = s.trace.map((l) => JSON.parse(l));
  return { start: p.start, notes: recs.map((r) => Object.assign(describeNote(s, entries, r, names), { t: r.t - p.start })) };
}

/* Seek-relevant state: H.playbackState without the playback clock, plus the last value written to each channel param. */
function seekState(s, from) {
  const st = H.playbackState(s.synth);
  delete st.playTime;
  delete st.tick2Time;
  const want = new Map();
  for (let i = 0; i < 16; ++i) {
    want.set(s.synth.chvol[i].gain._id, "vol" + i).set(s.synth.chpan[i].pan._id, "pan" + i).set(s.synth.chmod[i].gain._id, "mod" + i);
  }
  st.params = {};
  for (const line of s.trace.slice(from)) {
    const [op, id, v] = JSON.parse(line);
    if (want.has(id) && (op === "value" || op === "setValueAtTime")) st.params[want.get(id)] = v;
  }
  return st;
}

/*
 * The automation timeline of one AudioParam, with Web Audio semantics: `value` takes effect at the current
 * time, setValueAtTime at its time, cancelScheduledValues(t) removes the events at or after t, and at(t) is
 * the value of the last event (in time, then insertion order) at or before t.
 */
function timeline(param, clock) {
  const ev = [];
  const value = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(param), "value");
  Object.defineProperty(param, "value", {
    get() { return value.get.call(this); },
    set(v) { ev.push({ t: clock.ms / 1000, v }); value.set.call(this, v); },
    configurable: true,
  });
  const set = param.setValueAtTime, cancel = param.cancelScheduledValues;
  param.setValueAtTime = function (v, t) { ev.push({ t, v }); return set.call(this, v, t); };
  param.cancelScheduledValues = function (t) {
    for (let i = ev.length - 1; i >= 0; --i) if (ev[i].t >= t) ev.splice(i, 1);
    return cancel.call(this, t);
  };
  return { at: (t) => ev.reduce((best, e) => (e.t <= t + 1e-12 && (!best || e.t >= best.t) ? e : best), null)?.v };
}

/* The ids of every channel's volume, pan and modulation params. */
const channelParamIds = (synth) => new Set(Array.from({ length: 16 }, (_, i) => [synth.chvol[i].gain._id, synth.chpan[i].pan._id, synth.chmod[i].gain._id]).flat());
/* cancelScheduledValues calls on channel params in trace lines, as [param id, time]. */
const channelCancels = (synth, lines) => {
  const ids = channelParamIds(synth);
  return lines.map((l) => JSON.parse(l)).filter(([op, id]) => op === "cancel" && ids.has(id)).map(([, id, t]) => [id, t]);
};

/* Channel overrides of every kind the seek must undo. */
function override(synth) {
  synth.setProgram(0, 99);
  synth.setProgram(5, 3);
  synth.setBendRange(0, 0x700);
  synth.setBend(0, 100);
  synth.send([0xb0, 7, 5]);
  synth.send([0xb3, 10, 0]);
  synth.send([0xb4, 11, 1]);
  synth.send([0xb0, 1, 127]);
  synth.send([0xb0, 64, 127]);
  synth.send([0xb5, 101, 0]); synth.send([0xb5, 100, 2]); synth.send([0xb5, 6, 0x30]); // RPN coarse tuning -16 on channel 6
  synth.send([0xb6, 101, 0]); synth.send([0xb6, 100, 1]); synth.send([0xb6, 6, 0x10]); // RPN fine tuning on channel 7, left selected
  synth.send([0xf0, 0x7f, 0x7f, 0x04, 0x04, 0x00, 0x30, 0xf7]); // master coarse -16
  synth.send([0xf0, 0x7f, 0x7f, 0x04, 0x03, 0x00, 0x10, 0xf7]); // master fine
  synth.send([0xf0, 0x41, 0x10, 0x42, 0x12, 0x40, 0x10, 0x15, 0x00, 0x1b, 0xf7]); // part 10 (channel 10) no longer rhythm
  synth.send([0xf0, 0x41, 0x10, 0x42, 0x12, 0x40, 0x14, 0x15, 0x02, 0x15, 0xf7]); // part 4 (channel 4) rhythm
  synth.send([0xf0, 0x41, 0x10, 0x42, 0x12, 0x40, 0x11, 0x45, 0x7f, 0x3b, 0xf7]); // scale tuning F, part 1
  synth.send([0xf0, 0x41, 0x10, 0x42, 0x12, 0x40, 0x1a, 0x4b, 0x00, 0x2b, 0xf7]); // scale tuning B, part 11
  synth.noteOn(2, 64, 100);
}

/* Another song that leaves different state behind: programs, tuning, tempo, rhythm parts, held notes. */
const OTHER = H.makeMidi(PPQ, [
  tempo(0, 300000), program(0, 0, 70), program(0, 3, 9), cc(0, 0, 7, 30), cc(0, 2, 10, 127), cc(0, 2, 64, 127), ...rpn(0, 4, 0, 24, 5),
  { tick: 0, bytes: [0xe4, 0x7f, 0x7f] }, sysex(0, [0x7f, 0x7f, 0x04, 0x04, 0x00, 0x38, 0xf7]),
  gs(0, 0x15, 0x15, 0x01), gs(0, 0x11, 0x47, 0x00), noteOn(0, 2, 70, 100), noteOn(240, 0, 60, 100), noteOff(480, 0, 60),
]);

describe.each(MODES)("$name: seeking (#21)", ({ variant, quality }) => {
  let oracle;
  const make = () => synthFor(variant, { quality });
  beforeAll(() => {
    // The oracle: one uninterrupted first play after loading.
    const s = make();
    s.synth.loadMIDI(H.toArrayBuffer(RICH_BYTES));
    s.synth.setLoop(0);
    oracle = playAndDescribe(s, channelNames(s.synth));
    if (oracle.notes.length !== RICH_NOTES.length) throw new Error("oracle: " + oracle.notes.length + " notes");
  });

  test("the oracle play covers every note, on four channels, with the drum part switched by SysEx", () => {
    expect(oracle.notes.map((n) => n.ch)).toEqual([0, 9, 0, 0, 1, 0, 0, 1, 2, 0]);
    expect(oracle.notes.map((n) => n.timbre)).toEqual(["program 0", "drum 3", "program 40", "program 40", "program 20", "program 40",
      "program 40", "program 20", "drum 1", "program 40"]);
    oracle.notes.forEach((n, i) => close(n.t, at(RICH_TEMPOS, RICH_NOTES[i])));
  });

  describe("seek then play sounds like playing through, from any history", () => {
    let s, names;
    beforeAll(() => {
      s = make();
      names = channelNames(s.synth);
      s.synth.loadMIDI(H.toArrayBuffer(OTHER));
      playAndDescribe(s, names);
      s.synth.loadMIDI(H.toArrayBuffer(RICH_BYTES));
      s.synth.setLoop(0);
    });

    test.each(TARGETS)("locateMIDI(%i)", (tick) => {
      override(s.synth); // and whatever the previous target's play left behind
      s.synth.locateMIDI(tick);
      const resume = resumeTick(tick);
      expect(s.synth.getPlayStatus()).toEqual({ play: 0, maxTick: 2640, curTick: resume });
      const after = playAndDescribe(s, names);
      // Legacy rule (D-005): when the next event is at maxTick, the song counts as completed and play restarts.
      const k = resume >= 2640 ? 0 : RICH_NOTES.findIndex((t) => t >= tick);
      const from = resume >= 2640 ? 0 : resume;
      expect(after.notes.map(untimed)).toEqual(oracle.notes.slice(k).map(untimed));
      after.notes.forEach((n, i) => close(n.t, at(RICH_TEMPOS, RICH_NOTES[k + i]) - at(RICH_TEMPOS, from)));
    });
  });

  describe("the state after locateMIDI(T) does not depend on history", () => {
    let fresh, other;
    beforeAll(() => {
      fresh = make();
      other = make();
    });
    const histories = {
      "after playing the song to its end": (s) => playPass(s, 1000),
      "after a later seek": (s) => s.synth.locateMIDI(2500),
      "after an earlier seek and one second of play, stopped": (s, tick) => {
        s.synth.locateMIDI(tick / 3);
        s.synth.playMIDI();
        H.runUntil(s.env, () => false, 1000);
        s.synth.stopMIDI();
        H.runUntil(s.env, () => false, 500);
      },
      "after manual overrides": (s) => override(s.synth),
      "after another song was played, then this one loaded": (s) => {
        s.synth.loadMIDI(H.toArrayBuffer(OTHER));
        playPass(s, 500);
        s.synth.loadMIDI(H.toArrayBuffer(RICH_BYTES));
      },
    };

    test.each(TARGETS)("locateMIDI(%i)", (tick) => {
      fresh.synth.loadMIDI(H.toArrayBuffer(RICH_BYTES));
      let from = fresh.trace.length;
      fresh.synth.locateMIDI(tick);
      const reference = seekState(fresh, from);
      expect(Object.keys(reference.params)).toHaveLength(48); // the seek writes every channel's volume, pan and modulation
      for (const [name, history] of Object.entries(histories)) {
        other.synth.loadMIDI(H.toArrayBuffer(RICH_BYTES));
        history(other, tick);
        from = other.trace.length;
        other.synth.locateMIDI(tick);
        expect(seekState(other, from), name).toEqual(reference);
      }
    });
  });

  test("seek state matches the MIDI specification at ticks 0, 2000 and 2400", () => {
    const { synth } = make();
    synth.loadMIDI(H.toArrayBuffer(RICH_BYTES));
    synth.locateMIDI(0);
    const ch = (f) => Array.from({ length: 16 }, (_, i) => f(i));
    // D-005 baseline: GM defaults, rhythm on channel 10 only, no tuning, 120 BPM.
    expect(JSON.parse(JSON.stringify({
      tempo: synth.song.tempo, pg: synth.pg, brange: synth.brange, bend: synth.bend, ex: synth.ex, sustain: synth.sustain, rpnidx: synth.rpnidx,
      rhythm: synth.rhythm, tuningC: synth.tuningC, tuningF: synth.tuningF, scale: synth.scaleTuning, master: [synth.masterTuningC, synth.masterTuningF],
    }))).toEqual({
      tempo: 120, pg: ch(() => 0), brange: ch(() => 2 * 128), bend: ch(() => 0), ex: ch(() => 1), sustain: ch(() => 0), rpnidx: ch(() => 0x3fff),
      rhythm: ch((i) => (i === 9 ? 1 : 0)), tuningC: ch(() => 0), tuningF: ch(() => 0), scale: ch(() => Array(12).fill(0)), master: [0, 0],
    });

    synth.locateMIDI(2000);
    expect(synth.song.tempo).toBe(150); // 400,000 us per quarter note
    expect([synth.pg[0], synth.pg[1]]).toEqual([40, 20]);
    expect(synth.brange[0]).toBe(12 * 128); // RPN 0: 12 semitones, 0 cents
    expect(synth.tuningC[1]).toBe(2); // RPN 2: 0x42 - 0x40
    expect(synth.tuningF[1]).toBe(0x50 * 128 + 0x10 - 8192); // RPN 1: 14-bit value - 0x2000
    expect(synth.rpnidx[1]).toBe(0x3fff); // the NRPN deselected the RPN
    expect(synth.sustain[0]).toBe(0); // released at 1920
    expect([synth.masterTuningC, synth.masterTuningF]).toEqual([2, 0]);
    expect(synth.scaleTuning[0]).toEqual([0.16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // +16 cents on C
    expect(synth.rhythm.map((r, i) => (r ? i : -1)).filter((i) => i >= 0)).toEqual([2, 9]);
    expect(synth.bend[0]).not.toBe(0);

    synth.locateMIDI(2400);
    expect(synth.song.tempo).toBe(60);
    expect([synth.bend[0], synth.ex[0], synth.sustain[0], synth.rpnidx[0]]).toEqual([0, 1, 0, 0x3fff]); // reset all controllers
    expect(synth.masterTuningF).toBe(0.25); // (0x50 * 128 - 8192) / 8192 semitone
    expect(synth.pg[0]).toBe(40); // not a controller
  });

  test("tuned notes after a seek have the frequencies the MIDI specification gives", () => {
    const s = make();
    const sine = [{ w: "sine", t: 1, f: 0, v: 0.5, d: 0.1, s: 0.5, r: 0.1 }];
    s.synth.setTimbre(0, 20, sine);
    s.synth.setTimbre(0, 40, sine);
    s.synth.loadMIDI(H.toArrayBuffer(RICH_BYTES));
    s.synth.setLoop(0);
    s.synth.locateMIDI(1920);
    const from = s.trace.length;
    s.synth.playMIDI();
    H.runUntil(s.env, () => s.notes.length >= 2, 5000);
    const freqs = s.trace.slice(from).map((l) => JSON.parse(l)).filter(([op, id]) => op === "value" && /^osc#\d+\.frequency$/.test(id)).map((x) => x[2]);
    const hz = (semitones) => 440 * Math.pow(2, semitones / 12);
    // Channel 1, note 72 (C): master coarse +2, scale tuning C +16 cents.
    expect(freqs[1]).toBeCloseTo(hz(72 - 69 + 2 + 0.16), 6);
    // Channel 2, note 65: master coarse +2, RPN coarse +2, RPN fine +2064/8192 semitone.
    expect(freqs[2]).toBeCloseTo(hz(65 - 69 + 2 + 2 + 2064 / 8192), 6);
  });

  test("seeking back while playing keeps playing from the target, as playing through would", () => {
    const s = make();
    const names = channelNames(s.synth);
    s.synth.loadMIDI(H.toArrayBuffer(RICH_BYTES));
    s.synth.setLoop(0);
    s.synth.playMIDI();
    H.runUntil(s.env, () => false, 2200); // past the tuning, rhythm-part, sustain-off and reset events (1680 to 2160)
    expect(s.synth.getPlayStatus().curTick).toBe(2400);
    const recs = recordNotes(s);
    const start = s.synth.getAudioContext().currentTime + 0.1;
    s.synth.locateMIDI(1440);
    expect(s.synth.getPlayStatus()).toEqual({ play: 1, maxTick: 2640, curTick: 1440 });
    H.runUntil(s.env, () => s.synth.getPlayStatus().play === 0, 60000);
    H.runUntil(s.env, () => false, 6000);
    const entries = s.trace.map((l) => JSON.parse(l));
    const after = recs.map((r) => describeNote(s, entries, r, names));
    const k = RICH_NOTES.indexOf(1440);
    expect(after.map(({ state, calls, timbre, ch, n }) => ({ state, calls, timbre, ch, n })))
      .toEqual(oracle.notes.slice(k).map(({ state, calls, timbre, ch, n }) => ({ state, calls, timbre, ch, n })));
    recs.forEach((r, i) => close(r.t - start, at(RICH_TEMPOS, RICH_NOTES[k + i]) - at(RICH_TEMPOS, 1440)));
  });

  /*
   * Channel 1 settings and a bend at tick 0, other settings at 600 (0.725 s after playMIDI at time 0, and
   * channel 2's volume) and at 960 (1.1 s), notes at 0, 480 and 1920.
   */
  const QUEUED = H.makeMidi(PPQ, [
    cc(0, 0, 7, 90), cc(0, 0, 10, 30), cc(0, 0, 1, 10), { tick: 0, bytes: [0xe0, 0x00, 0x50] }, noteOn(0, 0, 60, 100), noteOff(240, 0, 60),
    noteOn(480, 0, 62, 100), cc(600, 0, 7, 50), cc(600, 0, 10, 60), cc(600, 0, 1, 40), cc(600, 1, 7, 10), noteOff(720, 0, 62),
    cc(960, 0, 7, 20), cc(960, 0, 10, 120), cc(960, 0, 1, 100), { tick: 960, bytes: [0xe0, 0x00, 0x30] },
    noteOn(1920, 0, 64, 100), noteOff(2160, 0, 64),
  ]);

  test("a seek back while playing cancels the controller changes queued from the old position", () => {
    const s = make();
    s.synth.loadMIDI(H.toArrayBuffer(QUEUED));
    s.synth.setLoop(0);
    const params = [s.synth.chvol[0].gain, s.synth.chpan[0].pan, s.synth.chmod[0].gain];
    const lines = params.map((p) => timeline(p, s.env.clock)), vol2 = timeline(s.synth.chvol[1].gain, s.env.clock);
    // Effective volume gain (expression 1), pan and modulation depth for CC7, CC10 and CC1 values, by the engine's documented curves.
    const expected = (v, p, m) => [3 * v * v / (127 * 127), (p - 64) / 64, m * 100 / 127].map(ROUND);
    const values = (t) => lines.map((x) => ROUND(x.at(t)));
    s.synth.playMIDI();
    H.runUntil(s.env, () => s.env.clock.ms >= 960, 2000);
    expect(s.env.clock.ms).toBe(960);
    expect(values(0.96)).toEqual(expected(50, 60, 40));
    expect(ROUND(vol2.at(0.96))).toBe(expected(10, 64, 0)[0]);
    expect(values(1.1)).toEqual(expected(20, 120, 100)); // queued for 1.1 s, not yet reached

    const from = s.trace.length, notesFrom = s.notes.length;
    s.synth.locateMIDI(300); // rebuilds tick 0's settings; resumes at the note at 480 (1.06 s); tick 960 now plays at 1.56 s
    expect(channelCancels(s.synth, s.trace.slice(from)).sort()).toEqual([...channelParamIds(s.synth)].map((id) => [id, 0.96]).sort());
    H.runUntil(s.env, () => s.synth.getPlayStatus().play === 0, 10000);
    for (const t of [0.96, 1.1, 1.18]) expect(values(t), "at " + t + " s").toEqual(expected(90, 30, 10));
    expect(ROUND(vol2.at(1.18))).toBe(expected(100, 64, 0)[0]); // channel 2 back at the default volume until 600 replays
    expect(ROUND(vol2.at(1.2))).toBe(expected(10, 64, 0)[0]);
    expect(values(1.3)).toEqual(expected(50, 60, 40)); // the song's own changes at their new times: 600 at 1.185 s
    expect(values(1.6)).toEqual(expected(20, 120, 100)); // and 960 at 1.56 s

    // Bend needs no cancelling. Queued bends only reach voices that existed when they were queued, and the
    // seek stops those. The note at 480 after the seek starts with the same detune as in an uninterrupted
    // play, and its detune changes only with the replayed tick-960 bend.
    const ref = make();
    ref.synth.loadMIDI(H.toArrayBuffer(QUEUED));
    const refFrom = ref.trace.length;
    ref.synth.playMIDI();
    H.runUntil(ref.env, () => ref.notes.length >= 2, 2000);
    // The first oscillator started at a note's time, and the detune calls on it.
    const firstOscAt = (trace, t) => trace.map((l) => JSON.parse(l)).find(([op, id, x]) => op === "start" && id.startsWith("osc#") && Math.abs(x - t) < 1e-9)[1];
    const detune = (trace, id) => trace.map((l) => JSON.parse(l)).filter(([op, pid]) => pid === id + ".detune" && (op === "value" || op === "setValueAtTime"));
    close(s.notes[notesFrom][0], 1.06);
    const mine = detune(s.trace.slice(from), firstOscAt(s.trace.slice(from), 1.06));
    const theirs = detune(ref.trace.slice(refFrom), firstOscAt(ref.trace.slice(refFrom), 0.6)); // the note at 480, 0.5 s after the start
    expect(mine[0][0]).toBe("value");
    expect(mine[0][2]).toBe(theirs[0][2]);
    expect(mine[0][2]).not.toBe(0);
    expect(mine.slice(1).map(([op, , , t]) => [op, ROUND(t)])).toEqual([["setValueAtTime", 1.56]]);
  });

  test("every seek cancels queued channel changes, the scheduler's and the caller's timed ones", () => {
    const s = make();
    s.synth.loadMIDI(H.toArrayBuffer(QUEUED));
    s.synth.setLoop(0);
    const vol = timeline(s.synth.chvol[0].gain, s.env.clock), pan2 = timeline(s.synth.chpan[1].pan, s.env.clock);
    const mod3 = timeline(s.synth.chmod[2].gain, s.env.clock), vol4 = timeline(s.synth.chvol[3].gain, s.env.clock);
    s.synth.playMIDI();
    H.runUntil(s.env, () => s.env.clock.ms >= 960, 2000); // tick 960's volume 20 is queued for 1.1 s
    s.synth.stopMIDI();
    let from = s.trace.length;
    s.synth.locateMIDI(300);
    expect(channelCancels(s.synth, s.trace.slice(from))).toHaveLength(48);
    expect(ROUND(vol.at(1.2))).toBe(ROUND(3 * 90 * 90 / (127 * 127))); // tick 0's volume, rebuilt; not 20
    H.runUntil(s.env, () => false, 500);
    // Changes the caller schedules ahead: a timed send() and timed setters (the Codex reproduction on PR #34).
    const t = s.env.clock.ms / 1000 + 1;
    s.synth.send([0xb0, 7, 0], t);
    s.synth.setPan(1, 0, t);
    s.synth.setModulation(2, 127, t);
    s.synth.setExpression(3, 0, t);
    expect([vol.at(t), pan2.at(t), ROUND(mod3.at(t)), vol4.at(t)]).toEqual([0, -1, 100, 0]);
    from = s.trace.length;
    s.synth.locateMIDI(0);
    expect(channelCancels(s.synth, s.trace.slice(from))).toHaveLength(48);
    s.synth.playMIDI();
    H.runUntil(s.env, () => s.env.clock.ms / 1000 >= t + 0.1, 3000);
    // At that time the song, playing from tick 0 again since t - 0.9 s, is past tick 600 (channel 1 volume 50);
    // the other channels are at the defaults. None of the caller's changes took effect.
    const full = ROUND(3 * 100 * 100 / (127 * 127));
    expect([ROUND(vol.at(t)), pan2.at(t), mod3.at(t), ROUND(vol4.at(t))]).toEqual([ROUND(3 * 50 * 50 / (127 * 127)), 0, 0, full]);
  });

  test("a load cancels no channel automation, even replacing a playing song", () => {
    const s = make();
    s.synth.loadMIDI(H.toArrayBuffer(RICH_BYTES));
    s.synth.playMIDI();
    H.runUntil(s.env, () => false, 1000);
    const from = s.trace.length;
    s.synth.loadMIDI(H.toArrayBuffer(RICH_BYTES)); // loadMIDI stops it first; its calls stay those of upstream
    expect(channelCancels(s.synth, s.trace.slice(from))).toEqual([]);
  });

  test("an immediate replay after the end is not overridden by changes the last pass queued", () => {
    // The last event, volume 0 at tick 480, is queued for 0.6 s; the song reports its end at 0.42 s.
    const s = make();
    s.synth.loadMIDI(H.toArrayBuffer(H.makeMidi(PPQ, [noteOn(0, 0, 60, 100), noteOff(240, 0, 60), cc(480, 0, 7, 0)])));
    s.synth.setLoop(0);
    const vol = timeline(s.synth.chvol[0].gain, s.env.clock);
    s.synth.playMIDI();
    H.runUntil(s.env, () => s.synth.getPlayStatus().play === 0, 2000);
    expect(s.env.clock.ms).toBe(420);
    expect(vol.at(0.6)).toBe(0);
    const notesFrom = s.notes.length;
    s.synth.playMIDI(); // replay: starts at 0.52 s, its volume 0 now comes at 1.02 s
    H.runUntil(s.env, () => s.synth.getPlayStatus().play === 0, 2000);
    close(s.notes[notesFrom][0], 0.52);
    const full = ROUND(3 * 100 * 100 / (127 * 127)); // volume 100, expression 127: as at the start of the first play
    for (const t of [0.52, 0.6, 1.0]) expect(ROUND(vol.at(t)), "at " + t + " s").toBe(full);
    expect(vol.at(1.03)).toBe(0);
  });

  test("a stop, an immediate resume and then a seek still cancel changes queued before the stop", () => {
    // Volume 0 at tick 480 is queued for 0.6 s at 0.42 s; the resume at 0.42 s restarts timing at 0.52 s.
    const s = make();
    s.synth.loadMIDI(H.toArrayBuffer(withEot([noteOn(0, 0, 60, 100), noteOff(240, 0, 60), cc(480, 0, 7, 0), program(960, 0, 5)], 1920)));
    s.synth.setLoop(0);
    const vol = timeline(s.synth.chvol[0].gain, s.env.clock);
    s.synth.playMIDI();
    H.runUntil(s.env, () => s.env.clock.ms >= 420, 2000);
    expect(vol.at(0.6)).toBe(0);
    s.synth.stopMIDI();
    s.synth.playMIDI(); // resumes at the program change, at 0.52 s
    H.runUntil(s.env, () => s.env.clock.ms >= 540, 2000);
    const notesFrom = s.notes.length;
    s.synth.locateMIDI(0);
    s.synth.playMIDI(); // the song again from 0.64 s; its own volume 0 comes at 1.14 s
    H.runUntil(s.env, () => s.synth.getPlayStatus().play === 0, 5000);
    close(s.notes[notesFrom][0], 0.64);
    const full = ROUND(3 * 100 * 100 / (127 * 127));
    for (const t of [0.6, 0.64, 1.1]) expect(ROUND(vol.at(t)), "at " + t + " s").toBe(full);
    expect(vol.at(1.15)).toBe(0);
  });

  test("a song loaded at maxTick keeps settings made after loading on its first play; its replay restores the baseline", () => {
    const s = make();
    s.synth.loadMIDI(H.toArrayBuffer(H.makeMidi(PPQ, [noteOn(0, 0, 60, 100), noteOff(0, 0, 60)]))); // maxTick 0
    s.synth.setLoop(0);
    expect(s.synth.getPlayStatus()).toEqual({ play: 0, maxTick: 0, curTick: 0 });
    s.synth.setProgram(0, 40);
    const first = playPass(s, 300);
    expect(first.notes.map((n) => n[4] === s.synth.program[40].p)).toEqual([true]);
    s.synth.setProgram(0, 40);
    const replay = playPass(s, 300);
    expect(replay.notes.map((n) => n[4] === s.synth.program[0].p)).toEqual([true]);
  });
});

describe.each(variants)("$name: seek positions, overrides and edge cases (#21)", (variant) => {
  test("seeking to the last event's tick resumes there; beyond it, curTick is maxTick and play restarts", () => {
    const s = synthFor(variant);
    const ev = [noteOn(0, 0, 60, 100), noteOff(240, 0, 60), noteOn(960, 0, 62, 100), noteOff(1440, 0, 62)];
    s.synth.loadMIDI(H.toArrayBuffer(withEot(ev, 1920)));
    s.synth.setLoop(0);
    s.synth.locateMIDI(1440);
    expect(s.synth.getPlayStatus()).toEqual({ play: 0, maxTick: 1920, curTick: 1440 });
    expect(playPass(s).notes).toHaveLength(0); // only the last note-off was left
    s.synth.locateMIDI(1441);
    expect(s.synth.getPlayStatus()).toEqual({ play: 0, maxTick: 1920, curTick: 1920 });
    const p = playPass(s);
    expect(p.times).toHaveLength(2);
    close(p.times[1], 1); // the whole song again: 960 ticks at 120 BPM
  });

  test("without a song, locateMIDI does nothing", () => {
    const s = synthFor(variant);
    s.synth.setProgram(0, 40);
    s.synth.noteOn(0, 60, 100);
    const before = JSON.stringify(H.playbackState(s.synth)), calls = s.trace.length;
    for (const tick of [0, 480, -1, undefined, NaN]) expect(() => s.synth.locateMIDI(tick)).not.toThrow();
    expect(s.trace.length).toBe(calls);
    expect(JSON.stringify(H.playbackState(s.synth))).toBe(before);
    expect(s.synth.getPlayStatus()).toEqual({ play: 0, maxTick: 0, curTick: 0 });
    expect(() => s.synth.playMIDI()).not.toThrow();
    expect(s.synth.getPlayStatus().play).toBe(0);
  });

  test("a seek drops channel overrides and keeps engine settings and custom timbres", () => {
    const s = synthFor(variant, { quality: 0, voices: 16 });
    const custom = [{ w: "square", t: 1, f: 0, v: 0.4, d: 0.2, s: 0.3, r: 0.1 }];
    s.synth.setTimbre(0, 5, custom);
    s.synth.loadMIDI(H.toArrayBuffer(H.makeMidi(PPQ, ISSUE10.ev))); // no program or controller events
    s.synth.setMasterVol(0.3);
    s.synth.setReverbLev(0.1);
    s.synth.setLoop(1);
    s.synth.setLoopEnd(960);
    override(s.synth);
    s.synth.locateMIDI(0);
    expect(s.synth.pg.every((p) => p === 0)).toBe(true);
    expect(s.synth.rhythm.map((r, i) => (r ? i : -1)).filter((i) => i >= 0)).toEqual([9]);
    expect(s.synth.scaleTuning.flat().every((x) => x === 0)).toBe(true);
    expect([s.synth.masterTuningC, s.synth.masterTuningF, s.synth.notetab.length]).toEqual([0, 0, 0]);
    expect([s.synth.masterVol, s.synth.reverbLev, s.synth.quality, s.synth.voices, s.synth.loop, s.synth.loopEnd]).toEqual([0.3, 0.1, 0, 16, 1, 960]);
    expect(s.synth.program[5].p[0].w).toBe("square");
  });

  test("a song of SysEx events only plays as timed silence and applies them (#9 boundary)", () => {
    const s = synthFor(variant);
    s.synth.loadMIDI(H.toArrayBuffer(H.makeMidi(PPQ, [sysex(0, [0x7f, 0x7f, 0x04, 0x04, 0x00, 0x42, 0xf7]), gs(960, 0x11, 0x40, 0x50)])));
    s.synth.setLoop(0);
    s.synth.playMIDI();
    expect(s.synth.getPlayStatus()).toEqual({ play: 1, maxTick: 960, curTick: 0 });
    expect(H.runUntil(s.env, () => s.synth.getPlayStatus().play === 0, 5000)).toBe(true);
    expect([s.synth.masterTuningC, s.synth.scaleTuning[0][0], s.notes.length]).toEqual([2, 0.16, 0]);
  });

  test("a song of state events only plays as timed silence and ends (#9 boundary)", () => {
    const s = synthFor(variant);
    s.synth.loadMIDI(H.toArrayBuffer(H.makeMidi(PPQ, [program(0, 0, 5), cc(960, 0, 7, 50)])));
    s.synth.setLoop(0);
    s.synth.playMIDI();
    expect(s.synth.getPlayStatus()).toEqual({ play: 1, maxTick: 960, curTick: 0 });
    const from = s.trace.length;
    expect(H.runUntil(s.env, () => s.synth.getPlayStatus().play === 0, 5000)).toBe(true);
    // The volume change is scheduled 960 ticks (1 s at 120 BPM) after the start, 0.1 s after playMIDI.
    const vol = s.trace.slice(from).map((l) => JSON.parse(l)).filter(([op, id]) => op === "setValueAtTime" && id === s.synth.chvol[0].gain._id);
    expect(vol).toHaveLength(1);
    close(vol[0][3], 1.1);
    expect([s.synth.pg[0], s.notes.length]).toEqual([5, 0]);
  });
});
