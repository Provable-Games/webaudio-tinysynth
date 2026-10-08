#!/usr/bin/env node
/*
 * T0 probe for issue #10: replaying a completed song without reloading.
 * Song (from the issue body): PPQ 480, note-on/off at ticks 0/120 and 240/480,
 * a 1,000,000 us (60 BPM) tempo event at tick 960, note-on/off at 1200/1440.
 * No tick-0 tempo event, so the first segment should use 120 BPM: the first
 * two note-ons are 240 ticks = 0.25 s apart on every pass.
 * Controls: the same song with an explicit tick-0 tempo event (120 BPM).
 * Run under an external deadline (run-all.sh).
 */
"use strict";
const C = require("./_common");
const { H } = C;

const TIMEOUT_MS = 2000;

function song(withTickZeroTempo) {
  const ev = [
    H.midi.noteOn(0, 0, 60, 100), H.midi.noteOff(120, 0, 60),
    H.midi.noteOn(240, 0, 62, 100), H.midi.noteOff(480, 0, 62),
    H.midi.tempo(960, 1000000),
    H.midi.noteOn(1200, 0, 64, 100), H.midi.noteOff(1440, 0, 64),
  ];
  if (withTickZeroTempo) ev.unshift(H.midi.tempo(0, 500000));
  return H.makeMidi(480, ev);
}

function passes(build, name, bytes, count) {
  const { synth, env, notes } = H.createSynth(C.source(build), build + " " + name);
  synth.loadMIDI(H.toArrayBuffer(bytes));
  synth.setLoop(0);
  const out = [];
  for (let p = 0; p < count; ++p) {
    const from = notes.length;
    const tempoBefore = synth.song.tempo;
    synth.playMIDI();
    const r = C.guarded("H.runUntil(env, () => !synth.playing, 60000)", { env, synth, H }, TIMEOUT_MS);
    const t = C.noteTimes(notes.slice(from));
    out.push({
      pass: p + 1, songTempoAtPlayMIDI: tempoBefore, finished: r.value === undefined ? r.outcome : r.value,
      noteOns: t.length, firstInterval: C.round(t[1] - t[0], 9), allIntervals: t.slice(1).map((x, i) => C.round(x - t[i], 9)),
    });
  }
  return { build, case: name, passes: out };
}

C.emit(C.header("issue-10"));
for (const build of C.BUILDS) {
  C.emit(passes(build, "delayed-tempo (issue fixture)", song(false), 3));
  C.emit(passes(build, "control: tempo at tick 0", song(true), 3));
}
