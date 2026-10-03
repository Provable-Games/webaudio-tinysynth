#!/usr/bin/env node
/*
 * T0 probe for issue #21: state after locateMIDI().
 *   manual-program-survives  song with no program events; setProgram(0,40);
 *                            locateMIDI(0) -> pg[0]? (and what loadMIDI does)
 *   backward-seek-tempo      song with a 60 BPM tempo event at tick 960:
 *                            locateMIDI(1300) then locateMIDI(0), play; first
 *                            note-on interval (0.25 s at the song's 120 BPM start)
 *   backward-seek-program    program change to 40 at tick 960: locateMIDI(1300),
 *                            locateMIDI(0), play; program used by the first note
 *   backward-seek-bend       pitch bend at tick 960 reached by playback, then
 *                            locateMIDI(0): bend[0] after the seek
 *   forward-seek-bend        locateMIDI(1300) from a fresh load: bend[0]
 *   no-song-seek             locateMIDI(0) on a synth with no song loaded
 * Run under an external deadline (run-all.sh).
 */
"use strict";
const C = require("./_common");
const { H } = C;

const TIMEOUT_MS = 2000;

function baseEvents() {
  return [
    H.midi.noteOn(0, 0, 60, 100), H.midi.noteOff(120, 0, 60),
    H.midi.noteOn(240, 0, 62, 100), H.midi.noteOff(480, 0, 62),
    H.midi.noteOn(1200, 0, 64, 100), H.midi.noteOff(1440, 0, 64),
  ];
}

function make(build, name, extra) {
  const r = H.createSynth(C.source(build), build + " " + name);
  r.synth.loadMIDI(H.toArrayBuffer(H.makeMidi(480, baseEvents().concat(extra || []))));
  r.synth.setLoop(0);
  return r;
}

function firstInterval(env, synth, notes) {
  const from = notes.length;
  synth.playMIDI();
  C.guarded("H.runUntil(env, () => !synth.playing, 60000)", { env, synth, H }, TIMEOUT_MS);
  const t = C.noteTimes(notes.slice(from));
  return { noteOns: t.length, firstInterval: C.round(t[1] - t[0], 9), firstNoteTimbreIsProgram: notes[from] ? synth.program.findIndex((p) => p.p === notes[from][4]) : null };
}

C.emit(C.header("issue-21"));
for (const build of C.BUILDS) {
  {
    const { synth } = make(build, "manual-program");
    const afterLoad = synth.pg[0];
    synth.setProgram(0, 40);
    synth.locateMIDI(0);
    const afterSeek = synth.pg[0];
    synth.loadMIDI(H.toArrayBuffer(H.makeMidi(480, baseEvents())));
    C.emit({ build, case: "manual-program-survives", pgAfterLoad: afterLoad, pgAfterSetProgram40ThenLocate0: afterSeek, pgAfterReload: synth.pg[0] });
  }
  {
    const tempo = [H.midi.tempo(960, 1000000)];
    const fresh = make(build, "tempo-fresh", tempo);
    const control = firstInterval(fresh.env, fresh.synth, fresh.notes);
    const { synth, env, notes } = make(build, "tempo-seek", tempo);
    synth.locateMIDI(1300);
    const tempoAfterForward = synth.song.tempo;
    synth.locateMIDI(0);
    const tempoAfterBack = synth.song.tempo;
    const r = firstInterval(env, synth, notes);
    C.emit({ build, case: "backward-seek-tempo", controlFreshPlay: control, songTempoAfterLocate1300: tempoAfterForward, songTempoAfterLocate0: tempoAfterBack, afterBackwardSeek: r });
  }
  {
    const prog = [{ tick: 960, bytes: [0xc0, 40] }];
    const fresh = make(build, "program-fresh", prog);
    const control = firstInterval(fresh.env, fresh.synth, fresh.notes);
    const { synth, env, notes } = make(build, "program-seek", prog);
    synth.locateMIDI(1300);
    const pgForward = synth.pg[0];
    synth.locateMIDI(0);
    const pgBack = synth.pg[0];
    const r = firstInterval(env, synth, notes);
    C.emit({ build, case: "backward-seek-program", controlFirstNoteProgram: control.firstNoteTimbreIsProgram, pgAfterLocate1300: pgForward, pgAfterLocate0: pgBack, firstNoteProgramAfterBackwardSeek: r.firstNoteTimbreIsProgram });
  }
  {
    const bend = [{ tick: 960, bytes: [0xe0, 0x00, 0x60] }]; // 0x3000 = 12288, +4096 from centre
    const { synth, env } = make(build, "bend-back", bend);
    synth.playMIDI();
    C.guarded("H.runUntil(env, () => !synth.playing, 60000)", { env, synth, H }, TIMEOUT_MS);
    const bendAtEnd = synth.bend[0];
    synth.locateMIDI(0);
    C.emit({ build, case: "backward-seek-bend", bendCentsAfterPlayback: C.round(bendAtEnd, 6), bendCentsAfterLocate0: C.round(synth.bend[0], 6) });
    const f = make(build, "bend-forward", bend);
    f.synth.locateMIDI(1300);
    C.emit({ build, case: "forward-seek-bend", bendCentsAfterLocate1300FromFresh: C.round(f.synth.bend[0], 6), expectedIfReconstructed: C.round((0x3000 - 8192) * (0x100 * 100 / 127) / 8192, 6) });
  }
  {
    const { synth } = H.createSynth(C.source(build), build + " no-song");
    const r = C.guarded("synth.locateMIDI(0)", { synth }, TIMEOUT_MS);
    C.emit({ build, case: "no-song-seek", outcome: r.outcome, error: r.error });
  }
}
