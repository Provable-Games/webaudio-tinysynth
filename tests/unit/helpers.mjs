/*
 * Helpers for the Vitest unit tests. They load tests/harness.js (mock
 * WebAudio, hand-driven clock, Standard MIDI File writer) through Node's own
 * require, and read the recorded WebAudio calls back as the sound sources the
 * synth scheduled. Expected values in the tests come from the MIDI
 * specification, the README, or independent calculation.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const H = require("../harness.js");

/* The builds under test: webaudio-tinysynth.js and webaudio-tinysynth.min.js. */
export const variants = H.forkVariants();

/* A synth constructed with `opts` in a fresh mock environment: {synth, env, trace}. */
export function synthFor(variant, opts) {
  return H.createSynth(variant.source, variant.name, opts);
}

/* Equal-tempered frequency of MIDI note n, A4 (69) = 440 Hz. */
export function noteHz(n) {
  return 440 * Math.pow(2, (n - 69) / 12);
}

/* Seconds from tick 0 to `tick` under a tempo map [[tick, microseconds per quarter], ...] starting at tick 0. */
export function secondsAt(ppq, tempos, tick) {
  let s = 0;
  for (let i = 0; i < tempos.length; ++i) {
    const [from, us] = tempos[i];
    const to = i + 1 < tempos.length ? tempos[i + 1][0] : Infinity;
    if (tick <= from) break;
    s += (Math.min(tick, to) - from) * us / 1e6 / ppq;
  }
  return s;
}

/*
 * Sound sources (oscillators and buffer sources) created in trace[from..], in
 * creation order, as {id, type, freq, start, stop}. playMIDI's silent
 * oscillator (frequency 0) is not a note and is skipped.
 */
export function sources(trace, from = 0) {
  const byId = new Map();
  const ownerOf = (param) => byId.get(param.split(".")[0]);
  for (const line of trace.slice(from)) {
    const [op, id, ...args] = JSON.parse(line);
    if (op === "create" && /^(osc|src)#/.test(id)) {
      byId.set(id, { id, type: id.startsWith("osc") ? "sine" : "buffer", freq: undefined, start: undefined, stop: undefined });
    } else if (op === "type" && byId.has(id)) {
      byId.get(id).type = args[0];
    } else if (op === "setPeriodicWave" && byId.has(id)) {
      byId.get(id).type = "periodic";
    } else if (op === "value" && /\.(frequency|playbackRate)$/.test(id) && ownerOf(id)) {
      ownerOf(id).freq = args[0];
    } else if (op === "start" && byId.has(id)) {
      byId.get(id).start = args[0];
    } else if (op === "stop" && byId.has(id)) {
      byId.get(id).stop = args[0];
    }
  }
  return [...byId.values()].filter((s) => s.freq !== 0);
}

/* A format-1 file with one track per event list (built with the harness's format-0 writer). */
export function makeMidiFormat1(ppq, tracks) {
  const chunks = tracks.map((events) => H.makeMidi(ppq, events).subarray(14));
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length, (ppq >> 8) & 0xff, ppq & 0xff];
  return Buffer.concat([Buffer.from(header), ...chunks]);
}

/* Load `bytes`, play once without looping until the song ends, then let `tailMs` more pass. */
export function playToEnd({ synth, env }, bytes, tailMs = 2000) {
  synth.loadMIDI(H.toArrayBuffer(bytes));
  synth.setLoop(0);
  synth.playMIDI();
  if (!H.runUntil(env, () => synth.getPlayStatus().play === 0, 10 * 60 * 1000)) throw new Error("song did not finish");
  H.runUntil(env, () => false, tailMs);
}

export const programChange = (tick, ch, program) => ({ tick, bytes: [0xc0 | ch, program] });
