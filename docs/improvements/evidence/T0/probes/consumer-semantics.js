#!/usr/bin/env node
/*
 * T0 probe: engine semantics that the onchain-tinysynth schema
 * (src/types.cairo @ 71fce28) relies on, measured on the mock WebAudio.
 *   fm-frequency-basis   modulator frequency = target operator freq * t + f
 *   am-route             g:11 routes into operator 1's gain, depth not velocity-scaled
 *   output-velocity      output level = v * velocity^2 / 16384 (* key scaling)
 *   melodic-voice-end    voice end time after note-off uses operator 0's release only
 *   drum-stop-time       drum oscillators stop at t + p[0].d * 3.5; noteOff ignored
 *   voices-limit         released notes are pruned before held ones; drums are not
 *                        stored as voices but a drum hit still prunes melodic voices
 *   reverb-master-gain   setReverbLev(x) -> rev.gain = 8x; setMasterVol(x) -> out.gain = x
 *   w9999-coefficients   PeriodicWave arrays built for "w9999" (index 0 = DC)
 *   unknown-wave         a "w..." name other than w9999 at note-on
 *   quality-string       setQuality("0") (an ASCII digit) selects the quality-1 tables
 * Run under an external deadline (run-all.sh).
 */
"use strict";
const C = require("./_common");
const { H } = C;

function parse(trace) { return trace.map((x) => JSON.parse(x)); }
function lastValue(tr, id) {
  let v;
  for (const a of tr) if (a[0] === "value" && a[1] === id) v = a[2];
  return v;
}

