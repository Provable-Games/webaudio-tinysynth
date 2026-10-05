/*
 * Short notes (#59, D-039, ledger L-15; tasks/T13.md and T6 §18.5) in real engines, for both
 * builds. A note released before an operator's attack ends: that operator ramps on to its own
 * value v (T - t) / a at the note-off T and is released from there. Upstream cancelled the whole
 * ramp, so the operator stayed silent until T, and set every operator from the last operator's
 * attack. Every note is rendered alone, in its own synth on an OfflineAudioContext injected at
 * construction, reverb off; renders end on their own (no MIDI is parsed, no loop runs).
 *
 * Asserted, per build:
 *   - held: every built-in program in both quality modes sounds while held with a 0.025, 0.07
 *     and 0.3 s note. Its peak from the note-on to 1 ms before the note-off (both shifted by the
 *     compressor's 6 ms latency, T6 §4.2) reaches the GM audibility floor (tolerances.js,
 *     audiblePeak) at the default level. T6 §18.5 measured 40 programs (quality 1) and 24
 *     (quality 0) silent while held at 0.025 s, among them 40-44, 119 and 125 at 0.07 s;
 *   - the hold is the attack: the short note's output equals the same note's without a
 *     note-off, within FOLLOW of the peak, up to 1 ms before output time T (the compressor's
 *     detector reads its input 6 ms ahead of the delayed output, so its gain reacts to the
 *     note-off from output time T on). This and the audibility check above are made on a
 *     pair of renders (short and uncut), so WebKit's occasional non-reproducible render
 *     glitch (tasks/T6.md, "WebKit's occasional render differences"; tasks/T13.1.md) can
 *     fail either, the Applause noise program among others: "held min" failed once on PR #60
 *     (q0, program 126, 0.07 s, 1.47 of the peak) and passed on re-run. An item outside its
 *     bound is therefore re-rendered (at most twice) and fails unless a re-render is inside
 *     it; at most MAX_RECONCILE items per case are re-rendered, and each is recorded;
 *   - release level: a two-operator timbre at fixed frequencies (400 Hz with a = 0.02 s, then
 *     1000 Hz with a = 0.5 s, so the last operator's attack is the longer), on at 0.4 s and off
 *     0.1 s later, masterVol 0.05 (below the compressor's threshold). Each operator's amplitude
 *     is its DFT bin over 20 ms (8 and 20 whole periods). Before the note-off it equals the
 *     uncut note's; after it, its ratio to the uncut note's in the same window equals that of
 *     its own value at T decaying with r = 1 s, within LEVEL. Upstream released the 400 Hz
 *     operator from 0.1/0.5 of its level and left the 1000 Hz one silent until T;
 *   - the realtime lookahead: playMIDI sends a note-off up to about 0.26 s (preroll plus one
 *     tick) before its time. Emulated with OfflineAudioContext.suspend() at T - 0.2 s (quantized
 *     to 128 frames), then noteOff(T): programs 119, 125 and 40 (quality 1) and 119 and 40
 *     (quality 0), with 0.5 s notes, sound until T and render as the same note-off scheduled
 *     before the render, within PREROLL of the peak. Firefox has no suspend() on an
 *     OfflineAudioContext (Firefox 155); there the check records that and is not made;
 *   - zero-length notes (tasks/T13.md §11): program 0, whose output operator has a = 0, with its
 *     note-off at its note-on time, plays its release in both quality modes (peak at least
 *     audiblePeak). Upstream dropped it in quality 1, where the last operator has an attack;
 *   - completed attacks: every program with an attack (any operator a > 0), in both quality
 *     modes, released 0.1 s after its longest attack ends, renders as with upstream's release
 *     (3d75aee's _releaseNote below, put on the synth after its install), within the engine's
 *     same-engine tolerance (tolerances.js). A difference beyond it is re-rendered (at most twice)
 *     and passes only if a re-render agrees, as specs/render.js does for WebKit's occasional
 *     non-reproducible renders; every such re-render is recorded;
 *   - no page errors.
 */
"use strict";
const pages = require("../lib/pages");
const { tolerances } = require("../tolerances");

