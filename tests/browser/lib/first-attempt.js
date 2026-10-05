/*
 * First-attempt verdicts for rendered audio (#78, tasks/T13.1.md).
 *
 * The policy: the FIRST render of an item decides the verdict. A note that is
 * missing or too quiet, a large finite transient, a non-finite sample, or a
 * mismatch between two renders that must agree (source and min, a repeat)
 * fails the run, whatever a later render does. A later clean render does not
 * disprove an intermittent defect: a player that sometimes loses a note loses
 * it when it is not being re-rendered, too. Re-renders are kept as
 * DIAGNOSTICS: they are counted, recorded next to the first result, and never
 * change a verdict. They tell a reader whether the failure was intermittent
 * (a retry was clean) or reproduced.
 *
 * What this does not do: the measured floating-point summation tolerance
 * (tolerances.js, sameEngineSample: Chromium sums three or more inputs of a
 * node in a run-dependent order) still applies to the first attempt, as a
 * difference of that size is what the engine does by construction. It is a
 * tolerance of the comparison, never an allowance for a glitch: a first
 * attempt beyond it fails.
 *
 * Everything here is pure (no browser): the specs call it, and
 * tests/node/first-attempt.test.cjs checks it.
 */
"use strict";

/* Largest |a - b| over equal-length channel sets; Infinity if the shapes differ or a difference is not a number. */
function maxDiff(a, b) {
  if (!a.channels || !b.channels || a.channels.length !== b.channels.length) return Infinity;
  let m = 0;
  for (let c = 0; c < a.channels.length; ++c) {
    const x = a.channels[c], y = b.channels[c];
    if (x.length !== y.length) return Infinity;
    for (let i = 0; i < x.length; ++i) {
      const d = Math.abs(x[i] - y[i]);
      if (d !== d) return Infinity;
      if (d > m) m = d;
    }
  }
  return m;
}

/* Index of the first differing sample between two renders, or -1. */
function firstDifference(a, b) {
  let first = -1;
  for (let c = 0; c < Math.min(a.channels.length, b.channels.length); ++c)
    for (let i = 0; i < Math.min(a.channels[c].length, b.channels[c].length); ++i)
      if (a.channels[c][i] !== b.channels[c][i]) { if (first < 0 || i < first) first = i; break; }
  return first;
}

/*
 * Two renders that must agree. category: "identical" (bit for bit), "summation" (differs, within
 * the measured same-engine tolerance) or "mismatch" (beyond it: a failure).
 */
function compareRenders(a, b, tolerance) {
  const d = maxDiff(a, b);
  const first = firstDifference(a, b);
  const category = d === 0 && first < 0 ? "identical" : d <= tolerance ? "summation" : "mismatch";
  return { ok: category !== "mismatch", category, maxDiff: d, firstDifferingSample: first, reasons: category === "mismatch" ? ["max |diff| " + d.toExponential(3) + " at sample " + first + " (tolerance " + tolerance + ")"] : [] };
}

/* A held note: {hold, diff, peak, nf}. Audible while held, equal to the uncut note before the note-off, finite. */
function judgeHeld(x, { audiblePeak, follow }) {
  const reasons = [];
  if (x.nf) reasons.push(x.nf + " non-finite sample(s)");
  if (!(x.hold >= audiblePeak)) reasons.push("too quiet while held (peak " + x.hold.toExponential(2) + " < " + audiblePeak + ")");
  const rel = x.diff / x.peak;
  if (!(rel <= follow)) reasons.push("differs from the uncut note before the note-off (" + rel.toExponential(2) + " of the peak > " + follow + ")");
  return { ok: !reasons.length, reasons };
}

/* A released note against upstream's release: {diff, peak, nf}. */
function judgeCompleted(x, tolerance) {
  const reasons = [];
  if (x.nf) reasons.push(x.nf + " non-finite sample(s)");
  if (!(x.diff <= tolerance)) reasons.push("max |diff| " + x.diff.toExponential(2) + " > " + tolerance);
  return { ok: !reasons.length, reasons };
}

/*
 * How many diagnostic re-renders a case may spend (a deterministic defect fails many items; each
 * would be re-rendered). The budget limits the diagnostics only, never the verdict.
 */
function makeBudget(items) {
  return { total: items, left: items, skipped: 0 };
}

const OUTCOMES = {
  CLEAN: "clean",
  INTERMITTENT: "first attempt failed; a re-render was clean (diagnostic only, the verdict stays failed)",
  REPRODUCED: "first attempt failed; reproduced in every re-render",
  NOT_RERENDERED: "first attempt failed; not re-rendered (diagnostic budget spent)",
};
/* The same, short enough to follow a failure in a check's detail. */
const SHORT = { [OUTCOMES.CLEAN]: "clean", [OUTCOMES.INTERMITTENT]: "diagnostic: a re-render was clean", [OUTCOMES.REPRODUCED]: "diagnostic: reproduced", [OUTCOMES.NOT_RERENDERED]: "diagnostic: not re-rendered" };

/*
 * One item. `first` is its first attempt, judge(attempt) -> {ok, reasons, [info]}, rerun() renders it
 * again. The result's ok and reasons are the first attempt's, and only its. Re-renders (at most
 * `retries`, stopping at the first clean one, and only while the budget lasts) are listed in
 * `diagnostics`; `attempts` counts every render of the item.
 */
