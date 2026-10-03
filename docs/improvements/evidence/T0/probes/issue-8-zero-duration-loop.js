#!/usr/bin/env node
/*
 * T0 probe for issue #8: looping a song whose retained events are all at
 * tick 0. The first case is the issue body's snippet (one env.step() under a
 * 150 ms vm timeout). Variants:
 *   loopEnd-480       same song with setLoopEnd(480) (intentional padding)
 *   tempo-only-loop   a song whose only retained event is a tick-0 tempo event
 *   loop-off-control  same song as the issue, setLoop(0)
 * Run under an external deadline (run-all.sh).
 */
"use strict";
const C = require("./_common");
const { H } = C;

const TIMEOUT_MS = 150;

function scenario(build, name, events, setup) {
  const { synth, env, notes } = H.createSynth(C.source(build), build + " " + name);
  synth.loadMIDI(H.toArrayBuffer(H.makeMidi(480, events)));
  setup(synth);
  synth.playMIDI();
  const r = C.guarded("env.step()", { env }, TIMEOUT_MS);
  let more = null;
  if (r.outcome === "returned") {
    more = C.guarded("for (let i = 0; i < 50; ++i) env.step(); 1", { env }, TIMEOUT_MS * 10);
  }
  const t = C.noteTimes(notes);
  return {
    build, case: name, firstStep: r.outcome, ms: C.round(r.ms, 1), error: r.error,
    furtherSteps: more && more.outcome, virtualMs: env.clock.ms,
    status: synth.getPlayStatus(), loopEnd: synth.loopEnd, playTime: C.round(synth.playTime, 6),
    noteOns: t.length, firstNoteOnTimes: t.slice(0, 4).map((x) => C.round(x, 6)),
  };
}

C.emit(C.header("issue-8"));
const tickZero = [H.midi.noteOn(0, 0, 60, 100), H.midi.noteOff(0, 0, 60)];
for (const build of C.BUILDS) {
  C.emit(scenario(build, "issue-snippet (loop on, loopEnd 0)", tickZero, (s) => s.setLoop(1)));
  C.emit(scenario(build, "loopEnd-480", tickZero, (s) => { s.setLoop(1); s.setLoopEnd(480); }));
  C.emit(scenario(build, "tempo-only-loop", [H.midi.tempo(0, 500000)], (s) => s.setLoop(1)));
  C.emit(scenario(build, "loop-off-control", tickZero, (s) => s.setLoop(0)));
}