C.emit(C.header("consumer-semantics"));
for (const build of C.BUILDS) {
  const src = C.source(build);
  {
    const { synth, trace } = H.createSynth(src, "fm");
    synth.setTimbre(0, 0, [{ w: "sine", t: 2, f: 0, v: 1 }, { w: "sine", g: 1, t: 3, f: 5, v: 1 }]);
    const from = trace.length;
    synth.noteOn(0, 69, 127);
    const tr = parse(trace.slice(from));
    const oscs = tr.filter((a) => a[0] === "create" && a[1].startsWith("osc#")).map((a) => a[1]);
    C.emit({ build, case: "fm-frequency-basis", note: 69, carrierHz: lastValue(tr, oscs[0] + ".frequency"), modulatorHz: lastValue(tr, oscs[1] + ".frequency"),
      cairoDocFormulaWouldGive: 440 * 3 + 5, engineFormula: "fp[target]*t+f = 880*3+5 = 2645" });
  }
  {
    const { synth, trace } = H.createSynth(src, "am");
    synth.setTimbre(0, 0, [{ w: "sine", v: 1 }, { w: "sine", g: 11, t: 0, f: 6, v: 0.25 }]);
    const from = trace.length;
    synth.noteOn(0, 60, 64);
    const tr = parse(trace.slice(from));
    const oscs = tr.filter((a) => a[0] === "create" && a[1].startsWith("osc#")).map((a) => a[1]);
    const gains = tr.filter((a) => a[0] === "create" && a[1].startsWith("gain#")).map((a) => a[1]);
    const conn = tr.filter((a) => a[0] === "connect").map((a) => a[1] + "->" + a[2]);
    const setv = tr.filter((a) => a[0] === "setValueAtTime" && a[1] === gains[1] + ".gain").map((a) => a[2]);
    C.emit({ build, case: "am-route", connections: conn.filter((c) => c.startsWith(oscs[1]) || c.startsWith(gains[1])), modulatorGainInitial: setv[0], note: "0.25 regardless of velocity 64" });
  }
  {
    const { synth, trace } = H.createSynth(src, "vel");
    synth.setTimbre(0, 0, [{ w: "sine", v: 0.5, k: -1 }]);
    const out = {};
    for (const [n, vel] of [[60, 127], [60, 64], [72, 127]]) {
      const from = trace.length;
      synth.noteOn(0, n, vel);
      const tr = parse(trace.slice(from));
      const g = tr.filter((a) => a[0] === "create" && a[1].startsWith("gain#")).map((a) => a[1])[0];
      out[n + "/" + vel] = tr.filter((a) => a[0] === "setValueAtTime" && a[1] === g + ".gain").map((a) => C.round(a[2], 9))[0];
    }
    C.emit({ build, case: "output-velocity", timbre: "v 0.5, k -1", levels: out,
      expected: { "60/127": C.round(0.5 * 127 * 127 / 16384, 9), "60/64": C.round(0.5 * 64 * 64 / 16384, 9), "72/127": C.round(0.5 * 127 * 127 / 16384 * 0.5, 9) } });
  }
  {
    const { synth } = H.createSynth(src, "rel");
    synth.setTimbre(0, 0, [{ w: "sine", r: 0.1 }, { w: "sine", r: 2 }]);
    synth.noteOn(0, 60, 100, 1);
    synth.noteOff(0, 60, 2);
    const nt = synth.notetab[synth.notetab.length - 1];
    C.emit({ build, case: "melodic-voice-end", releases: nt.r, noteOffAt: 2, voiceEndTime: C.round(nt.e, 9), expectedFromOp0: 2 + 0.1 * 3.5, op1WouldNeed: 2 + 2 * 3.5 });
  }
  {
    const { synth, trace } = H.createSynth(src, "drum");
    synth.setTimbre(1, 36, [{ w: "sine", t: 0, f: 60, d: 0.2 }, { w: "n0", t: 0, f: 440, d: 1, r: 3 }]);
    synth.setTimbre(1, 38, [{ w: "sine", t: 0, f: 200, d: 0 }]);
    const from = trace.length;
    synth.noteOn(9, 36, 100, 1);
    synth.noteOn(9, 38, 100, 1);
    const drumVoices = synth.notetab.length - 1; // the constructor's warm-up note stays in notetab
    const beforeOff = trace.length;
    synth.noteOff(9, 36, 1.1);
    const stops = parse(trace.slice(from)).filter((a) => a[0] === "stop").map((a) => [a[1], a[2]]);
    C.emit({ build, case: "drum-stop-time", stops, expected: "note 36: both operators stop at 1+0.2*3.5=1.7; note 38 (d=0): stop at 1 (start time)",
      drumVoicesInNotetab: drumVoices, webAudioCallsMadeByNoteOff: trace.length - beforeOff });
  }
  {
    const { synth } = H.createSynth(src, "voices");
    synth.setVoices(2);
    synth.noteOn(0, 60, 100, 1);
    synth.noteOn(0, 62, 100, 2);
    synth.noteOff(0, 60, 3);
    synth.noteOn(0, 64, 100, 4);
    const held = synth.notetab.map((n) => n.n).sort();
    synth.noteOn(0, 65, 100, 5);
    const after = synth.notetab.map((n) => n.n).sort();
    synth.noteOn(9, 36, 100, 6);
    const afterDrum = synth.notetab.map((n) => n.n).sort();
    C.emit({ build, case: "voices-limit", voices: 2, afterReleased60ThenNoteOn64: held, afterNoteOn65: after,
      melodicNotesAfterOneDrumHit: afterDrum, note: "drum hits are not stored in notetab but run _limitVoices, pruning melodic notes to voices-1" });
  }
  {
    const { synth } = H.createSynth(src, "gains");
    const r = {};
    for (const x of [0, 0.3, 1]) { synth.setReverbLev(x); r["setReverbLev(" + x + ")"] = synth.rev.gain.value; }
    for (const x of [0.4, 0.5, 1]) { synth.setMasterVol(x); r["setMasterVol(" + x + ")"] = synth.out.gain.value; }
    C.emit({ build, case: "reverb-master-gain", values: r });
  }
  {
    const { trace } = H.createSynth(src, "wave");
    const w = parse(trace).filter((a) => a[0] === "createPeriodicWave")[0];
    C.emit({ build, case: "w9999-coefficients", real: w[2], imag: w[3] });
  }
  {
    const { synth } = H.createSynth(src, "unknown");
    synth.setTimbre(0, 0, [{ w: "w1234", v: 0.5 }]);
    const n = synth.notetab.length;
    let err = null;
    try { synth.noteOn(0, 60, 100); } catch (e) { err = e.message; }
    C.emit({ build, case: "unknown-wave", error: err, mockNote: "the mock's setPeriodicWave reads w._id, so a browser error message will differ", notetabGrew: synth.notetab.length - n });
  }
  {
    const { synth } = H.createSynth(src, "qs");
    synth.setQuality("0");
    C.emit({ build, case: "quality-string", quality: synth.quality, program0IsQuality1Timbre: synth.program[0].p === synth.program1[0] });
  }
}
