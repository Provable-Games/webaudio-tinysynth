/*
 * Run-to-run variation (observe only): the evidence behind tolerances.js.
 * Source build, Math.random seed from the matrix unless stated.
 *
 *   launches   every render scenario rendered in three separate browser
 *              launches (q1/44100 and q0/48000); max |sample diff| against
 *              the first launch, per scenario.
 *   seeds      seeds 1..6: per-drum RMS (dB) of the GM drum sweep and the
 *              reverb tail energy; the spread across seeds is the
 *              noise-dependent part of rendered energy (#7).
 *   scheduler  the GM program batch rendered three times with the library's
 *              60 ms scheduler left running (spec.keepScheduler): the voice
 *              pruning it does during an offline render depends on wall-clock
 *              timing (baseline finding, #11/#12).
 *   buffers    hashes of the generated convBuf/n0/n1 data per seed and sample
 *              rate (deterministic data; compared across engines by the runner).
 */
"use strict";
const A = require("../lib/analysis");
const { SCENARIOS } = require("../lib/scenarios");
const { renderSpec, openRenderPage, render, maxDiff } = require("./render");

function cases(shared) {
  const { options } = shared;
  const seed = options.seed;
  return [
    {
      id: "variation launches",
      deadline: 600,
      run: async (t) => {
        const settings = [{ quality: 1, sr: 44100 }, { quality: 0, sr: 48000 }];
        const first = {};
        const out = {};
        for (let launch = 0; launch < 3; ++launch) {
          const browser = launch === 0 ? null : await t.launchBrowser();
          const p = await openRenderPage(t, "source", seed, browser);
          for (const st of settings) {
            for (const s of SCENARIOS) {
              const key = "q" + st.quality + "/" + st.sr + " " + s.name;
              const r = await render(p, renderSpec(s, { seed, sr: st.sr, quality: st.quality }));
              if (launch === 0) first[key] = r;
              else {
                const d = r.hash === first[key].hash ? 0 : maxDiff(r, first[key]);
                out[key] = Math.max(out[key] || 0, d);
              }
            }
          }
        }
        const differing = Object.fromEntries(Object.entries(out).filter(([, d]) => d > 0));
        t.observe("separate launches: scenarios bit-identical to launch 1", Object.keys(out).length - Object.keys(differing).length + " of " + Object.keys(out).length);
        t.observe("separate launches: max |sample diff| where not bit-identical", differing);
        t.observe("separate launches: overall max |sample diff|", Math.max(0, ...Object.values(out)));
      },
    },
    {
      id: "variation seeds",
      deadline: 600,
      run: async (t) => {
        const p = await openRenderPage(t, "source", seed);
        const drums = SCENARIOS.find((s) => s.name === "gm-drums");
        const reverb = SCENARIOS.find((s) => s.name === "reverb");
        const perSeed = [];
        for (let k = 1; k <= 6; ++k) {
          const d = await render(p, renderSpec(drums, { seed: k, sr: 44100, quality: 1 }));
          const r = await render(p, renderSpec(reverb, { seed: k, sr: 44100, quality: 1 }));
          const [l, rr] = r.channels;
          const tail = Math.hypot(A.rms(l, Math.round(0.9 * 44100), Math.round(1.25 * 44100)), A.rms(rr, Math.round(0.9 * 44100), Math.round(1.25 * 44100)));
          perSeed.push({ seed: k, drumsDb: d.slots.map((s) => A.db(s.rms)), reverbTailDb: A.db(tail), buffers: d.buffers });
        }
        const spread = perSeed[0].drumsDb.map((_, i) => {
          const v = perSeed.map((x) => x.drumsDb[i]);
          return +(Math.max(...v) - Math.min(...v)).toFixed(3);
        });
        const tails = perSeed.map((x) => x.reverbTailDb);
        t.observe("GM drum RMS spread across seeds 1..6 (dB, notes 35..81)", spread);
        t.observe("GM drum RMS spread across seeds: max (dB)", Math.max(...spread));
        t.observe("reverb tail across seeds 1..6 (dB)", tails.map((x) => +x.toFixed(3)));
        t.observe("reverb tail spread across seeds (dB)", +(Math.max(...tails) - Math.min(...tails)).toFixed(3));
        t.observe("distinct generated buffers across seeds 1..6", new Set(perSeed.map((x) => JSON.stringify(x.buffers))).size);
      },
    },
    {
      id: "variation scheduler",
      deadline: 300,
      run: async (t) => {
        const p = await openRenderPage(t, "source", seed);
        const s = SCENARIOS.find((x) => x.name === "gm-programs-0-31");
        const runs = { stopped: [], running: [] };
        for (const mode of ["stopped", "running"]) {
          for (let k = 0; k < 3; ++k) {
            const spec = renderSpec(s, { seed, sr: 44100, quality: 1 });
            if (mode === "running") spec.keepScheduler = true;
            runs[mode].push(await render(p, spec));
          }
        }
        for (const mode of Object.keys(runs)) {
          const d = runs[mode].slice(1).map((r) => (r.hash === runs[mode][0].hash ? 0 : maxDiff(r, runs[mode][0])));
          t.observe("GM programs 0-31, scheduler " + mode + ": max |sample diff| between 3 renders", Math.max(...d));
        }
        t.observe("scheduler running vs stopped: max |sample diff|", maxDiff(runs.running[0], runs.stopped[0]));
      },
    },
    {
      id: "variation buffers",
      run: async (t) => {
        const p = await openRenderPage(t, "source", seed);
        const s = SCENARIOS.find((x) => x.name === "idle-reverb1");
        const out = {};
        for (const k of [seed, 1, 2]) {
          for (const sr of [44100, 48000]) {
            const a = await render(p, renderSpec(s, { seed: k, sr, quality: 1 }));
            const b = await render(p, renderSpec(s, { seed: k, sr, quality: 1 }));
            out["seed " + k + " @" + sr] = Object.assign({ repeatIdentical: JSON.stringify(a.buffers) === JSON.stringify(b.buffers), randomCalls: a.randomCalls }, a.buffers);
          }
        }
        t.observe("generated buffer hashes", out);
      },
    },
  ];
}

module.exports = { cases };
