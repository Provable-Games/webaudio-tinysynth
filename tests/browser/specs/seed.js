/*
 * Seeded built-in buffers (#7, D-004, ledger L-07): T6's phase-B row for T8
 * (tasks/T6.md §13), replacing the variation spec's buffer observation and the
 * test pages' Math.random seeding as the evidence for #7.
 *
 * Every page here replaces Math.random, before the library loads, with a
 * function that counts its calls and throws. Asserted per build, quality mode
 * and sample rate:
 *   - buffers: synths built on an injected OfflineAudioContext at the case's
 *     rate, with the default seed and with every seed in seed-expected.js
 *     (plus useReverb: 0, which has no convBuf, #18), have convBuf, n0 and n1 whose SHA-256 (computed
 *     here from the page's Float32 data) equals the seeded expectations,
 *     which are computed by an independent reference in Node. Equal hashes in
 *     every engine are cross-engine identity of the data. `seed` and
 *     `bufferVersion` read back. The same holds in a second, fresh page
 *     (another load of the library). The hashes read back for different seeds
 *     differ pairwise in every buffer, whatever the table holds;
 *   - the realtime default path, new WebAudioTinySynth() with its internal
 *     AudioContext: the default-seed buffers for that context's rate, and the
 *     same data on both loads;
 *   - renders: noise drums (n0 and n1 timbres) and a note with reverb, at the
 *     default seed's value, render in two fresh pages within the engine's
 *     same-engine tolerance (tolerances.js; a difference that does not
 *     reproduce is re-rendered and reconciled, as in specs/render.js), and
 *     seed 1 changes the render by more than tolerances.seedEffect. All
 *     renders are finite and audible;
 *   - Math.random was never called, and nothing failed in the page.
 */
"use strict";
const pages = require("../lib/pages");
const A = require("../lib/analysis");
const { on, off } = require("../lib/scenarios");
const { tolerances } = require("../tolerances");
const { SEED_EXPECTED: E } = require("./seed-expected");

/* Runs first in the library's script element, so it is in place before any library code. */
const POISON = "window.__seedRandom = { calls: 0 };\n" +
  "Math.random = function () { ++window.__seedRandom.calls; throw new Error(\"Math.random called (#7: the library must not use it)\"); };\n";

function seedPage(build, options) {
  return pages.inlinePage({ library: POISON + pages.readLibrary(build, options.overrides), seed: options.seed, after: [pages.pageScript("render.js")] });
}

