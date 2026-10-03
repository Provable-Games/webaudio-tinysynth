/*
 * A note-on with velocity 0 is a note-off (MIDI 1.0; README noteOn()).
 */
import { describe, expect, test } from "vitest";
import { H, variants, synthFor, sources, playToEnd } from "./helpers.mjs";

const RELEASE = 0.3;
const timbre = () => [{ w: "triangle", t: 1, f: 0, v: 0.5, a: 0, h: 0.01, d: 0.2, s: 0.5, r: RELEASE }];
const calls = (trace) => trace.map((line) => JSON.parse(line));

describe.each(variants)("$name: velocity-0 note-on", (variant) => {
  /* WebAudio calls made by note-on 60 at 1 s and then `off` at 1.5 s, sent live. */
  function live(off) {
    const s = synthFor(variant);
    s.synth.setTimbre(0, 0, timbre());
    const from = s.trace.length;
    s.synth.send([0x90, 60, 100], 1);
    s.synth.send(off, 1.5);
    return s.trace.slice(from);
  }

  test("releases a sounding note exactly like a note-off", () => {
    const viaVelocity0 = live([0x90, 60, 0]);
    expect(viaVelocity0).toEqual(live([0x80, 60, 64]));
    expect(sources(viaVelocity0)).toHaveLength(1);
    // The gain falls toward 0 from the message time with the timbre's release time r.
    expect(calls(viaVelocity0)).toContainEqual(["setTargetAtTime", expect.stringMatching(/\.gain$/), 0, 1.5, RELEASE]);
  });

  test("does nothing when the note is not sounding", () => {
    const s = synthFor(variant);
    const from = s.trace.length;
    s.synth.send([0x90, 61, 0], 1);
    expect(s.trace.slice(from)).toEqual([]);
  });

  test("ends a note at its tick in a MIDI file", () => {
    const PPQ = 480;
    const file = (off) => H.makeMidi(PPQ, [H.midi.noteOn(0, 0, 60, 100), off]);
    const played = (bytes) => {
      const s = synthFor(variant);
      s.synth.setTimbre(0, 0, timbre());
      const from = s.trace.length;
      playToEnd(s, bytes);
      return s.trace.slice(from);
    };
    const viaVelocity0 = played(file({ tick: 480, bytes: [0x90, 60, 0] }));
    expect(viaVelocity0).toEqual(played(file(H.midi.noteOff(480, 0, 60))));
    // 480 ticks at the default 120 BPM is 0.5 s after the note-on.
    const [note] = sources(viaVelocity0);
    expect(calls(viaVelocity0)).toContainEqual(["setTargetAtTime", expect.stringMatching(/\.gain$/), 0, expect.closeTo(note.start + 0.5, 9), RELEASE]);
  });
});
