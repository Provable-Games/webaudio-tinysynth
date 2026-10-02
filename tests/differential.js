#!/usr/bin/env node
/*
 * Differential test: this fork vs. upstream webaudio-tinysynth.
 *
 * Loads the upstream source (g200kg/webaudio-tinysynth at UPSTREAM_COMMIT),
 * this repo's webaudio-tinysynth.js and webaudio-tinysynth.min.js into
 * separate `vm` contexts backed by a mock WebAudio implementation, plays
 * every MIDI file in the repo through each one on a hand-driven clock, and
 * requires every variant to produce exactly the same
 *   - sequence of _note(t, ch, n, v, p) calls, and
 *   - trace of WebAudio calls (node creation, connections, AudioParam
 *     scheduling, start/stop),
 * as upstream.
 *
 * See harness.js for how the upstream reference is read. Run: npm test
 */
"use strict";
const fs = require("fs");
const path = require("path");
const H = require("./harness");

const TAIL_MS = 15000;       // keep the clock running after the song ends
const MAX_MS = 60 * 60 * 1000;

function run(source, label, midiBytes) {
  const { synth, env, trace, notes } = H.createSynth(source, label);
  synth.loadMIDI(H.toArrayBuffer(midiBytes));
  synth.setLoop(0);
  synth.playMIDI();
  const st = synth.getPlayStatus();
  if (st.play !== 1 || !(st.maxTick > 0)) H.fail(label + ": playMIDI did not start (" + JSON.stringify(st) + ")");

  if (!H.runUntil(env, () => synth.getPlayStatus().play === 0, MAX_MS))
    H.fail(label + ": song did not finish within " + MAX_MS / 1000 + "s of virtual time");
  const endedAt = env.clock.ms;
  H.runUntil(env, () => false, TAIL_MS);
  const end = synth.getPlayStatus();
  return {
    notes: notes.map((n) => JSON.stringify(n)), trace, endedAt, maxTick: st.maxTick,
    curTick: end.curTick, voicesLeft: synth.notetab.length,
  };
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; ++i) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

/* ---------- main ---------- */

const variants = [{ name: "upstream@" + H.UPSTREAM_COMMIT.slice(0, 7), source: H.upstreamSource() }].concat(H.forkVariants());

const midiFiles = ["ws.mid"].concat(
  fs.readdirSync(path.join(H.ROOT, "test-midi")).filter((f) => /\.midi?$/i.test(f)).sort().map((f) => "test-midi/" + f));

let failures = 0;
let totalNotes = 0;
console.log("reference: upstream " + H.UPSTREAM_COMMIT + " (sha256 verified)");
for (const file of midiFiles) {
  const bytes = fs.readFileSync(path.join(H.ROOT, file));
  const results = variants.map((v) => run(v.source, v.name, bytes));
  const ref = results[0];
  if (ref.notes.length === 0) { console.log("FAIL " + file + ": upstream produced no notes"); ++failures; continue; }
  totalNotes += ref.notes.length;
  const problems = [];
  for (let i = 1; i < variants.length; ++i) {
    const r = results[i];
    const dn = firstDiff(ref.notes, r.notes);
    const dt = firstDiff(ref.trace, r.trace);
    if (dn !== -1) problems.push(variants[i].name + ": _note #" + dn + " differs\n    upstream: " + ref.notes[dn] + "\n    this:     " + r.notes[dn]);
    if (dt !== -1) problems.push(variants[i].name + ": WebAudio call #" + dt + " differs\n    upstream: " + ref.trace[dt] + "\n    this:     " + r.trace[dt]);
    if (r.endedAt !== ref.endedAt || r.curTick !== ref.curTick || r.voicesLeft !== ref.voicesLeft)
      problems.push(variants[i].name + ": end state differs");
  }
  const summary = file.padEnd(46) + String(ref.notes.length).padStart(5) + " notes  " +
    String(ref.trace.length).padStart(7) + " WebAudio calls  maxTick " + ref.maxTick +
    "  ends at " + (ref.endedAt / 1000).toFixed(2) + "s";
  if (problems.length) {
    ++failures;
    console.log("FAIL " + summary);
    for (const p of problems) console.log("  " + p);
  } else {
    console.log("ok   " + summary);
  }
}
console.log("\n" + midiFiles.length + " files, " + totalNotes + " notes per variant; compared " +
  variants.slice(1).map((v) => v.name).join(" and ") + " against " + variants[0].name);
if (failures) H.fail(failures + " file(s) differ");
console.log("PASS: identical _note sequences and WebAudio call traces");