/* eslint-disable no-undef -- the callbacks below run in the page */
/* For each options object: a synth on an OfflineAudioContext at `sr`, its seed, version and buffer data (base64 Float32 per channel). */
const BUFFERS = async ({ sr, list }) => {
  const b64 = (f) => {
    const u8 = new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const data = (buf) => Array.from({ length: buf.numberOfChannels }, (_, c) => b64(buf.getChannelData(c)));
  const out = [];
  for (const o of list) {
    const synth = new WebAudioTinySynth(Object.assign({ context: new OfflineAudioContext(2, 128, sr) }, o));
    out.push({ seed: synth.seed, bufferVersion: synth.bufferVersion, sr: synth.getAudioContext().sampleRate,
      convBuf: synth.convBuf ? data(synth.convBuf) : null, n0: data(synth.noiseBuf.n0), n1: data(synth.noiseBuf.n1) });
    await synth.dispose();
  }
  return out;
};
/* The default constructor with its internal (realtime) AudioContext. */
const REALTIME = async () => {
  const b64 = (f) => {
    const u8 = new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const data = (buf) => Array.from({ length: buf.numberOfChannels }, (_, c) => b64(buf.getChannelData(c)));
  const synth = new WebAudioTinySynth();
  const ctx = synth.getAudioContext();
  const r = { seed: synth.seed, bufferVersion: synth.bufferVersion, sr: ctx.sampleRate, state: ctx.state,
    convBuf: data(synth.convBuf), n0: data(synth.noiseBuf.n0), n1: data(synth.noiseBuf.n1) };
  await synth.dispose();
  return r;
};
const PAGE_STATE = () => ({ randomCalls: window.__seedRandom.calls, rejections: window.__t6.rejections });
/* eslint-enable no-undef */

const decode = (b64) => {
  const b = Buffer.from(b64, "base64");
  const copy = new ArrayBuffer(b.length);
  new Uint8Array(copy).set(b);
  return new Float32Array(copy);
};
const hashes = (r) => ({ convBuf: r.convBuf && A.sha256(...r.convBuf.map(decode)), n0: A.sha256(...r.n0.map(decode)), n1: A.sha256(...r.n1.map(decode)) });

/* Largest absolute sample difference between two renders' channels (Infinity if their shapes differ). */
function maxDiff(a, b) {
  if (a.length !== b.length) return Infinity;
  let m = 0;
  for (let c = 0; c < a.length; ++c) {
    if (a[c].length !== b[c].length) return Infinity;
    for (let i = 0; i < a[c].length; ++i) {
      const d = Math.abs(a[c][i] - b[c][i]);
      if (d > m || d !== d) m = d !== d ? Infinity : d;
    }
  }
  return m;
}

/* Noise drums (quality 1: 38 uses n0, 42 and 49 use n1; quality 0's drums use n0) and a melodic note with reverb, at the default level. */
const STEPS = [on(9, 38, 0.1), on(9, 42, 0.45), on(9, 49, 0.8), on(0, 69, 1.2), off(0, 69, 1.5)];

function cases(shared) {
  const { matrix, options, engine } = shared;
  const tol = tolerances(engine);
  const out = [];
  for (const build of matrix.builds) {
    for (const quality of matrix.qualities) {
      for (const sr of matrix.sampleRates) {
        out.push({
          id: "seed " + build + " q" + quality + " " + sr,
          dims: { build, quality, sampleRate: sr },
          deadline: 240,
          run: async (t) => {
            const want = E.hashes[sr];
            if (!t.check("the seeded expectations cover " + sr + " Hz", !!want)) return;
            const list = [{}, ...Object.keys(want).map((s) => ({ seed: Number(s) })), { seed: 1, useReverb: 0 }];
            const label = (o) => "seed " + (o.seed === undefined ? "default (" + E.defaultSeed + ")" : o.seed) + (o.useReverb === 0 ? ", useReverb 0" : "");
            const loads = [];
            for (let load = 0; load < 2; ++load) {
              const p = await t.newPage({ offline: true });
              await p.page.setContent(seedPage(build, options));
              const got = await p.page.evaluate(BUFFERS, { sr, list });
              const bad = [], bySeed = new Map();
              got.forEach((r, i) => {
                const seed = list[i].seed === undefined ? E.defaultSeed : list[i].seed;
                const h = hashes(r);
                if (list[i].useReverb === undefined) bySeed.set(seed, h);
                if (r.seed !== seed || r.bufferVersion !== E.bufferVersion || r.sr !== sr) bad.push(label(list[i]) + ": seed/version/rate " + [r.seed, r.bufferVersion, r.sr].join("/"));
                // With useReverb 0 there is no convBuf (#18): null, and n0 and n1 are the seed's own.
                const exp = list[i].useReverb === 0 ? Object.assign({}, want[seed], { convBuf: null }) : want[seed];
                for (const k of ["convBuf", "n0", "n1"]) if (h[k] !== exp[k]) bad.push(label(list[i]) + " " + k + " " + String(h[k]).slice(0, 16));
              });
              t.check("load " + (load + 1) + ": convBuf, n0 and n1 equal the seeded expectations at " + sr + " Hz (default seed, " + Object.keys(want).length + " seeds; with useReverb 0 no convBuf and the same n0 and n1); seed and bufferVersion " + E.bufferVersion + " read back", !bad.length,
                bad.length ? bad.slice(0, 3).join(" | ") : "default " + want[E.defaultSeed].convBuf.slice(0, 12) + "/" + want[E.defaultSeed].n0.slice(0, 12) + "/" + want[E.defaultSeed].n1.slice(0, 12));

              // Read back from the engine, independently of the table's values (#7: different seeds differ).
              const same = ["convBuf", "n0", "n1"].filter((k) => new Set([...bySeed.values()].map((h) => h[k])).size !== bySeed.size);
              t.check("load " + (load + 1) + ": the " + bySeed.size + " seeds give pairwise different convBuf, n0 and n1 (hashes read back)", bySeed.size >= 2 && !same.length,
                same.length ? "repeated across seeds: " + same.join(", ") : [...bySeed.keys()].join(", "));

              const rt = await p.page.evaluate(REALTIME);
              const h = hashes(rt);
              loads.push({ p, rt: Object.assign({ sr: rt.sr, state: rt.state, seed: rt.seed }, h) });
            }
            const [a, b] = loads.map((l) => l.rt);
            const exp = E.hashes[a.sr] && E.hashes[a.sr][E.defaultSeed];
            t.check("new WebAudioTinySynth() (internal context, " + a.sr + " Hz): default seed, the same buffers on both loads" + (exp ? ", equal to the seeded expectations" : ""),
              a.seed === E.defaultSeed && b.sr === a.sr && ["convBuf", "n0", "n1"].every((k) => a[k] === b[k] && (!exp || a[k] === exp[k])),
              JSON.stringify({ sr: a.sr, state: a.state, seed: a.seed, convBuf: a.convBuf.slice(0, 12), n0: a.n0.slice(0, 12), n1: a.n1.slice(0, 12) }));
            if (!exp) t.note("the internal context runs at " + a.sr + " Hz, which the seeded expectations do not list; only load-to-load equality was checked");

            // Renders: two fresh pages (the loads above) at seed 0, the default's value, and seed 1.
            const spec = (p, seed) => p.page.evaluate((s) => window.__t6.render(s), { seed, sr, duration: 2, options: { quality, useReverb: 1 }, steps: STEPS, pcm: true }) // eslint-disable-line no-undef -- runs in the page
              .then((r) => Object.assign(r, { channels: r.pcm.map(decode) }));
            const finite = [];
            const audit = (r, what) => {
              if (r.whole.nan || r.whole.inf || !(r.whole.peak >= tol.audiblePeak)) finite.push(what + " " + JSON.stringify(r.whole));
              return r;
            };
            const first = audit(await spec(loads[0].p, E.defaultSeed), "load 1"), second = audit(await spec(loads[1].p, E.defaultSeed), "load 2");
            let d = maxDiff(first.channels, second.channels);
            const reconciled = [];
            if (d > tol.sameEngineSample) {
              // A difference that does not reproduce (WebKit, tolerances.js) is reconciled by re-rendering, at most twice per page.
              const As = [first], Bs = [second];
              for (let k = 0; k < 2 && d > tol.sameEngineSample; ++k) {
                As.push(audit(await spec(loads[0].p, E.defaultSeed), "load 1 re-render"));
                Bs.push(audit(await spec(loads[1].p, E.defaultSeed), "load 2 re-render"));
                d = Math.min(...As.flatMap((x) => Bs.map((y) => maxDiff(x.channels, y.channels))));
              }
              reconciled.push({ firstDiff: maxDiff(first.channels, second.channels), renders: As.length + Bs.length, reconciled: d <= tol.sameEngineSample });
              t.observe("re-rendered same-seed renders (see specs/render.js on non-reproducible differences)", reconciled);
            }
            t.check("same-seed renders (seed " + E.defaultSeed + ", noise drums and reverb) repeat across loads within " + tol.sameEngineSample, d <= tol.sameEngineSample,
              first.hash === second.hash ? "bit-identical" : "max |diff| " + d.toExponential(3));
            const other = audit(await spec(loads[1].p, 1), "seed 1");
            const e = maxDiff(other.channels, first.channels);
            t.check("seed 1 changes the render by more than " + tol.seedEffect, Number.isFinite(e) && e > tol.seedEffect, "max |diff| " + e.toExponential(3));
            t.check("every render is finite and audible", !finite.length, finite.slice(0, 2).join(" | "));
            t.observe("render hashes: seed " + E.defaultSeed + " load 1, load 2, seed 1", [first.hash, second.hash, other.hash]);
            t.observe("render peak and rms (seed " + E.defaultSeed + ")", { peak: +first.whole.peak.toFixed(5), rms: +first.whole.rms.toExponential(4) });

            for (const [i, l] of loads.entries()) {
              const s = await l.p.page.evaluate(PAGE_STATE);
              t.check("load " + (i + 1) + ": Math.random was never called", s.randomCalls === 0, s.randomCalls + " calls");
              t.check("load " + (i + 1) + ": no page errors and no unhandled rejections", !l.p.pageErrors.length && !s.rejections.length,
                l.p.pageErrors.slice(0, 2).concat(s.rejections.slice(0, 2).map((r) => r.name + ": " + r.message)).join(" | "));
            }
          },
        });
      }
    }
  }
  return out;
}

module.exports = { cases };
