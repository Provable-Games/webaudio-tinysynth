#!/usr/bin/env node
/*
 * Tests for loopEnd / setLoopEnd (whole-bar looping).
 *
 * Upstream's looping sequencer starts the next pass on the song's last
 * event, so any rest after the last event (for example the end of the final
 * bar) is lost and the loop drifts off the bar grid. With loopEnd set (in
 * MIDI ticks), each pass starts max(loopEnd, last event tick) ticks after
 * the previous one.
 *
 * 1. With loopEnd set, every note of passes 2 and 3 must land exactly one
 *    and two loop periods after the same note in pass 1 (within 1e-9 s).
 *    So the second pass's first note is at start + loopEnd * secondsPerTick.
 * 2. With loopEnd unset (or set back to 0), looping playback must match
 *    upstream (plus FORK_PATCHES) exactly: identical _note calls and
 *    WebAudio traces. The same holds when loopEnd equals the last event's
 *    tick.
 *
 * Run: npm test
 */
"use strict";
const fs = require("fs");
const path = require("path");
const H = require("./harness");

const PPQ = 480;
const BAR = 4 * PPQ;
const TOLERANCE = 1e-9;

/* Quarter notes (note-off 80 ticks early) at the given ticks, channel 0. */
function quarterNotes(ticks) {
  const ev = [];
  ticks.forEach((t, i) => {
    ev.push(H.midi.noteOn(t, 0, 60 + (i % 12), 100));
    ev.push(H.midi.noteOff(t + PPQ - 80, 0, 60 + (i % 12)));
  });
  return ev;
}
const range = (from, step, n) => Array.from({ length: n }, (_, i) => from + i * step);

/* 4 bars at 455,000 us: 13 quarter notes from tick 0, last event (note-off) at tick 6160. */
const fourBars = H.makeMidi(PPQ, [H.midi.tempo(0, 455000)].concat(quarterNotes(range(0, PPQ, 13))));
/* 2 bars, no tempo event (120 BPM): first note after an eighth rest, last event at tick 3520. */
const pickup = H.makeMidi(PPQ, quarterNotes(range(PPQ / 2, PPQ, 7)));
const wsMid = fs.readFileSync(path.join(H.ROOT, "ws.mid"));

const SPT_455 = 0.455 / PPQ;
const SPT_120 = 0.5 / PPQ;
const SPT_WS = 0.428571 / PPQ;

const periodCases = [
  { name: "4 bars at 455,000 us, last event tick 6160, loopEnd 7680 (4 bars)", bytes: fourBars, loopEnd: 4 * BAR, period: 4 * BAR, spt: SPT_455 },
  { name: "2 bars at 120 BPM, first note at tick 240, last event 3520, loopEnd 3840", bytes: pickup, loopEnd: 2 * BAR, period: 2 * BAR, spt: SPT_120 },
  { name: "loopEnd 4000 below the last event (6160): period is 6160", bytes: fourBars, loopEnd: 4000, period: 6160, spt: SPT_455 },
  { name: "ws.mid, loopEnd 15360 (= its last event tick and maxTick)", bytes: wsMid, loopEnd: 15360, period: 15360, spt: SPT_WS },
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
  r.start = r.synth.playTime;
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

console.log("\n1. loopEnd set: pass k = pass 1 shifted by k * period ticks");
for (const c of periodCases) {
  console.log(c.name);
  for (const v of fork) {
    const n = notesPerPass(v.source, c.bytes);
    const r = playLooped(v.source, v.name, c.bytes, (s) => s.setLoopEnd(c.loopEnd), 5 * 60 * 1000, (notes) => notes.length >= 3 * n);
    const t = r.notes.map((x) => x[0]);
    if (t.length < 3 * n) { report(false, v.name + ": only " + t.length + " notes, expected " + 3 * n); continue; }
    let err = 0;
    for (let k = 1; k <= 2; ++k)
      for (let i = 0; i < n; ++i) err = Math.max(err, Math.abs(t[k * n + i] - (t[i] + k * c.period * c.spt)));
    const firstEvent = r.start + c.period * c.spt;     // pass 2's first event
    const firstNote = t[0] + c.period * c.spt;         // pass 2's first note
    const firstErr = Math.abs(t[n] - firstNote);
    report(err <= TOLERANCE && firstErr <= TOLERANCE,
      v.name.padEnd(26) + n + " notes/pass; pass 2 first note " + t[n].toFixed(6) + " s (expected " +
      firstNote.toFixed(6) + "; start + loop * spt = " + firstEvent.toFixed(6) + "); max |error| over passes 2-3 " +
      err.toExponential(2) + " s");
  }
}

console.log("\n   contrast: upstream looping (loopEnd unset) on the same fixtures");
for (const c of periodCases.slice(0, 2)) {
  const n = notesPerPass(reference.source, c.bytes);
  const r = playLooped(reference.source, reference.name, c.bytes, () => {}, 5 * 60 * 1000, (notes) => notes.length >= 2 * n);
  const ticks = (r.notes[n][0] - r.notes[0][0]) / c.spt;
  console.log("  " + c.name.split(",")[0] + ": upstream period " + ticks.toFixed(3) + " ticks instead of " + c.period);
}

console.log("\n2. loopEnd unset, 0, or equal to the last event: identical to upstream looping");
const unsetCases = [
  { name: "4 bars at 455,000 us", bytes: fourBars },
  { name: "2 bars with pickup", bytes: pickup },
  { name: "ws.mid", bytes: wsMid },
];
for (const c of unsetCases) {
  const ref = playLooped(reference.source, reference.name, c.bytes, () => {}, 45000);
  const runs = fork.map((v) => ({ name: v.name + " (loopEnd unset)", r: playLooped(v.source, v.name, c.bytes, () => {}, 45000) }));
  runs.push({ name: fork[0].name + " (setLoopEnd(7680) then setLoopEnd(0))",
    r: playLooped(fork[0].source, fork[0].name, c.bytes, (s) => { s.setLoopEnd(7680); s.setLoopEnd(0); }, 45000) });
  if (c.bytes === wsMid)
    runs.push({ name: fork[0].name + " (loopEnd 15360 = last event)", r: playLooped(fork[0].source, fork[0].name, c.bytes, (s) => s.setLoopEnd(15360), 45000) });
  for (const x of runs) {
    const same = JSON.stringify(x.r.notes) === JSON.stringify(ref.notes) && x.r.trace.length === ref.trace.length &&
      x.r.trace.every((e, i) => e === ref.trace[i]);
    report(same, c.name + ", 45 s looped: " + x.name + ": " + x.r.notes.length + " notes, " + x.r.trace.length +
      " WebAudio calls " + (same ? "identical to " : "DIFFER from ") + reference.name);
  }
}

if (failures) H.fail(failures + " loopEnd check(s) failed");
console.log("\nPASS: loopEnd loops on the given tick; unset matches upstream");
