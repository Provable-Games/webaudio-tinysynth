#!/usr/bin/env node
/*
 * Tests for loopEnd / setLoopEnd (whole-bar looping).
 *
 * Upstream's looping sequencer starts the next pass on the song's last
 * event, so any rest after the last event (for example the end of the final
 * bar) is lost and the loop drifts off the bar grid. With loopEnd set (in
 * MIDI ticks), each pass spans max(loopEnd, last event tick) ticks: the
 * padding after the last event is timed at the tempo the pass ended on, and
 * the next pass restarts at the song's starting tempo (120 BPM until its
 * first tempo event).
 *
 * 1. With loopEnd set, every note of passes 2-4 must land exactly 1-3 loop
 *    periods after the same note in pass 1 (within 1e-9 s), where a period
 *    is the duration of those ticks under the song's tempo map. Fixtures
 *    include a leading rest, tempo changes, a non-default tempo at tick 0,
 *    and a tempo event before the first note.
 * 2. With loopEnd unset (or set back to 0), looping playback must match
 *    upstream (plus FORK_PATCHES) exactly: identical _note calls and
 *    WebAudio traces. The same holds for ws.mid with loopEnd equal to its
 *    last event's tick.
 *
 * Run: npm test
 */
"use strict";
const fs = require("fs");
const path = require("path");
const H = require("./harness");

const PPQ = 480;
const BAR = 4 * PPQ;
const DEFAULT_US = 500000;   // MIDI default tempo (120 BPM) until the first tempo event
const TOLERANCE = 1e-9;

/* Seconds from tick 0 to `tick` under a tempo map [[tick, us], ...]. */
function secondsAt(tempos, tick) {
  const map = tempos.length && tempos[0][0] === 0 ? tempos : [[0, DEFAULT_US]].concat(tempos);
  let s = 0;
  for (let i = 0; i < map.length; ++i) {
    const [from, us] = map[i];
    const to = i + 1 < map.length ? map[i + 1][0] : Infinity;
    if (tick <= from) break;
    s += (Math.min(tick, to) - from) * us / 1e6 / PPQ;
  }
  return s;
}

/* Notes (each `len` ticks long) at the given ticks on channel 0, plus tempo events. */
function song(tempos, ticks, len) {
  const ev = tempos.map(([t, us]) => H.midi.tempo(t, us));
  ticks.forEach((t, i) => {
    ev.push(H.midi.noteOn(t, 0, 60 + (i % 12), 100));
    ev.push(H.midi.noteOff(t + len, 0, 60 + (i % 12)));
  });
  return { tempos, bytes: H.makeMidi(PPQ, ev), lastTick: Math.max(...ticks) + len };
}
const range = (from, step, n) => Array.from({ length: n }, (_, i) => from + i * step);
const SIX = [240, 480, 720, 1200, 1440, 1680];

const fixtures = {
  /* 4 bars at 455,000 us: 13 quarter notes from tick 0, last event at tick 6160. */
  fourBars: song([[0, 455000]], range(0, PPQ, 13), PPQ - 80),
  /* 2 bars, no tempo event (120 BPM): first note after an eighth rest, last event at 3520. */
  pickup: song([], range(PPQ / 2, PPQ, 7), PPQ - 80),
  /* Codex review fixture: no tempo event at tick 0, leading rest, 60 BPM from tick 960. */
  codex: song([[960, 1000000]], SIX, 200),
  /* Non-default tempo at tick 0 (100 BPM), leading rest, 150 BPM from tick 960. */
  tick0Tempo: song([[0, 600000], [960, 400000]], SIX, 200),
  /* First tempo event (80 BPM) at tick 100, before the first note at 240. */
  lateTempo: song([[100, 750000]], SIX, 200),
  wsMid: { tempos: [[0, 428571]], bytes: fs.readFileSync(path.join(H.ROOT, "ws.mid")), lastTick: 15360 },
};

const periodCases = [
  { name: "4 bars at 455,000 us, last event 6160, loopEnd 7680 (4 bars)", fx: fixtures.fourBars, loopEnd: 4 * BAR },
  { name: "2 bars at 120 BPM, first note at tick 240, last event 3520, loopEnd 3840", fx: fixtures.pickup, loopEnd: 2 * BAR },
  { name: "loopEnd 4000 below the last event (6160): period is 6160 ticks", fx: fixtures.fourBars, loopEnd: 4000 },
  { name: "(a) Codex: leading rest 240, 120 -> 60 BPM at 960, loopEnd 1920", fx: fixtures.codex, loopEnd: BAR },
  { name: "(b) 100 BPM at tick 0, leading rest 240, 150 BPM at 960, loopEnd 1920", fx: fixtures.tick0Tempo, loopEnd: BAR },
  { name: "(c) 80 BPM tempo event at tick 100, first note 240, loopEnd 1920", fx: fixtures.lateTempo, loopEnd: BAR },
  { name: "ws.mid, loopEnd 15360 (= its last event tick and maxTick)", fx: fixtures.wsMid, loopEnd: 15360 },
];

let failures = 0;
const report = (ok, msg) => { if (!ok) ++failures; console.log("  " + (ok ? "ok  " : "FAIL") + " " + msg); };

/* Number of _note calls in one non-looping pass. */
function notesPerPass(source, bytes) {
  const { synth, env, notes } = H.createSynth(source, "count");
  synth.loadMIDI(H.toArrayBuffer(bytes));
  synth.setLoop(0);
  synth.playMIDI();
  H.runUntil(env, () => synth.getPlayStatus().play === 0, 10 * 60 * 1000);
  return notes.length;
}

