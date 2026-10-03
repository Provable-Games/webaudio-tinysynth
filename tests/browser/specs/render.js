/*
 * Rendered audio (#16) with OfflineAudioContext, per quality mode and sample
 * rate. Every scenario in lib/scenarios.js is rendered with the source and the
 * minified build in offline pages (all requests aborted), measured in Node
 * (lib/analysis.js) and checked against independent expectations within the
 * engine's tolerances (tolerances.js).
 *
 * Also asserted: every render is finite; the minified build renders the same
 * PCM as the source build, and a repeat render in a fresh page matches, both
 * within the engine's same-engine sample tolerance (bit-identical where the
 * engine is deterministic); a different Math.random seed changes the
 * noise-based output (the seeding is effective). Unhandled
 * promise rejections are classified (lib/known.js): known baseline ones (#12)
 * are counted and reported, any other fails.
 */
"use strict";
const pages = require("../lib/pages");
const A = require("../lib/analysis");
const { SCENARIOS } = require("../lib/scenarios");
const { classifyRejections } = require("../lib/known");
const { tolerances } = require("../tolerances");

const decode = (b64) => {
  const b = Buffer.from(b64, "base64");
  const copy = new ArrayBuffer(b.length);
  new Uint8Array(copy).set(b);
  return new Float32Array(copy);
};

function renderSpec(s, { seed, sr, quality }, variant = {}) {
  const spec = Object.assign({}, s.spec, variant, { seed, sr });
  spec.options = Object.assign({ quality, useReverb: 0 }, s.options || {}, variant.options || {});
  return spec;
}

async function openRenderPage(t, build, seed, browser = null) {
  const p = await t.newPage({ offline: true, browser });
  await p.page.setContent(pages.inlinePage({ library: pages.readLibrary(build, t.shared.options.overrides), seed, after: [pages.pageScript("render.js")] }));
  return p;
}

async function render(p, spec) {
  const r = await p.page.evaluate((s) => window.__t6.render(s), spec); // eslint-disable-line no-undef -- runs in the page
  r.channels = r.pcm ? r.pcm.map(decode) : null;
  delete r.pcm;
  return r;
}

/*
 * Renders a scenario. A scenario with `items` (the GM sweeps) renders each
 * item alone, with a fresh synth and context, and returns one combined
 * result: the items' channels concatenated, per-item slot summaries in
 * `slots` (peak and RMS over item.slot, measured here), and the items'
 * rejections and NaN/Infinity counts added up.
 */
async function renderScenario(p, s, ctx, variant = {}) {
  if (!s.items) return render(p, renderSpec(s, ctx, variant));
  const parts = [];
  for (const item of s.items) parts.push(await render(p, renderSpec(Object.assign({}, s, { spec: item.spec }), ctx, variant)));
  const nch = parts[0].channels.length;
  const channels = [];
  for (let c = 0; c < nch; ++c) {
    const total = parts.reduce((a, r) => a + r.channels[c].length, 0);
    const out = new Float32Array(total);
    let at = 0;
    for (const r of parts) { out.set(r.channels[c], at); at += r.channels[c].length; }
    channels.push(out);
  }
  const sr = parts[0].sr;
  return {
    sr, channels, buffers: parts[0].buffers, randomCalls: parts[0].randomCalls,
    internalContext: [...new Set(parts.map((r) => r.internalContext))].join(","),
    hash: parts.map((r) => r.hash).join("+"),
    rejections: parts.flatMap((r) => r.rejections),
    whole: { nan: parts.reduce((a, r) => a + r.whole.nan, 0), inf: parts.reduce((a, r) => a + r.whole.inf, 0), peak: Math.max(...parts.map((r) => r.whole.peak)) },
    slots: parts.map((r, i) => {
      const [t0, t1] = s.items[i].slot;
      const a = Math.round(t0 * sr), b = Math.min(r.channels[0].length, Math.round(t1 * sr));
      return { label: s.items[i].label, peak: Math.max(...r.channels.map((x) => A.peak(x, a, b))), rms: Math.hypot(...r.channels.map((x) => A.rms(x, a, b))) / Math.sqrt(r.channels.length) };
    }),
    renders: parts.length,
    items: parts.map((r, i) => ({ label: s.items[i].label, length: r.channels[0].length })),
  };
}