const ON = 0.05; // note-on time (s)
const LAT = 0.006; // the DynamicsCompressor's pre-delay (T6 §4.2)
const GUARD = 0.001; // the hold window ends this long before the note-off reaches the output
/*
 * Note lengths on whole frames at 44.1 kHz (0.025 s is 1102.5 frames). Firefox puts automation
 * events on whole frames, so a ramp re-ended between frames has a slightly different slope:
 * 0.5/1102.5 = 4.5e-4 of the level, measured without the library too (tasks/T13.md).
 */
const DURATIONS = [0.025, 0.07, 0.3].map((D) => Math.round(D * 44100) / 44100);
const FOLLOW = 2e-4; // short vs uncut note before T, max |diff| / peak; measured max 6.0e-5 (Firefox), 1.7e-5 (WebKit), 1.3e-5 (Chromium)
const LEVEL = 5e-3; // relative amplitude error of the release-level check; measured max 1.9e-3, every engine
const MAX_RECONCILE = 3; // items per held case that may be re-rendered, as in specs/render.js
const PREROLL = 1e-4; // suspend()-sent vs pre-scheduled note-off, max |diff| / peak; measured 0 (Chromium, WebKit)
const PREROLL_NOTES = [[1, 119], [1, 125], [1, 40], [0, 119], [0, 40]];