/* Play looped; `setup(synth)` runs before playMIDI. Stops after `maxMs` or when `until(notes)` is true. */
function playLooped(source, label, bytes, setup, maxMs, until) {
  const r = H.createSynth(source, label);
  r.synth.loadMIDI(H.toArrayBuffer(bytes));
  r.synth.setLoop(1);
  setup(r.synth);
  r.synth.playMIDI();
  H.runUntil(r.env, () => (until ? until(r.notes) : false), maxMs);
  return r;
}

const fork = H.forkVariants();
const reference = { name: "upstream@" + H.UPSTREAM_COMMIT.slice(0, 7) + "+patches", source: H.referenceSource() };

console.log("API");
for (const v of fork) {
  const { synth } = H.createSynth(v.source, v.name);
  report(synth.loopEnd === 0 && typeof synth.setLoopEnd === "function",
    v.name + ": new instance has loopEnd === 0 and setLoopEnd()");
  if (typeof synth.setLoopEnd !== "function") H.fail(v.name + ": setLoopEnd is missing (rebuild the min file?)");
  synth.setLoopEnd(7680);
  report(synth.loopEnd === 7680, v.name + ": setLoopEnd(7680) sets loopEnd");
}

const PASSES = 4;
console.log("\n1. loopEnd set: pass k+1 = pass 1 shifted by k periods (k = 1.." + (PASSES - 1) + ")");
for (const c of periodCases) {
  const loopTicks = Math.max(c.loopEnd, c.fx.lastTick);
  const period = secondsAt(c.fx.tempos, loopTicks);
  console.log(c.name + ": period " + loopTicks + " ticks = " + period.toFixed(6) + " s");
  for (const v of fork) {
    const n = notesPerPass(v.source, c.fx.bytes);
    const r = playLooped(v.source, v.name, c.fx.bytes, (s) => s.setLoopEnd(c.loopEnd), 5 * 60 * 1000, (notes) => notes.length >= PASSES * n);
    const t = r.notes.map((x) => x[0]);
    if (t.length < PASSES * n) { report(false, v.name + ": only " + t.length + " notes, expected " + PASSES * n); continue; }
    let err = 0;
    for (let k = 1; k < PASSES; ++k)
      for (let i = 0; i < n; ++i) err = Math.max(err, Math.abs(t[k * n + i] - (t[i] + k * period)));
    const firsts = range(0, n, PASSES).map((i) => t[i]);
    report(err <= TOLERANCE,
      v.name.padEnd(26) + n + " notes/pass; first notes at " + firsts.map((x) => x.toFixed(4)).join(", ") +
      " s; max |error| " + err.toExponential(2) + " s");
  }
}

console.log("\n   contrast: upstream looping (loopEnd unset), first pass-to-pass interval");
for (const c of periodCases.filter((x) => [fixtures.fourBars, fixtures.pickup, fixtures.codex].includes(x.fx) && x.loopEnd !== 4000)) {
  const n = notesPerPass(reference.source, c.fx.bytes);
  const r = playLooped(reference.source, reference.name, c.fx.bytes, () => {}, 5 * 60 * 1000, (notes) => notes.length >= 2 * n);
  console.log("  " + c.name.split(",")[0] + ": upstream " + (r.notes[n][0] - r.notes[0][0]).toFixed(6) + " s; with loopEnd " +
    secondsAt(c.fx.tempos, Math.max(c.loopEnd, c.fx.lastTick)).toFixed(6) + " s");
}

console.log("\n2. loopEnd unset, 0, or equal to the last event: identical to upstream looping");
const unsetCases = [
  { name: "4 bars at 455,000 us", fx: fixtures.fourBars },
  { name: "2 bars with pickup", fx: fixtures.pickup },
  { name: "(a) Codex fixture", fx: fixtures.codex },
  { name: "(b) tempo at tick 0 + change", fx: fixtures.tick0Tempo },
  { name: "(c) tempo at tick 100", fx: fixtures.lateTempo },
  { name: "ws.mid", fx: fixtures.wsMid },
];
for (const c of unsetCases) {
  const ref = playLooped(reference.source, reference.name, c.fx.bytes, () => {}, 45000);
  const runs = fork.map((v) => ({ name: v.name + " (loopEnd unset)", r: playLooped(v.source, v.name, c.fx.bytes, () => {}, 45000) }));
  runs.push({ name: fork[0].name + " (setLoopEnd(7680) then setLoopEnd(0))",
    r: playLooped(fork[0].source, fork[0].name, c.fx.bytes, (s) => { s.setLoopEnd(7680); s.setLoopEnd(0); }, 45000) });
  if (c.fx === fixtures.wsMid)
    runs.push({ name: fork[0].name + " (loopEnd 15360 = last event)", r: playLooped(fork[0].source, fork[0].name, c.fx.bytes, (s) => s.setLoopEnd(15360), 45000) });
  for (const x of runs) {
    const same = JSON.stringify(x.r.notes) === JSON.stringify(ref.notes) && x.r.trace.length === ref.trace.length &&
      x.r.trace.every((e, i) => e === ref.trace[i]);
    report(same, c.name + ", 45 s looped: " + x.name + ": " + x.r.notes.length + " notes, " + x.r.trace.length +
      " WebAudio calls " + (same ? "identical to " : "DIFFER from ") + reference.name);
  }
}

if (failures) H.fail(failures + " loopEnd check(s) failed");
console.log("\nPASS: loopEnd loops on the given tick; unset matches upstream");
