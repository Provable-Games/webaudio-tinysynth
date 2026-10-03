/*
 * MIDI file playback: event order and timing. Each note-on starts one sound
 * source; its start time and pitch are compared with the tempo map and note
 * numbers of a generated file.
 */
import { describe, expect, test } from "vitest";
import { H, variants, synthFor, sources, noteHz, secondsAt, makeMidiFormat1, playToEnd, programChange } from "./helpers.mjs";

const PPQ = 480;
const sine = () => [{ w: "sine", t: 1, f: 0, v: 0.5, d: 0.1, s: 0.5, r: 0.1 }];
const square = () => [{ w: "square", t: 1, f: 0, v: 0.5, d: 0.1, s: 0.5, r: 0.1 }];

describe.each(variants)("$name: MIDI file playback", (variant) => {
  test("note-ons follow a fractional tempo map", () => {
    // 455,000 us = 131.868... BPM, then 470,000 us = 127.659... BPM from beat 4.
    const tempos = [[0, 455000], [4 * PPQ, 470000]];
    const ticks = [0, 240, 493, 1000, 1920, 2133, 2400, 3847];
    const events = tempos.map(([tick, us]) => H.midi.tempo(tick, us));
    ticks.forEach((tick, i) => events.push(H.midi.noteOn(tick, 0, 60 + i, 100), H.midi.noteOff(tick + 100, 0, 60 + i)));
    const s = synthFor(variant);
    s.synth.setTimbre(0, 0, sine());
    const from = s.trace.length;
    playToEnd(s, H.makeMidi(PPQ, events));

    const played = sources(s.trace, from);
    expect(played).toHaveLength(ticks.length);
    played.forEach((src, i) => {
      expect(src.freq).toBeCloseTo(noteHz(60 + i), 9);
      expect(src.start - played[0].start).toBeCloseTo(secondsAt(PPQ, tempos, ticks[i]), 9);
    });
  });

  test("notes from several tracks play in time order", () => {
    // Format 1, no tempo event: the MIDI default of 120 BPM, so 480 ticks = 0.5 s.
    const trackA = [[0, 60], [960, 62], [1920, 64]].map(([tick, n]) => [H.midi.noteOn(tick, 0, n, 100), H.midi.noteOff(tick + 240, 0, n)]).flat();
    const trackB = [[480, 61], [1440, 63]].map(([tick, n]) => [H.midi.noteOn(tick, 1, n, 100), H.midi.noteOff(tick + 240, 1, n)]).flat();
    const s = synthFor(variant);
    s.synth.setTimbre(0, 0, sine());
    const from = s.trace.length;
    playToEnd(s, makeMidiFormat1(PPQ, [trackA, trackB]));

    const played = sources(s.trace, from);
    expect(played.map((src) => src.freq)).toEqual([60, 61, 62, 63, 64].map(noteHz));
    expect(played.map((src) => src.start - played[0].start)).toEqual([0, 0.5, 1, 1.5, 2].map((x) => expect.closeTo(x, 9)));
  });

  test("events at the same tick take effect in file order", () => {
    const events = [
      programChange(0, 0, 1), H.midi.noteOn(0, 0, 60, 100),    // program first: the note uses program 1
      H.midi.noteOn(480, 0, 62, 100), programChange(480, 0, 0), // note first: it still uses program 1
      H.midi.noteOn(960, 0, 64, 100),                           // program 0 from here on
      H.midi.noteOff(1200, 0, 60), H.midi.noteOff(1200, 0, 62), H.midi.noteOff(1200, 0, 64),
    ];
    const s = synthFor(variant);
    s.synth.setTimbre(0, 0, sine());
    s.synth.setTimbre(0, 1, square());
    const from = s.trace.length;
    playToEnd(s, H.makeMidi(PPQ, events));

    expect(sources(s.trace, from).map((src) => src.type)).toEqual(["square", "square", "sine"]);
  });
});