/* eslint-disable no-undef -- PAGE runs in the page */
function PAGE() {
  const SR = 44100;
  /*
   * Upstream 3d75aee's _releaseNote (g200kg/webaudio-tinysynth, Apache-2.0), verbatim except
   * that it reads t2, which now holds each operator's attack end, as the last operator's.
   */
  const upstreamRelease = (y) => (nt, t) => {
    const t2 = typeof nt.t2 == "number" ? nt.t2 : nt.t2[nt.t2.length - 1];
    if (nt.ch != 9) {
      for (let k = nt.g.length - 1; k >= 0; --k) {
        nt.g[k].gain.cancelScheduledValues(t);
        if (t == t2)
          nt.g[k].gain.setValueAtTime(nt.v[k], t);
        else if (t < t2)
          nt.g[k].gain.setValueAtTime(nt.v[k] * (t - nt.t) / (t2 - nt.t), t);
        y._setParamTarget(nt.g[k].gain, 0, t, nt.r[k]);
      }
    }
    nt.e = t + nt.r[0] * y.releaseRatio;
    nt.f = 1;
  };
  /*
   * One C4 note rendered alone: {q, program | timbre, off (null: none), dur, masterVol, preroll,
   * reference}. With preroll the note-off is sent at off - preroll from a suspend(); with
   * reference the synth releases with upstreamRelease (swapped in after the install).
   */
  async function note(o) {
    const ctx = new OfflineAudioContext(2, Math.round(o.dur * SR), SR);
    const y = new WebAudioTinySynth({ quality: o.q, useReverb: 0, context: ctx });
    if (o.reference) y._releaseNote = upstreamRelease(y);
    if (o.masterVol !== undefined) y.setMasterVol(o.masterVol);
    if (o.timbre) y.setTimbre(0, 0, o.timbre);
    y.setProgram(0, o.timbre ? 0 : o.program);
    y.noteOn(0, 60, 100, o.on);
    let sent = null, resumed = null;
    if (o.off !== null) {
      if (o.preroll) {
        sent = Math.round((o.off - o.preroll) * SR / 128) * 128 / SR;
        resumed = ctx.suspend(sent).then(() => { y.noteOff(0, 60, o.off); return ctx.resume(); });
      }
      else y.noteOff(0, 60, o.off);
    }
    const buf = await ctx.startRendering();
    await resumed;
    await y.dispose();
    return { ch: [buf.getChannelData(0), buf.getChannelData(1)], sent };
  }
  const span = (a, b, n) => [Math.max(0, Math.round(a * SR)), Math.min(n, Math.round(b * SR))];
  function peak(r, a, b) {
    let p = 0;
    for (const x of r.ch) { const [i0, i1] = span(a, b, x.length); for (let i = i0; i < i1; ++i) p = Math.max(p, Math.abs(x[i])); }
    return p;
  }
  function maxDiff(r, s, a, b) {
    let d = 0;
    for (let c = 0; c < 2; ++c) {
      const x = r.ch[c], z = s.ch[c], [i0, i1] = span(a, b, Math.min(x.length, z.length));
      for (let i = i0; i < i1; ++i) { const e = Math.abs(x[i] - z[i]); if (!(e <= d)) d = e; }
    }
    return d;
  }
  /* The amplitude of frequency f (a whole number of periods in [a, b)) in the left channel: its DFT bin. */
  function amp(r, f, a, b) {
    const x = r.ch[0], [i0, i1] = span(a, b, x.length);
    let s = 0, c = 0;
    for (let i = i0; i < i1; ++i) { const w = 2 * Math.PI * f * i / SR; s += x[i] * Math.sin(w); c += x[i] * Math.cos(w); }
    return 2 * Math.hypot(s, c) / (i1 - i0);
  }
  window.__sn = {
    hasSuspend: typeof OfflineAudioContext.prototype.suspend === "function",
    attacks: (q) => {
      const y = new WebAudioTinySynth({ quality: q, useReverb: 0, context: new OfflineAudioContext(1, 128, SR) });
      const a = y.program.map((x) => x.p.map((o) => o.a));
      return y.dispose().then(() => a);
    },
    /* Held and follow: per duration, the hold's peak and the short note's max |diff| from the uncut note before T. */
    held: async ({ q, program, on, durations, lat, guard }) => {
      const end = (D) => on + D + lat - guard;
      const long = await note({ q, program, on, off: null, dur: end(Math.max(...durations)) + 0.01 });
      const out = [];
      for (const D of durations) {
        const r = await note({ q, program, on, off: on + D, dur: end(D) + 0.01 });
        // The compressor's detector reads its input lat ahead of the delayed output, so its gain
        // reacts to the note-off from output time on + D on: compare the output up to there.
        out.push({ D, hold: peak(r, on + lat, end(D)), diff: maxDiff(r, long, 0, on + D - guard), peak: peak(long, 0, on + D - guard) });
      }
      return out;
    },
    /* Release level: per operator frequency, the amplitude before and after T, short and uncut. */
    level: async ({ timbre, on, off, lat, freqs, win }) => {
      const short = await note({ q: 1, timbre, on, off, dur: off + 0.1, masterVol: 0.05 });
      const long = await note({ q: 1, timbre, on, off: null, dur: off + 0.1, masterVol: 0.05 });
      const before = [off + lat - 0.0005 - win, off + lat - 0.0005], after = [off + lat + 0.0005, off + lat + 0.0005 + win];
      return freqs.map((f) => ({ f, shortBefore: amp(short, f, ...before), longBefore: amp(long, f, ...before), shortAfter: amp(short, f, ...after), longAfter: amp(long, f, ...after) }));
    },
    /* Lookahead: the note-off sent from suspend() at off - preroll, against the same note-off scheduled before the render. */
    preroll: async ({ q, program, on, off, lat, guard, preroll }) => {
      const direct = await note({ q, program, on, off, dur: off + 0.3 });
      const sent = await note({ q, program, on, off, dur: off + 0.3, preroll });
      return { sent: sent.sent, gap: peak(sent, sent.sent + lat + 0.003, off + lat - guard), diff: maxDiff(sent, direct, 0, off + 0.3), peak: peak(direct, 0, off + 0.3) };
    },
    /* Zero-length notes: program 0 with its note-off at its note-on time; the peak after it. */
    zero: async ({ q, on }) => peak(await note({ q, program: 0, on, off: on, dur: on + 0.5 }), on, on + 0.5),
    /* Completed attacks: this build's release against upstream's. */
    completed: async ({ q, program, on, off, dur }) => {
      const fixed = await note({ q, program, on, off, dur });
      const ref = await note({ q, program, on, off, dur, reference: true });
      return { diff: maxDiff(fixed, ref, 0, dur), peak: peak(fixed, 0, dur) };
    },
  };
}
/* eslint-enable no-undef */

async function openPage(t, build) {
  const p = await t.newPage({ offline: true });
  await p.page.setContent(pages.inlinePage({ library: pages.readLibrary(build, t.shared.options.overrides), seed: t.shared.options.seed, after: ["(" + PAGE.toString() + ")();"] }));
  return p;
}

/* eslint-disable no-undef -- the callbacks below run in the page */
const call = (p, name, arg) => p.page.evaluate(([n, a]) => window.__sn[n](a), [name, arg]);
/* eslint-enable no-undef */

const list = (xs, n = 12) => xs.slice(0, n).join(", ") + (xs.length > n ? ", … (" + xs.length + ")" : "");

