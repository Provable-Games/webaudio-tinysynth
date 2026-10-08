#!/usr/bin/env node
/*
 * Timing test for fractional MIDI tempo.
 *
 * MIDI tempo is microseconds per quarter note. Upstream rounds the derived
 * BPM down to an integer (Math.floor(60000000 / us)), so 455,000 us
 * (131.868 BPM) plays at 131 BPM, 0.66% slow. This test generates MIDI
 * files at fractional tempos, plays them on the mock clock, and requires
 * every note-on time to equal
 *     start + sum over tempo segments of ticks * us / 1e6 / ppq
 * within 1e-9 s, where start is the pre-Play audio clock plus the documented
 * 0.1 s opening lead (these fixtures begin at tick 0). Raw upstream must miss
 * this by more than 1 ms, which shows the
 * test detects the bug.
 *
 * Run: npm test
 */
"use strict";
const H = require("./harness");

const PPQ = 480;
const TOLERANCE = 1e-9;

const fixtures = [
  { name: "455,000 us (131.868 BPM) throughout", tempos: [[0, 455000]] },
  { name: "455,000 us, then 470,000 us (127.660 BPM) from beat 32", tempos: [[0, 455000], [32 * PPQ, 470000]] },
];

/* 128 eighth notes over 64 beats on channel 0, nudged off the grid by 0-39 ticks. */
function noteTicks() {
  const ticks = [];
  for (let i = 0; i < 128; ++i) ticks.push(i * (PPQ / 2) + (i % 4) * 13);
  return ticks;
}

function buildMidi(fx) {
  const events = fx.tempos.map(([tick, us]) => H.midi.tempo(tick, us));
  noteTicks().forEach((tick, i) => {
    events.push(H.midi.noteOn(tick, 0, 60 + (i % 12), 100));
    events.push(H.midi.noteOff(tick + 200, 0, 60 + (i % 12)));
  });
  return H.makeMidi(PPQ, events);
}

/* Seconds from tick 0 to `tick` under the tempo map. */
function secondsAt(tempos, tick) {
  let s = 0;
  for (let i = 0; i < tempos.length; ++i) {
    const [from, us] = tempos[i];
    const to = i + 1 < tempos.length ? tempos[i + 1][0] : Infinity;
    if (tick <= from) break;
    s += (Math.min(tick, to) - from) * us / 1e6 / PPQ;
  }
  return s;
}

function play(source, label, bytes) {
  const { synth, env, notes } = H.createSynth(source, label);
  synth.loadMIDI(H.toArrayBuffer(bytes));
  synth.setLoop(0);
  const audioNowBeforePlay = synth.actx.currentTime;
  synth.playMIDI();
  const start = audioNowBeforePlay + 0.1;
  if (!H.runUntil(env, () => synth.getPlayStatus().play === 0, 10 * 60 * 1000))
    H.fail(label + ": song did not finish");
  return { start, times: notes.map((n) => n[0]) };
}

function maxError(fx, result) {
  const ticks = noteTicks();
  if (result.times.length !== ticks.length)
    return { count: result.times.length, err: Infinity, at: -1 };
  let err = 0, at = -1;
  ticks.forEach((tick, i) => {
    const e = Math.abs(result.times[i] - (result.start + secondsAt(fx.tempos, tick)));
    if (e > err) { err = e; at = i; }
  });
  return { count: result.times.length, err, at };
}

const upstreamName = "upstream@" + H.UPSTREAM_COMMIT.slice(0, 7);
const runs = [
  { name: upstreamName + " (Math.floor)", source: H.upstreamSource(), expectPass: false },
  { name: upstreamName + "+patches", source: H.referenceSource(), expectPass: true },
].concat(H.forkVariants().map((v) => Object.assign(v, { expectPass: true })));

let failures = 0;
for (const fx of fixtures) {
  const bytes = buildMidi(fx);
  const last = noteTicks()[127];
  console.log(fx.name + ": " + noteTicks().length + " notes, ppq " + PPQ +
    ", last note-on at tick " + last + " = " + secondsAt(fx.tempos, last).toFixed(6) + " s after start");
  for (const r of runs) {
    const m = maxError(fx, play(r.source, r.name, bytes));
    const pass = m.err <= TOLERANCE;
    const ok = pass === r.expectPass;
    if (!ok) ++failures;
    console.log("  " + (ok ? "ok  " : "FAIL") + " " + r.name.padEnd(36) + String(m.count).padStart(4) +
      " note-ons  max |error| " + m.err.toExponential(3) + " s" +
      (m.at >= 0 ? " (note " + m.at + ")" : "") +
      "  -> " + (pass ? "within 1e-9 s" : "misses") + (r.expectPass ? "" : ", as expected"));
  }
}
if (failures) H.fail(failures + " timing check(s) failed");
console.log("PASS: note-on times match the fractional tempo map within " + TOLERANCE + " s");
