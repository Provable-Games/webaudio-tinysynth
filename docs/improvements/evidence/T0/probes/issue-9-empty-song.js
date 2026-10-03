#!/usr/bin/env node
/*
 * T0 probe for issue #9: play status of songs with no retained events.
 * The first case is the issue body's snippet (empty song, one env.step()).
 * Further cases step 60 s of virtual time, then call stopMIDI(), and count
 * oscillators created by playMIDI() (the dummy start-up oscillator).
 *   empty                 only End-of-Track
 *   text-meta-only        a text meta event (not retained) and End-of-Track
 *   tempo-only            one tick-0 tempo event (retained), loop off
 *   empty + loopEnd       empty song with setLoop(1), setLoopEnd(1920)
 *   then-normal-song      after the empty song, load and play a normal song
 * Run under an external deadline (run-all.sh).
 */
"use strict";
const C = require("./_common");
const { H } = C;

const TIMEOUT_MS = 2000;

function oscCreates(trace, from) {
  return trace.slice(from).filter((x) => x.startsWith('["create","osc#')).length;
}

function scenario(build, name, bytes, setup) {
  const { synth, env, trace, notes } = H.createSynth(C.source(build), build + " " + name);
  synth.loadMIDI(H.toArrayBuffer(bytes));
  setup(synth);
  const before = trace.length;
  synth.playMIDI();
  const oscByPlay = oscCreates(trace, before);
  const r1 = C.guarded("env.step(); synth.getPlayStatus()", { env, synth }, TIMEOUT_MS);
  const r60 = C.guarded("H.runUntil(env, () => synth.getPlayStatus().play === 0, 60000)", { env, synth, H }, TIMEOUT_MS);
  const after60 = synth.getPlayStatus();
  synth.stopMIDI();
  const afterStop = synth.getPlayStatus();
  return {
    build, case: name, events: synth.song.ev.length, oscCreatedByPlayMIDI: oscByPlay,
    afterOneStep: r1.value || r1.outcome, stoppedWithin60sVirtual: r60.value === undefined ? r60.outcome : r60.value,
    after60s: after60, afterStopMIDI: afterStop, noteOns: notes.length,
  };
}

C.emit(C.header("issue-9"));
const empty = H.makeMidi(480, []);
const textOnly = H.makeMidi(480, [{ tick: 0, bytes: [0xff, 0x01, 0x03, 0x61, 0x62, 0x63] }]);
const tempoOnly = H.makeMidi(480, [H.midi.tempo(0, 500000)]);
const normal = H.makeMidi(480, [H.midi.noteOn(0, 0, 60, 100), H.midi.noteOff(480, 0, 60)]);
for (const build of C.BUILDS) {
  // Issue body snippet, verbatim apart from the build.
  {
    const { synth, env } = H.createSynth(C.source(build), "empty song");
    synth.loadMIDI(H.toArrayBuffer(H.makeMidi(480, [])));
    synth.playMIDI();
    env.step();
    C.emit({ build, case: "issue-snippet", getPlayStatus: synth.getPlayStatus() });
  }
  C.emit(scenario(build, "empty", empty, (s) => s.setLoop(0)));
  C.emit(scenario(build, "text-meta-only", textOnly, (s) => s.setLoop(0)));
  C.emit(scenario(build, "tempo-only", tempoOnly, (s) => s.setLoop(0)));
  C.emit(scenario(build, "empty + loop + loopEnd 1920", empty, (s) => { s.setLoop(1); s.setLoopEnd(1920); }));
  {
    const { synth, env, notes } = H.createSynth(C.source(build), build + " then-normal");
    synth.loadMIDI(H.toArrayBuffer(empty));
    synth.playMIDI();
    env.step();
    const emptyStatus = synth.getPlayStatus();
    synth.loadMIDI(H.toArrayBuffer(normal));
    synth.setLoop(0);
    synth.playMIDI();
    const r = C.guarded("H.runUntil(env, () => synth.getPlayStatus().play === 0, 60000)", { env, synth, H }, TIMEOUT_MS);
    C.emit({ build, case: "then-normal-song", emptyStatus, normalFinished: r.value, normalStatus: synth.getPlayStatus(), noteOns: notes.length });
  }
}