/* For a combined item result: the item with the largest difference and where it starts. */
function worstItem(a, b) {
  if (!a.items || !b.items || !a.channels || !b.channels) return "";
  let at = 0, worst = null;
  a.items.forEach((it) => {
    let m = 0, first = -1;
    for (let c = 0; c < a.channels.length; ++c) {
      for (let i = at; i < at + it.length; ++i) {
        const d = Math.abs(a.channels[c][i] - b.channels[c][i]);
        if (d > 0 && (first < 0 || i - at < first)) first = i - at;
        if (d > m) m = d;
      }
    }
    if (m > 0 && (!worst || m > worst.m)) worst = { label: it.label, m, first };
    at += it.length;
  });
  return worst ? "; worst " + worst.label + " (" + worst.m.toExponential(3) + ", first difference at sample " + worst.first + ")" : "";
}

/* Largest absolute sample difference between two renders (Infinity if their shapes differ). */
function maxDiff(a, b) {
  if (!a.channels || !b.channels || a.channels.length !== b.channels.length) return Infinity;
  let m = 0;
  for (let c = 0; c < a.channels.length; ++c) {
    const x = a.channels[c], y = b.channels[c];
    if (x.length !== y.length) return Infinity;
    for (let i = 0; i < x.length; ++i) {
      const d = Math.abs(x[i] - y[i]);
      if (d > m || d !== d) m = d !== d ? Infinity : d;
    }
  }
  return m;
}

