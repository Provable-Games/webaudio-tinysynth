/*
 * Program and channel selection in both quality modes. Distinct timbres are
 * installed through the public setTimbre(), so each note's waveform and
 * frequency (note frequency x t + f) show which timbre it used.
 */
import { describe, expect, test } from "vitest";
import { variants, synthFor, sources, noteHz } from "./helpers.mjs";

const custom = {
  0: () => [{ w: "sine", t: 1, f: 0 }],
  5: () => [{ w: "square", t: 2, f: 0 }],
  40: () => [{ w: "sawtooth", t: 0.5, f: 3 }],
};
const snare = () => [{ w: "triangle", t: 0, f: 200, d: 0.1 }];

function withCustomTimbres(variant, quality) {
  const s = synthFor(variant, { quality });
  for (const program of Object.keys(custom)) s.synth.setTimbre(0, Number(program), custom[program]());
  s.synth.setTimbre(1, 38, snare());
  return s;
}

/* Sound sources started by `act()`. */
function startedBy(s, act) {
  const from = s.trace.length;
  act(s.synth);
  return sources(s.trace, from);
}

describe.each(variants)("$name: program and channel selection", (variant) => {
  describe.each([0, 1])("quality %i", (quality) => {
    test("a program change applies to its own channel only", () => {
      const s = withCustomTimbres(variant, quality);
      s.synth.send([0xc0, 5]);  // channel 1: program 6 (number 5)
      s.synth.send([0xc1, 40]); // channel 2: program 41 (number 40); channel 3 keeps program 0
      const played = startedBy(s, (synth) => {
        synth.send([0x90, 60, 100], 1);
        synth.send([0x91, 64, 100], 1);
        synth.send([0x92, 67, 100], 1);
      });
      expect(played.map((src) => src.type)).toEqual(["square", "sawtooth", "sine"]);
      expect(played.map((src) => src.freq)).toEqual([noteHz(60) * 2, noteHz(64) * 0.5 + 3, noteHz(67)].map((f) => expect.closeTo(f, 9)));
    });

    test("channel 10 plays the drum map whatever its program", () => {
      const s = withCustomTimbres(variant, quality);
      s.synth.send([0xc9, 5]);
      const snareHit = startedBy(s, (synth) => synth.send([0x99, 38, 100], 1));
      expect(snareHit.map((src) => [src.type, src.freq])).toEqual([["triangle", 200]]);
      // The drum map covers notes 35-81 (README); other notes on channel 10 are silent.
      expect(startedBy(s, (synth) => synth.send([0x99, 34, 100], 1))).toEqual([]);
    });

    test("setQuality() reinstalls the built-in timbres", () => {
      const s = withCustomTimbres(variant, quality);
      s.synth.send([0xc0, 5]);
      s.synth.setQuality(quality);
      const played = startedBy(s, (synth) => synth.send([0x90, 60, 100], 1));
      expect(played.length).toBeGreaterThan(0);
      expect(played.some((src) => src.type === "square" && src.freq === noteHz(60) * 2)).toBe(false);
    });

    test("uses the documented number of oscillators per note", () => {
      const s = synthFor(variant, { quality });
      const perNote = [];
      for (let program = 0; program < 128; ++program) {
        s.synth.send([0xc0, program]);
        perNote.push(startedBy(s, (synth) => synth.send([0x90, 60, 100], 1 + program)).length);
        s.synth.send([0x80, 60, 0], 1.5 + program);
      }
      if (quality === 0) expect(new Set(perNote)).toEqual(new Set([1])); // "1 osc / note"
      else expect(perNote[0]).toBeGreaterThanOrEqual(2);                    // "FM based 2 (or more) osc / note"
    });
  });

  test("switching quality away and back restores the same sound", () => {
    const notes = (synth) => {
      for (const program of [0, 24, 56, 80]) {
        synth.send([0xc0, program]);
        synth.send([0x90, 60, 100], 1 + program);
        synth.send([0x99, 38, 100], 1 + program);
      }
    };
    const traces = [0, 1].map((quality) => {
      const fresh = synthFor(variant, { quality });
      const switched = synthFor(variant, { quality });
      switched.synth.setQuality(1 - quality);
      switched.synth.setQuality(quality);
      const a = startedBy(fresh, notes);
      const b = startedBy(switched, notes);
      expect(b).toEqual(a);
      return a;
    });
    expect(traces[1]).not.toEqual(traces[0]); // the two modes really differ
  });
});
