/*
 * Rendered-audio tolerances for the browser matrix, declared from measured
 * evidence (docs/improvements/tasks/T6.md, "Tolerances"). Measured on
 * linux-x64 with Chromium 153.0.8010.12, Firefox 155.0 and WebKit 26.6
 * (Playwright 1.63.0): four full render runs (2 quality modes x 2 sample
 * rates x 2 builds each) and the variation spec (three separate launches,
 * seeds 1..6). "max" below is the largest deviation from the independent
 * expectation seen in any engine; each tolerance leaves a margin over it.
 *
 * Deterministic data versus rendered-audio tolerance:
 *   - The generated buffers (convBuf, n0, n1) are deterministic data: with the
 *     test-page seed, the same sample rate gives the same hashes in every
 *     engine, run and build. No tolerance applies.
 *   - Renders where no node sums three or more sounding inputs are
 *     bit-identical within an engine. Chromium sums three or more inputs of a
 *     node in a run-dependent order (reproduced without the library), and
 *     WebKit's percussion renders change when the library's onended handlers
 *     disconnect detune inputs mid-render. Those differences are
 *     rendered-audio tolerance: sameEngineSample below. Firefox was
 *     bit-identical throughout. Separately, WebKit occasionally renders a
 *     segment that differs by up to 0.56 from an otherwise identical render
 *     (arm64 CI and x64; reproduced under main-thread GC pressure; cause not
 *     isolated). That is not summation order and no tolerance covers it: it
 *     is a lost or broken note. The first attempt decides (#78,
 *     lib/first-attempt.js): such a difference fails the run, and a clean
 *     re-render does not clear it. Re-renders are diagnostics only,
 *     counted and recorded apart from the verdict.
 *   - Across engines, renders are never compared sample by sample: each
 *     engine is checked against the same independent expectations. At the
 *     test level (masterVol 0.05, compressor below threshold) the engines
 *     agree within 0.085 dB; at the default masterVol 0.5 Firefox's
 *     DynamicsCompressor reduces GM program energy by up to 3.6 dB and loud
 *     drums by up to 5.5 dB relative to Chromium and WebKit, which agree
 *     within 0.01 dB (crossEngineDb, used by the runner only when several
 *     engines run together).
 */
"use strict";

const DEFAULT = {
  noteAmpMin: 2e-3, // a measured note window in its own render; min 1.89e-2 (w9999 A4), a silenced note measures <= 6.5e-10
  pitchCents: 0.05, // max 0.0065 cents (Firefox), 0.0001 (Chromium, WebKit); estimator self-test < 0.001
  vibratoDepthCents: 0.1, // max depth error 0.023 cents, centre 0.0024
  vibratoRateHz: 0.01, // max 0.0004 Hz
  levelRatio: 1e-3, // relative; max 1.1e-4 (volume, expression, sustain level, linearity)
  panGain: 1e-4, // absolute gain relative to centre; max 4.6e-7
  latencyMs: 6.0, // DynamicsCompressor pre-delay, identical in all three engines
  latencyToleranceMs: 0.25, // max deviation 0.083 ms (sample quantization and sine phase at onset)
  envelopeTimeMs: 0.5, // attack crossing times; max 0.086 ms
  envelopeTauRatio: 0.01, // decay/release time constants; max 0.0012
  drumEndMs: 2.5, // bounded by half a 300 Hz period (1.67 ms) by construction; max 0.31 ms
  silenceRelative: 1e-9, // after a drum stop, relative to the note level; max 1.5e-15
  idlePeak: 1e-8, // after 1 s with no notes; max 3e-12 (Firefox does not snap setTargetAtTime to 0)
  reverbTailMin: 2e-4, // wet tail RMS 0.1-0.45 s after the note; min 1.93e-3 (48 kHz), across seeds within 4 dB
  dryTailMax: 1e-5, // useReverb 0 and reverbLev 0 tails; max 3.1e-7 (Firefox), exactly 0 elsewhere
  reverbTailDb: 26, // wet tail over max(dry tail, dryTailMax) = 20*log10(reverbTailMin/dryTailMax); min 45.7 dB
  reverbTailSide: 0.3, // rms(L-R)/tail in the tail window (a stereo impulse); min 0.697
  audiblePeak: 2e-4, // every GM program and drum rendered alone; min 0.080 (drum 53, Firefox q1 48 kHz); a silent program measures <= 2.3e-7
  sameEngineSample: 1e-6, // source vs min and repeat renders, max |sample diff|: the floating-point summation tolerance only, applied to the first attempt
  seedEffect: 1e-2, // a different seed must change noise-based renders by more than this; min 0.0295
  crossEngineDb: { linear: 0.25, compressed: 7 }, // per-slot GM energy across engines; max 0.085 dB / 5.5 dB (q1 drum 57)
};

const PER_ENGINE = {
  chromium: { sameEngineSample: 5e-4 }, // max 5.45e-5 (GM batches, compressor active); 1.2e-7 at linear levels
  firefox: { sameEngineSample: 0 }, // bit-identical in every comparison
  webkit: { sameEngineSample: 1e-6 }, // max 9.3e-8 for reproducible differences; occasional glitches up to 0.56 (about 1 in 50 renders under GC pressure) are beyond it and fail on their first attempt (#78); clean re-renders are diagnostics
};

function tolerances(engine) {
  return Object.assign({}, DEFAULT, PER_ENGINE[engine] || {});
}

module.exports = { tolerances, DEFAULT, PER_ENGINE };
