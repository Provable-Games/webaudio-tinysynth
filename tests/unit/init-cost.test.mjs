/*
 * Initialization cost (#18, ledger L-16) on the mock WebAudio of tests/harness.js, for both
 * builds. The measurements are in tasks/T8.md; these tests pin what the changes promise:
 *
 *   - with useReverb 0 the install makes no reverb impulse (convBuf is null, no 2-channel
 *     buffer, no convolver), and n0 and n1 are unchanged, because every buffer has its own
 *     stream (#7); a later install with reverb on makes the seeded impulse;
 *   - n1, the metallic noise (64 passes of sine products), is generated when it is first
 *     read, by the first note that plays it or by code reading noiseBuf.n1, and holds the
 *     seeded data whenever that happens; until then no generation work is done, and a
 *     disposed or replaced synth never does it;
 *   - the constructor installs the built-in timbres once.
 *
 * Generation work is counted with Math.sin (n1 makes 2 * 64 * length calls and nothing else
 * in the library calls it) and Array.from with a mapping function (one per setTimbre). The
 * structural tests run at 8 kHz, where a buffer is 4000 frames; the seeded hashes at 44.1 kHz
 * come from tests/browser/specs/seed-expected.js, computed by the independent reference.
 */
import vm from "node:vm";
import v8 from "node:v8";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { H, variants } from "./helpers.mjs";
import { reference, sha } from "./seed-reference.mjs";

const require = createRequire(import.meta.url);
const { SEED_EXPECTED: E } = require("../browser/specs/seed-expected.js");

const SLOW = 60000;
const SR = 8000;
const SIN_N1 = (sr) => 2 * 64 * Math.floor(sr / 2);

/* A fresh mock environment with `variant` loaded, counting Math.sin and Array.from-with-a-function calls. */
function load(variant) {
  const trace = [];
  const env = H.createEnvironment(trace);
  const count = { sin: 0, map: 0 };
  env.sandbox.__count = count;
  vm.runInContext(
    "(function () { const sin = Math.sin, from = Array.from;" +
    " Math.sin = function (x) { ++__count.sin; return sin(x); };" +
    " Array.from = function (a, f) { if (typeof f === \"function\") ++__count.map; return from.apply(this, arguments); }; })();",
    env.sandbox);
  vm.runInContext(variant.source, env.sandbox, { filename: variant.name });
  const Ctx = env.sandbox.AudioContext;
  return { env, trace, count, at: (sr = SR) => Object.assign(new Ctx(), { sampleRate: sr }), Synth: env.sandbox.WebAudioTinySynth };
}

const channels = (buf) => Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
const hashOf = (buf) => sha(channels(buf));
const want = (k, seed, sr) => sha(reference[k](seed, sr));
const ops = (trace, name) => trace.map((l) => JSON.parse(l)).filter((l) => l[0] === name);
const buffers = (trace, ch) => ops(trace, "createBuffer").filter((l) => l[2] === ch);
const hasGetter = (synth) => typeof Object.getOwnPropertyDescriptor(synth.noiseBuf, "n1").get === "function";

for (const variant of variants) {
  describe(variant.name, () => {
    describe("the constructor installs the built-in timbres once", () => {
      test("the number of timbre installs equals one setQuality() call, with and without a quality option", () => {
        const l = load(variant);
        const installs = (fn) => {
          const before = l.count.map;
          const r = fn();
          return [l.count.map - before, r];
        };
        for (const q of [undefined, 0, 1, null, "0"]) {
          const [c, synth] = installs(() => new l.Synth({ lazy: true, quality: q }));
          const [s] = installs(() => synth.setQuality(synth.quality));
          expect(c, "quality " + String(q)).toBe(s);
          expect(c).toBeGreaterThan(100);
        }
        const [c0] = installs(() => new l.Synth({ lazy: true, quality: 0 }));
        const [c1] = installs(() => new l.Synth({ lazy: true }));
        expect(c1).toBeGreaterThan(c0); // quality 1 installs the quality-1 tables as well, once each
      });

      test("the constructor options still take effect in order: reverb, quality, voices", () => {
        const l = load(variant);
        const y = new l.Synth({ lazy: true, useReverb: 0, quality: 0, voices: 5 });
        expect([y.useReverb, y.quality, y.voices]).toEqual([0, 0, 5]);
        const z = new l.Synth({ lazy: true, quality: null });
        expect(z.quality).toBe(1);
        const q0 = new l.Synth({ lazy: true, quality: 0 });
        expect(q0.program[0].p.length).toBe(1); // a quality-0 program is one operator
        expect(q0.program[119].p.length).toBe(z.program0[119].length);
        const e = (() => { try { new l.Synth({ quality: 2 }); } catch (x) { return x; } return null; })();
        expect(e && e.name).toBe("RangeError");
        expect(l.trace).toEqual([]); // a rejected option creates no context or node
      });
    });
  });
}