function cases(shared) {
  const tol = tolerances(shared.engine);
  const out = [];
  for (const build of shared.matrix.builds) {
    out.push({
      id: "short-notes held " + build,
      dims: { build },
      deadline: 900,
      run: async (t) => {
        const p = await openPage(t, build);
        const silent = [], off = [], reconciled = [];
        let worst = { rel: 0 }, renders = 0, rerendered = 0;
        // Outside the bound on either check: too quiet while held, or not the uncut note before T.
        const bad = (x) => !(x.hold >= tol.audiblePeak) || !(x.diff / x.peak <= FOLLOW);
        for (const q of shared.matrix.qualities) {
          for (let n = 0; n < 128; ++n) {
            const r = await call(p, "held", { q, program: n, on: ON, durations: DURATIONS, lat: LAT, guard: GUARD });
            renders += r.length + 1;
            for (let x of r) {
              /*
               * A render pair outside its bound is rendered again, alone, at most twice (WebKit's
               * glitch does not reproduce; a defect of the library does, on every render). It
               * counts only if a re-render is inside the bound; the first result is kept in
               * the failure message and in the record.
               */
              if (bad(x) && rerendered < MAX_RECONCILE) {
                const first = x;
                ++rerendered;
                let k = 0;
                while (k < 2 && bad(x)) {
                  [x] = await call(p, "held", { q, program: n, on: ON, durations: [first.D], lat: LAT, guard: GUARD });
                  renders += 2;
                  ++k;
                }
                if (!bad(x)) reconciled.push({ q, program: n, D: +first.D.toFixed(4), hold: first.hold, rel: first.diff / first.peak, renders: k * 2 });
                else x = first;
              }
              if (!(x.hold >= tol.audiblePeak)) silent.push("q" + q + " " + n + " @" + x.D.toFixed(4) + " s (" + x.hold.toExponential(2) + ")");
              const rel = x.diff / x.peak;
              if (!(rel <= FOLLOW)) off.push("q" + q + " " + n + " @" + x.D.toFixed(4) + " s: " + rel.toExponential(2));
              if (rel > worst.rel) worst = { rel, at: "q" + q + " " + n + " @" + x.D.toFixed(4) };
            }
          }
        }
        t.check("every program in both quality modes sounds while held with a " + DURATIONS.map((D) => +D.toFixed(4)).join(", ") + " s note (hold peak >= " + tol.audiblePeak + ")", !silent.length, silent.length ? "silent while held: " + list(silent) : "");
        t.check("until the note-off the short note renders as the uncut note (max |diff| <= " + FOLLOW + " of the peak)", !off.length,
          off.length ? list(off) : "max " + worst.rel.toExponential(2) + " (" + worst.at + " s)");
        t.observe("renders", renders);
        t.observe("reconciled held renders (re-rendered; see the header comment)", reconciled);
        t.check("no page errors", !p.pageErrors.length, p.pageErrors.slice(0, 2).join(" | "));
      },
    });
    out.push({
      id: "short-notes release level " + build,
      dims: { build },
      run: async (t) => {
        const p = await openPage(t, build);
        // Late enough that the output's gain has settled (it rises by about 7 % over the first 0.25 s
        // of a context in Chromium, at every level); each ratio below is taken in one window anyway.
        const on = 0.4, off = 0.5, win = 0.02, r = 1, N = 882;
        const ops = [{ f: 400, a: 0.02 }, { f: 1000, a: 0.5 }];
        const timbre = ops.map((o) => ({ w: "sine", t: 0, f: o.f, v: 0.5, a: o.a, h: 2, d: 1, s: 1, r }));
        const m = await call(p, "level", { timbre, on, off, lat: LAT, freqs: ops.map((o) => o.f), win });
        const rel = (x, y) => Math.abs(x / y - 1);
        m.forEach((x, k) => {
          const o = ops[k], D = off - on;
          const before = rel(x.shortBefore, x.longBefore);
          t.check(o.f + " Hz operator (a " + o.a + " s): until the note-off it sounds as the uncut note (" + x.shortBefore.toExponential(4) + " vs " + x.longBefore.toExponential(4) + ")", before <= LEVEL, "relative error " + before.toExponential(2));
          /*
           * After the note-off, in the same window: the uncut operator is at its level (attack
           * ended) or on its ramp, proportional to tau - on; the released one is its value at T,
           * that level or the ramp's D / a of it, times exp(-(tau - T)/r). The bin ratio is the
           * mean of short/uncut weighted by the uncut envelope.
           */
          let num = 0, den = 0;
          for (let i = 0; i < N; ++i) {
            const tau = off + 0.0005 + i / 44100, uncut = o.a <= tau - on ? 1 : (tau - on) / o.a;
            num += Math.min(1, D / o.a) * Math.exp(-(tau - off) / r);
            den += uncut;
          }
          const expected = num / den, ratio = x.shortAfter / x.longAfter;
          t.check(o.f + " Hz operator: released from its own value at the note-off (short/uncut " + ratio.toFixed(5) + ", expected " + expected.toFixed(5) + ")", rel(ratio, expected) <= LEVEL, "relative error " + rel(ratio, expected).toExponential(2));
        });
        t.observe("amplitudes", m);
        for (const q of shared.matrix.qualities) {
          const z = await call(p, "zero", { q, on: 0.5 });
          t.check("q" + q + " program 0 (output operator a = 0), note-off at its note-on time: plays its release (peak " + z.toExponential(3) + " >= " + tol.audiblePeak + ")", z >= tol.audiblePeak);
        }
        t.check("no page errors", !p.pageErrors.length, p.pageErrors.slice(0, 2).join(" | "));
      },
    });
    out.push({
      id: "short-notes preroll " + build,
      dims: { build },
      run: async (t) => {
        const p = await openPage(t, build);
        const has = await p.page.evaluate(() => window.__sn.hasSuspend); // eslint-disable-line no-undef -- runs in the page
        if (!has) {
          t.observe("OfflineAudioContext.suspend() is not available in " + t.engine + ": the realtime lookahead is not emulated here (tasks/T13.md)", true);
          t.check("only Firefox lacks OfflineAudioContext.suspend()", t.engine === "firefox", t.engine);
        } else {
          const res = [];
          for (const [q, program] of PREROLL_NOTES) {
            const r = await call(p, "preroll", { q, program, on: ON, off: ON + 0.5, lat: LAT, guard: GUARD, preroll: 0.2 });
            res.push(r);
            t.check("q" + q + " program " + program + ", 0.5 s note, note-off sent at " + r.sent.toFixed(4) + " s: sounds until the note-off (peak " + r.gap.toExponential(3) + ")", r.gap >= tol.audiblePeak);
            t.check("q" + q + " program " + program + ": renders as the note-off scheduled before the render (max |diff| <= " + PREROLL + " of the peak)", r.diff <= PREROLL * r.peak, (r.diff / r.peak).toExponential(2));
          }
          t.observe("preroll renders", res);
        }
        t.check("no page errors", !p.pageErrors.length, p.pageErrors.slice(0, 2).join(" | "));
      },
    });
    out.push({
      id: "short-notes completed " + build,
      dims: { build },
      deadline: 900,
      run: async (t) => {
        const p = await openPage(t, build);
        const bad = [], reconciled = [];
        let worst = 0, compared = 0;
        for (const q of shared.matrix.qualities) {
          const attacks = await call(p, "attacks", q);
          for (let n = 0; n < 128; ++n) {
            const a = Math.max(...attacks[n]);
            if (!(a > 0)) continue;
            const off = ON + a + 0.1, arg = { q, program: n, on: ON, off, dur: off + 0.4 };
            let r = await call(p, "completed", arg);
            ++compared;
            if (!(r.diff <= tol.sameEngineSample)) {
              const first = r.diff;
              for (let k = 0; k < 2 && !(r.diff <= tol.sameEngineSample); ++k) r = await call(p, "completed", arg);
              if (r.diff <= tol.sameEngineSample) reconciled.push({ q, program: n, first, renders: 2 });
              else bad.push("q" + q + " " + n + ": " + first.toExponential(2) + " (reproduced)");
            }
            worst = Math.max(worst, r.diff);
          }
        }
        t.check("every program with an attack, released after its attacks end, renders as with upstream's release (" + compared + " programs, max |diff| <= " + tol.sameEngineSample + ")",
          !bad.length && compared > 100, bad.length ? list(bad) : "max " + worst.toExponential(2));
        t.observe("reconciled same-engine differences (re-rendered)", reconciled);
        t.check("no page errors", !p.pageErrors.length, p.pageErrors.slice(0, 2).join(" | "));
      },
    });
  }
  return out;
}

module.exports = { cases };