function cases(shared) {
  const { matrix, options, engine } = shared;
  const tol = tolerances(engine);
  const out = [];
  for (const quality of matrix.qualities) {
    for (const sr of matrix.sampleRates) {
      const dims = { quality, sampleRate: sr };
      const tag = "q" + quality + " " + sr;
      out.push({
        id: "render " + tag,
        dims,
        deadline: 600,
        run: async (t) => {
          const seed = options.seed;
          const pg = { source: await openRenderPage(t, "source", seed), min: await openRenderPage(t, "min", seed) };
          const rejectionCounts = {};
          let renders = 0;
          const finiteProblems = [];
          const overFullScale = [];
          const realtimeInternal = [];
          const gmOver = {};
          const unknownRejections = [];
          const measurements = {};
          const hashes = {};
          const buffers = {};
          const sameEngine = { bitIdentical: [], differing: {} };
          const kept = {};
          for (const s of SCENARIOS) {
            const variants = s.variants || [];
            const res = {};
            for (const build of matrix.builds) {
              res[build] = [];
              for (const v of [{}, ...variants]) {
                const r = await renderScenario(pg[build], s, { seed, sr, quality }, v);
                renders += r.renders || 1;
                const c = classifyRejections(r.rejections);
                for (const [k, n] of Object.entries(c.counts)) rejectionCounts[k] = (rejectionCounts[k] || 0) + n;
                unknownRejections.push(...c.unknown.map((u) => s.name + "/" + build + ": " + u.name + ": " + u.message));
                if (r.whole.nan || r.whole.inf) finiteProblems.push(s.name + "/" + build + " " + JSON.stringify(r.whole));
                if (r.whole.peak > 1) overFullScale.push(s.name + "/" + build + " " + r.whole.peak.toFixed(4));
                if (r.internalContext !== "offline") realtimeInternal.push(s.name + "/" + build + " " + r.internalContext);
                res[build].push(r);
              }
            }
            const identical = res.source.every((r, i) => r.hash === res.min[i].hash);
            const diff = Math.max(...res.source.map((r, i) => maxDiff(r, res.min[i])));
            if (identical) sameEngine.bitIdentical.push(s.name + " source/min");
            else sameEngine.differing[s.name + " source/min"] = diff;
            const parity = diff <= tol.sameEngineSample;
            t.check(s.name + ": min renders the same PCM as source (max |diff| <= " + tol.sameEngineSample + ")", parity,
              identical ? "bit-identical" : "max |diff| " + diff.toExponential(3) + (parity ? "" : worstItem(res.source[0], res.min[0])));
            for (const build of parity ? ["source"] : matrix.builds) {
              const prefix = s.name + (parity ? "" : " [" + build + "]") + ": ";
              const check = (name, ok, detail) => t.check(prefix + name, ok, detail);
              const chans = res[build].map((r) => r.channels);
              const m = s.items ? { slots: res[build][0].slots } : s.analyze(chans[0], sr, ...chans.slice(1));
              if (build === "source" && t.out) {
                const pcm = chans[0].length === 1 ? [chans[0][0], chans[0][0]] : chans[0];
                t.save("renders/" + tag.replace(" ", "-") + "/" + s.name + ".wav", A.wav(pcm, sr));
              }
              const extra = s.verify(m, tol, check);
              if (s.gm && extra && extra.overFullScale.length) gmOver[s.name] = extra.overFullScale;
              measurements[s.name + (parity ? "" : "/" + build)] = s.gm ? { peaks: m.slots.map((x) => +x.peak.toFixed(5)), rms: m.slots.map((x) => +x.rms.toExponential(4)) } : m;
            }
            hashes[s.name] = res.source.map((r) => r.hash);
            buffers[s.name] = res.source[0].buffers;
            if (["pitch-sine", "gm-drums", "reverb"].includes(s.name)) kept[s.name] = res.source[0];
          }
          // Every render, including the repeat and alternate-seed renders below,
          // is checked for NaN/Infinity, realtime contexts and rejections.
          const audit = (r, label) => {
            renders += r.renders || 1;
            const c = classifyRejections(r.rejections);
            for (const [k, n] of Object.entries(c.counts)) rejectionCounts[k] = (rejectionCounts[k] || 0) + n;
            unknownRejections.push(...c.unknown.map((u) => label + ": " + u.name + ": " + u.message));
            if (r.whole.nan || r.whole.inf) finiteProblems.push(label + " " + JSON.stringify(r.whole));
            if (r.internalContext !== "offline") realtimeInternal.push(label + " " + r.internalContext);
            return r;
          };

          // Repeatability in a fresh page (same engine, seed and rate) and seed sensitivity.
          const again = await openRenderPage(t, "source", seed);
          for (const name of Object.keys(kept)) {
            const s = SCENARIOS.find((x) => x.name === name);
            const r = audit(await renderScenario(again, s, { seed, sr, quality }), name + "/repeat");
            const d = maxDiff(r, kept[name]);
            if (r.hash === kept[name].hash) sameEngine.bitIdentical.push(name + " repeat");
            else sameEngine.differing[name + " repeat"] = d;
            t.check(name + ": a repeat render in a fresh page matches (max |diff| <= " + tol.sameEngineSample + ")", d <= tol.sameEngineSample,
              r.hash === kept[name].hash ? "bit-identical" : "max |diff| " + d.toExponential(3) + (d <= tol.sameEngineSample ? "" : worstItem(kept[name], r)));
          }
          for (const name of ["gm-drums", "reverb"]) {
            const s = SCENARIOS.find((x) => x.name === name);
            const r = audit(await renderScenario(again, s, { seed: (seed + 1) >>> 0, sr, quality }), name + "/seed+1");
            const d = maxDiff(r, kept[name]);
            t.check(name + ": seed " + ((seed + 1) >>> 0) + " changes the noise-based output (the seeding is effective)", Number.isFinite(d) && d >= tol.seedEffect, "max |diff| " + d.toExponential(3));
          }
          t.check("all " + renders + " renders finite (no NaN or Infinity), including repeat and alternate-seed renders", !finiteProblems.length, finiteProblems.slice(0, 3).join(" | "));
          t.check("no realtime context ran during the renders (constructor context was the offline stub)", !realtimeInternal.length, realtimeInternal.slice(0, 3).join(" | "));
          t.observe("renders with samples beyond full scale (not asserted)", { renders: overFullScale, slots: gmOver });
          t.check("no unrecognized unhandled rejections", !unknownRejections.length, unknownRejections.slice(0, 3).join(" | "));
          t.observe("known baseline unhandled rejections (#12, removed by T4)", rejectionCounts);
          t.observe("same-engine comparisons (bit-identical, or max |diff|)", sameEngine);
          t.observe("measurements", measurements);
          t.observe("render hashes (source build)", hashes);
          t.observe("generated buffer hashes (convBuf, n0, n1)", buffers[SCENARIOS[0].name]);
        },
      });
    }
  }
  return out;
}

module.exports = { cases, renderSpec, renderScenario, openRenderPage, render, decode, maxDiff };
