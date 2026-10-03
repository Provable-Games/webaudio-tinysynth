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
/* One part of a scenario: item k of an item scenario, or the whole scenario. */
function renderPart(p, s, ctx, variant, k) {
  if (!s.items) return render(p, renderSpec(s, ctx, variant));
  return render(p, renderSpec(Object.assign({}, s, { spec: s.items[k].spec }), ctx, variant));
}

async function renderParts(p, s, ctx, variant = {}) {
  const parts = [];
  for (let k = 0; k < (s.items ? s.items.length : 1); ++k) parts.push(await renderPart(p, s, ctx, variant, k));
  return parts;
}

/*
 * Combined result of a scenario's parts. A scenario with `items` (the GM
 * sweeps) renders each item alone, with a fresh synth and context; the
 * combined result has the items' channels concatenated, per-item slot
 * summaries in `slots` (peak and RMS over item.slot, measured here), and the
 * items' rejections and NaN/Infinity counts added up.
 */
function combine(s, parts) {
  if (!s.items) return parts[0];
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

async function renderScenario(p, s, ctx, variant = {}) {
  return combine(s, await renderParts(p, s, ctx, variant));
}

/* Index of the first differing sample between two renders, or -1. */
function firstDifference(a, b) {
  let first = -1;
  for (let c = 0; c < Math.min(a.channels.length, b.channels.length); ++c)
    for (let i = 0; i < Math.min(a.channels[c].length, b.channels[c].length); ++i)
      if (a.channels[c][i] !== b.channels[c][i]) { if (first < 0 || i < first) first = i; break; }
  return first;
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

const MAX_RECONCILE = 3;

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
          // Every render, including re-renders and the repeat and alternate-seed
          // renders, is checked for NaN/Infinity, realtime contexts and rejections.
          const audit = (r, label) => {
            renders += r.renders || 1;
            const c = classifyRejections(r.rejections);
            for (const [k, n] of Object.entries(c.counts)) rejectionCounts[k] = (rejectionCounts[k] || 0) + n;
            unknownRejections.push(...c.unknown.map((u) => label + ": " + u.name + ": " + u.message));
            if (r.whole.nan || r.whole.inf) finiteProblems.push(label + " " + JSON.stringify(r.whole));
            if (r.internalContext !== "offline") realtimeInternal.push(label + " " + r.internalContext);
            return r;
          };
          /*
           * Same-engine reconciliation. WebKit occasionally renders a segment
           * that differs from an otherwise identical render (up to 0.56 on
           * arm64 CI, 0.19 locally; reproduced under main-thread GC pressure,
           * about 1 in 50 renders; cause not isolated). A real difference
           * reproduces on every render, a glitch does not. When two renders
           * that must agree differ beyond the tolerance, the part is
           * re-rendered (at most twice per side): it is reconciled only if a
           * render of one side agrees with a render of the other within the
           * tolerance, and that pair is used from then on. At most
           * MAX_RECONCILE parts per case may be reconciled; every
           * reconciliation is recorded.
           */
          const reconciled = [];
          const reconcile = async (label, k, a, b, rerenderA, rerenderB, sides) => {
            const As = [a], Bs = [b];
            const first = firstDifference(a, b), d0 = maxDiff(a, b);
            if (reconciled.length >= MAX_RECONCILE) return { ok: false, why: "more than " + MAX_RECONCILE + " reconciliations in this case" };
            for (let tries = 0; tries < 2; ++tries) {
              if (rerenderA) As.push(audit(await rerenderA(), label + " re-render"));
              if (rerenderB) Bs.push(audit(await rerenderB(), label + " re-render"));
              for (const x of As) for (const y of Bs) {
                if (maxDiff(x, y) <= tol.sameEngineSample) {
                  reconciled.push({ part: label, maxDiff: d0, firstDifferingSample: first, renders: As.length + Bs.length, differingRender: x === a ? sides[1] : y === b ? sides[0] : "both" });
                  return { ok: true, x, y };
                }
              }
            }
            const stable = (list) => list.some((x, i) => list.some((y, j) => j > i && maxDiff(x, y) <= tol.sameEngineSample));
            return { ok: false, why: "max |diff| " + d0.toExponential(3) + " at sample " + first + ", reproduced in " + (As.length + Bs.length) + " renders" + (stable(As) && stable(Bs) ? "" : " (engine output unstable)") };
          };

          for (const s of SCENARIOS) {
            const variants = s.variants || [];
            const parts = {};
            for (const build of matrix.builds) {
              parts[build] = [];
              for (const v of [{}, ...variants]) {
                const ps = await renderParts(pg[build], s, { seed, sr, quality }, v);
                ps.forEach((r, k) => audit(r, s.name + "/" + build + (s.items ? " " + s.items[k].label : "")));
                parts[build].push(ps);
              }
            }
            const persistent = [];
            const allVariants = [{}, ...variants];
            for (let vi = 0; vi < allVariants.length; ++vi) {
              for (let k = 0; k < parts.source[vi].length; ++k) {
                const a = parts.source[vi][k], b = parts.min[vi][k];
                if (maxDiff(a, b) <= tol.sameEngineSample) continue;
                const label = s.name + (s.items ? " " + s.items[k].label : "") + (vi ? " variant " + vi : "") + " source/min";
                const r = await reconcile(label, k, a, b,
                  () => renderPart(pg.source, s, { seed, sr, quality }, allVariants[vi], k),
                  () => renderPart(pg.min, s, { seed, sr, quality }, allVariants[vi], k), ["source", "min"]);
                if (r.ok) { parts.source[vi][k] = r.x; parts.min[vi][k] = r.y; } else persistent.push(label + ": " + r.why);
              }
            }
            const res = { source: parts.source.map((ps) => combine(s, ps)), min: parts.min.map((ps) => combine(s, ps)) };
            for (const build of matrix.builds) for (const r of res[build]) if (r.whole.peak > 1) overFullScale.push(s.name + "/" + build + " " + r.whole.peak.toFixed(4));
            const identical = res.source.every((r, i) => r.hash === res.min[i].hash);
            const diff = Math.max(...res.source.map((r, i) => maxDiff(r, res.min[i])));
            if (identical) sameEngine.bitIdentical.push(s.name + " source/min");
            else sameEngine.differing[s.name + " source/min"] = diff;
            const parity = !persistent.length;
            t.check(s.name + ": min renders the same PCM as source (max |diff| <= " + tol.sameEngineSample + ")", parity,
              parity ? (identical ? "bit-identical" : "max |diff| " + diff.toExponential(3)) : persistent.slice(0, 2).join(" | "));
            for (const build of parity ? ["source"] : matrix.builds) {
              const prefix = s.name + (parity ? "" : " [" + build + "]") + ": ";
              const check = (name, ok, detail) => t.check(prefix + name, ok, detail);
              const chans = res[build].map((r) => r.channels);
              const m = s.analyzeItems ? s.analyzeItems(parts[build][0].map((r) => r.channels), sr)
                : s.items ? { slots: res[build][0].slots } : s.analyze(chans[0], sr, ...chans.slice(1));
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
            if (["pitch-sine", "gm-drums", "reverb"].includes(s.name)) kept[s.name] = { parts: parts.source[0], combined: res.source[0] };
          }

          // Repeatability in a fresh page (same engine, seed and rate) and seed sensitivity.
          const again = await openRenderPage(t, "source", seed);
          for (const name of Object.keys(kept)) {
            const s = SCENARIOS.find((x) => x.name === name);
            const ps = await renderParts(again, s, { seed, sr, quality });
            ps.forEach((r, k) => audit(r, name + "/repeat" + (s.items ? " " + s.items[k].label : "")));
            const persistent = [];
            for (let k = 0; k < ps.length; ++k) {
              if (maxDiff(ps[k], kept[name].parts[k]) <= tol.sameEngineSample) continue;
              const label = name + (s.items ? " " + s.items[k].label : "") + " repeat";
              const r = await reconcile(label, k, ps[k], kept[name].parts[k], () => renderPart(again, s, { seed, sr, quality }, {}, k), null, ["repeat", "first render"]);
              if (r.ok) ps[k] = r.x; else persistent.push(label + ": " + r.why);
            }
            const r = combine(s, ps);
            const d = maxDiff(r, kept[name].combined);
            if (r.hash === kept[name].combined.hash) sameEngine.bitIdentical.push(name + " repeat");
            else sameEngine.differing[name + " repeat"] = d;
            t.check(name + ": a repeat render in a fresh page matches (max |diff| <= " + tol.sameEngineSample + ")", !persistent.length && d <= tol.sameEngineSample,
              persistent.length ? persistent.slice(0, 2).join(" | ") : r.hash === kept[name].combined.hash ? "bit-identical" : "max |diff| " + d.toExponential(3));
          }
          for (const name of ["gm-drums", "reverb"]) {
            const s = SCENARIOS.find((x) => x.name === name);
            const r = audit(await renderScenario(again, s, { seed: (seed + 1) >>> 0, sr, quality }), name + "/seed+1");
            const d = maxDiff(r, kept[name].combined);
            t.check(name + ": seed " + ((seed + 1) >>> 0) + " changes the noise-based output (the seeding is effective)", Number.isFinite(d) && d >= tol.seedEffect, "max |diff| " + d.toExponential(3));
          }
          t.check("all " + renders + " renders finite (no NaN or Infinity), including repeat and alternate-seed renders", !finiteProblems.length, finiteProblems.slice(0, 3).join(" | "));
          t.check("no realtime context ran during the renders (constructor context was the offline stub)", !realtimeInternal.length, realtimeInternal.slice(0, 3).join(" | "));
          t.observe("renders with samples beyond full scale (not asserted)", { renders: overFullScale, slots: gmOver });
          t.check("no unrecognized unhandled rejections", !unknownRejections.length, unknownRejections.slice(0, 3).join(" | "));
          t.observe("known baseline unhandled rejections (#12, removed by T4)", rejectionCounts);
          t.observe("same-engine comparisons (bit-identical, or max |diff|)", sameEngine);
          t.observe("reconciled same-engine differences (re-rendered; see the reconcile comment)", reconciled);
          t.observe("measurements", measurements);
          t.observe("render hashes (source build)", hashes);
          t.observe("generated buffer hashes (convBuf, n0, n1)", buffers[SCENARIOS[0].name]);
        },
      });
    }
  }
  return out;
}

module.exports = { cases, renderSpec, renderScenario, renderParts, combine, openRenderPage, render, decode, maxDiff };
