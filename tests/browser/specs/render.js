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
 * engine is deterministic). The first attempt decides (#78, lib/first-attempt.js):
 * a source/min or repeat difference beyond the tolerance, a non-finite sample, or a
 * missing or quiet note in a first render fails the run even if a re-render is clean.
 * Re-renders are diagnostics, counted and recorded apart from the verdict. A different Math.random seed changes the
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
const FA = require("../lib/first-attempt");

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

const { maxDiff } = FA;

/* Diagnostic re-renders a case may spend (the verdict never depends on them), first-attempt.js. */
const MAX_DIAGNOSED = 6;

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
          // Every first-attempt render, and the repeat and alternate-seed renders, is checked for
          // NaN/Infinity, realtime contexts and rejections and decides the verdict. A diagnostic
          // re-render (of a part that failed its first attempt) is audited the same way but counted
          // and listed apart.
          let diagRenders = 0;
          const diagFinite = [];
          const audit = (r, label, diagnostic = false) => {
            if (diagnostic) {
              ++diagRenders;
              if (r.whole.nan || r.whole.inf) diagFinite.push(label + " " + JSON.stringify(r.whole));
            } else {
              renders += r.renders || 1;
              if (r.whole.nan || r.whole.inf) finiteProblems.push(label + " " + JSON.stringify(r.whole));
            }
            const c = classifyRejections(r.rejections);
            for (const [k, n] of Object.entries(c.counts)) rejectionCounts[k] = (rejectionCounts[k] || 0) + n;
            unknownRejections.push(...c.unknown.map((u) => label + ": " + u.name + ": " + u.message));
            if (r.internalContext !== "offline") realtimeInternal.push(label + " " + r.internalContext);
            return r;
          };
          /*
           * Same-engine comparisons (#78). WebKit occasionally renders a segment that differs from
           * an otherwise identical render (up to 0.56 on arm64 CI; tasks/T13.1.md measures it).
           * That is a lost or broken note, so the FIRST attempt decides: two renders that must agree
           * and differ beyond the tolerance fail the check, and a clean re-render does not clear it
           * (lib/first-attempt.js). The tolerance is the measured summation-order one and is not
           * widened. Parts that fail get at most two diagnostic re-renders (at most MAX_DIAGNOSED
           * parts per case); each attempt is counted and recorded in the observation, apart from
           * the verdict, with which side moved.
           */
          const budget = FA.makeBudget(MAX_DIAGNOSED);
          const diag = FA.createLog(budget);
          // A part pair that must agree, rerendered by rerenderA/rerenderB (null: that side keeps its render).
          const judgePair = async (label, a, b, rerenderA, rerenderB) => {
            const res = await FA.comparePair({ a, b, rerenderA, rerenderB, tolerance: tol.sameEngineSample, budget, onDiagnostic: (r) => audit(r, label + " diagnostic re-render", true) });
            diag.add(label, res);
            return res;
          };
          const injectRender = FA.faultInjector("render"), injectRepeat = FA.faultInjector("repeat");

          for (const s of SCENARIOS) {
            const variants = s.variants || [];
            const parts = {};
            for (const build of matrix.builds) {
              parts[build] = [];
              for (const v of [{}, ...variants]) {
                const ps = await renderParts(pg[build], s, { seed, sr, quality }, v);
                // Fault injection (lib/first-attempt.js): the first part of the min build's first render.
                const fault = build === "min" && !parts.min.length ? injectRender.take() : null;
                if (fault) ps[0] = FA.corruptRender(fault, ps[0]);
                ps.forEach((r, k) => audit(r, s.name + "/" + build + (s.items ? " " + s.items[k].label : "")));
                parts[build].push(ps);
              }
            }
            const persistent = [];
            const allVariants = [{}, ...variants];
            for (let vi = 0; vi < allVariants.length; ++vi) {
              for (let k = 0; k < parts.source[vi].length; ++k) {
                const a = parts.source[vi][k], b = parts.min[vi][k];
                const label = s.name + (s.items ? " " + s.items[k].label : "") + (vi ? " variant " + vi : "") + " source/min";
                const r = await judgePair(label, a, b,
                  () => renderPart(pg.source, s, { seed, sr, quality }, allVariants[vi], k),
                  () => renderPart(pg.min, s, { seed, sr, quality }, allVariants[vi], k));
                if (!r.ok) persistent.push(label + ": " + r.reasons[0] + " (first attempt; " + FA.SHORT[r.outcome] + ")");
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
            const fault = injectRepeat.take();
            if (fault) ps[0] = FA.corruptRender(fault, ps[0]);
            ps.forEach((r, k) => audit(r, name + "/repeat" + (s.items ? " " + s.items[k].label : "")));
            const persistent = [];
            for (let k = 0; k < ps.length; ++k) {
              const label = name + (s.items ? " " + s.items[k].label : "") + " repeat";
              // Both sides are re-rendered as diagnostics: the kept first render may be the odd one.
              const r = await judgePair(label, ps[k], kept[name].parts[k], () => renderPart(again, s, { seed, sr, quality }, {}, k), () => renderPart(pg.source, s, { seed, sr, quality }, {}, k));
              if (!r.ok) persistent.push(label + ": " + r.reasons[0] + " (first attempt; " + FA.SHORT[r.outcome] + ")");
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
          t.check("all " + diagRenders + " diagnostic re-renders finite", !diagFinite.length, diagFinite.slice(0, 3).join(" | "));
          t.check("no realtime context ran during the renders (constructor context was the offline stub)", !realtimeInternal.length, realtimeInternal.slice(0, 3).join(" | "));
          t.observe("renders with samples beyond full scale (not asserted)", { renders: overFullScale, slots: gmOver });
          t.check("no unrecognized unhandled rejections", !unknownRejections.length, unknownRejections.slice(0, 3).join(" | "));
          t.observe("known baseline unhandled rejections (#12, removed by T4)", rejectionCounts);
          t.observe("same-engine comparisons (bit-identical, or max |diff|)", sameEngine);
          t.observe("first-attempt same-engine failures and their diagnostic re-renders (the verdict is the first attempt's; a clean re-render does not clear it)", Object.assign({ firstAttemptRenders: renders, diagnosticRenders: diagRenders }, diag.summary()));
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