async function attempts({ first, judge, rerun, retries = 2, budget }) {
  const v = judge(first);
  const out = { ok: v.ok, reasons: v.reasons.slice(), attempts: 1, diagnostics: [], outcome: OUTCOMES.CLEAN };
  if (v.ok) return out;
  if (!rerun || !budget || budget.left <= 0) {
    if (budget) ++budget.skipped;
    out.outcome = OUTCOMES.NOT_RERENDERED;
    return out;
  }
  --budget.left;
  let clean = false;
  for (let k = 0; k < retries && !clean; ++k) {
    const r = judge(await rerun());
    ++out.attempts;
    out.diagnostics.push({ attempt: out.attempts, ok: r.ok, reasons: r.reasons.slice(), info: r.info });
    clean = r.ok;
  }
  out.outcome = clean ? OUTCOMES.INTERMITTENT : OUTCOMES.REPRODUCED;
  return out;
}

/*
 * Two renders a and b that must agree (source and min, or a repeat). Only the first pair decides.
 * On a mismatch the pair is rendered again as a diagnostic: rerenderA() / rerenderB() give a new
 * render of each side (null keeps that side's first render), onDiagnostic(render) sees every
 * re-render, and each attempt records the cross differences that say which side moved.
 */
async function comparePair({ a, b, rerenderA, rerenderB, tolerance, budget, retries = 2, onDiagnostic = () => {} }) {
  return attempts({
    first: { a, b }, budget, retries,
    judge: (x) => { const c = compareRenders(x.a, x.b, tolerance); return { ok: c.ok, reasons: c.reasons, info: x.cross }; },
    rerun: async () => {
      const na = rerenderA ? onDiagnostic(await rerenderA()) : a;
      const nb = rerenderB ? onDiagnostic(await rerenderB()) : b;
      return { a: na, b: nb, cross: { newAvsFirstB: compareRenders(na, b, tolerance).maxDiff, firstAvsNewB: compareRenders(a, nb, tolerance).maxDiff } };
    },
  });
}

/* Collects the items that failed their first attempt, for the case's observation. */
function createLog(budget) {
  const failures = [];
  let items = 0, renders = 0;
  return {
    add(label, res) {
      ++items;
      renders += res.attempts;
      if (!res.ok) failures.push({ item: label, firstAttempt: { reasons: res.reasons }, outcome: res.outcome, attempts: res.attempts, diagnostics: res.diagnostics });
      return res;
    },
    /* Counts renders of the failed items only beyond their first. */
    summary() {
      const diag = failures.reduce((n, f) => n + f.diagnostics.length, 0);
      return {
        items,
        firstAttemptFailures: failures.length,
        intermittent: failures.filter((f) => f.outcome === OUTCOMES.INTERMITTENT).length,
        reproduced: failures.filter((f) => f.outcome === OUTCOMES.REPRODUCED).length,
        notRerendered: failures.filter((f) => f.outcome === OUTCOMES.NOT_RERENDERED).length,
        diagnosticRenderAttempts: diag,
        rendersIncludingFirstAttempts: renders,
        diagnosticBudget: budget ? { total: budget.total, unspent: budget.left } : null,
        failures,
      };
    },
  };
}

/*
 * Fault injection, for the regression runs of this policy (tasks/T13.1.md §5): the environment variable
 * TINYSYNTH_INJECT_FIRST_ATTEMPT_FAULT=<site>:<kind> corrupts the FIRST attempt of the first item at
 * <site> in each case, once, and nothing else; every re-render is clean. The run must fail, and its
 * diagnostics must show the clean re-render. Sites: held, completed (short-notes), render, repeat
 * (render.js). Kinds: transient (a finite 0.5 step over 128 samples), quiet (the note's samples
 * are zeroed), nonfinite (a NaN sample). Unset in every normal run.
 */
const FAULT_ENV = "TINYSYNTH_INJECT_FIRST_ATTEMPT_FAULT";

function faultInjector(site, env = process.env) {
  const m = /^(\w+):(transient|quiet|nonfinite)$/.exec(env[FAULT_ENV] || "");
  let armed = !!m && m[1] === site;
  const kind = m && m[2];
  return {
    /* The kind to inject into this item's first attempt, once, or null. */
    take() {
      if (!armed) return null;
      armed = false;
      return kind;
    },
  };
}

/* A held or completed result {hold, diff, peak, nf}, corrupted as the same fault in the page would. */
function corruptSummary(kind, x) {
  const y = Object.assign({}, x);
  if (kind === "transient") y.diff = 0.5 * (y.peak || 1);
  else if (kind === "quiet") { y.hold = 0; y.diff = y.peak; }
  else if (kind === "nonfinite") y.nf = (y.nf || 0) + 1;
  return y;
}

/* A render {channels, whole, ...}, corrupted in a copy of its channels. */
function corruptRender(kind, r, at = 1000) {
  const channels = r.channels.map((c) => Float32Array.from(c));
  for (const c of channels) {
    if (kind === "transient") for (let i = at; i < Math.min(c.length, at + 128); ++i) c[i] += 0.5;
    else if (kind === "quiet") c.fill(0);
    else if (kind === "nonfinite" && at < c.length) c[at] = NaN;
  }
  const whole = Object.assign({}, r.whole);
  if (kind === "nonfinite") whole.nan = (whole.nan || 0) + 1;
  return Object.assign({}, r, { channels, whole });
}

module.exports = { maxDiff, firstDifference, compareRenders, judgeHeld, judgeCompleted, makeBudget, attempts, comparePair, createLog, OUTCOMES, SHORT, FAULT_ENV, faultInjector, corruptSummary, corruptRender };
