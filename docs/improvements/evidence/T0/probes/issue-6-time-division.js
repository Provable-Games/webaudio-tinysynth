#!/usr/bin/env node
/*
 * T0 probe for issue #6: SMPTE (high-bit) and zero time divisions, plus a
 * truncated division field.
 *
 * Song: format 0, note-on/off on channel 0 at ticks 0/120, 480/600, 960/1080,
 * no tempo events (120 BPM default). With PPQ 480 the note-ons are 0.5 s apart.
 * For each division the probe records song.timebase (the engine's
 * 4*division), maxTick, the first note-on intervals and the play status after
 * up to 20 s of virtual time. Calls run under a vm timeout; run the probe
 * under an external deadline.
 */
"use strict";
const C = require("./_common");
const { H } = C;

const TIMEOUT_MS = 2000;

function events() {
  const ev = [];
  for (let i = 0; i < 3; ++i) {
    ev.push(H.midi.noteOn(i * 480, 0, 60 + i, 100));
    ev.push(H.midi.noteOff(i * 480 + 120, 0, 60 + i));
  }
  return ev;
}

const divisions = [
  { name: "ppq-480-control", division: 480 },
  { name: "smpte-0xE728 (-25 fps, 40 ticks/frame)", division: 0xe728 },
  { name: "smpte-0xE850 (-24 fps, 80 ticks/frame)", division: 0xe850 },
  { name: "smpte-0xE350 (-29 fps, 80 ticks/frame)", division: 0xe350 },
  { name: "smpte-0xE250 (-30 fps, 80 ticks/frame)", division: 0xe250 },
  { name: "ppq-0", division: 0 },
];

C.emit(C.header("issue-6"));
for (const build of C.BUILDS) {
  for (const d of divisions) {
    const bytes = C.smf(0, d.division, [C.trackBytes(events(), true)]);
    const { synth, env, notes } = H.createSynth(C.source(build), build + " " + d.name);
    const buf = H.toArrayBuffer(bytes);
    const load = C.guarded("synth.loadMIDI(buf)", { synth, buf }, TIMEOUT_MS);
    let play = null;
    if (load.outcome === "returned") {
      play = C.guarded(
        "synth.setLoop(0); synth.playMIDI(); H.runUntil(env, () => synth.getPlayStatus().play === 0, 20000)",
        { synth, env, H }, TIMEOUT_MS);
    }
    const t = C.noteTimes(notes);
    C.emit({
      build, case: d.name, division: "0x" + d.division.toString(16),
      load: load.outcome, loadError: load.error,
      timebase: synth.song ? synth.song.timebase : null,
      tick2Time: C.round(synth.tick2Time, 12),
      maxTick: synth.maxTick,
      play: play && play.outcome, playError: play && play.error, finishedWithin20sVirtual: play && play.value,
      status: synth.getPlayStatus(), playTime: C.round(synth.playTime, 9), virtualMs: env.clock.ms,
      noteOns: t.length, noteOnIntervalsS: t.slice(1).map((x, i) => C.round(x - t[i], 9)),
    });
  }
  // Truncated header: MThd declares 6 bytes but the file ends inside the division field.
  for (const cut of [13, 12]) {
    const full = C.smf(0, 480, [C.trackBytes(events(), true)]);
    const bytes = full.subarray(0, cut);
    const { synth } = H.createSynth(C.source(build), build + " truncated-header");
    const buf = H.toArrayBuffer(Buffer.from(bytes));
    const load = C.guarded("synth.loadMIDI(buf)", { synth, buf }, TIMEOUT_MS);
    C.emit({
      build, case: "truncated-header-" + cut + "-bytes", load: load.outcome, loadError: load.error,
      timebase: synth.song ? String(synth.song.timebase) : null, events: synth.song ? synth.song.ev.length : null,
      maxTick: synth.maxTick, status: synth.getPlayStatus(),
    });
  }
}
