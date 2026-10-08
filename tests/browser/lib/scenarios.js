/*
 * Offline render scenarios for the browser matrix. Each scenario describes a
 * render (for tests/browser/page/render.js), how to measure it
 * (lib/analysis.js) and what to expect.
 *
 * Expected values are computed here from the standards, not from the
 * library's code:
 *   - pitch: 12-TET, A4 = 440 Hz, f = 440 * 2^((n - 69 + cents/100) / 12);
 *   - RPN 0/1/2, Universal master fine/coarse tuning: MIDI 1.0 and its RP-012/CA-025;
 *   - GS master tune, master transpose and scale tuning: the Roland GS format
 *     (0.1-cent master tune steps around 0x0400, 1-cent scale tuning around 0x40);
 *   - volume and expression: GM Level 1 recommended practice, gain = (value/127)^2;
 *   - pan: the Web Audio StereoPannerNode equal-power law for a mono input;
 *   - envelope: Web Audio AudioParam semantics (linear ramp, setTargetAtTime);
 * Two mappings are the library's own, documented by T0 and listed in
 * docs/improvements/tasks/T6.md: the pitch-bend unit (100/127 cent per
 * bend-range unit, where MIDI says 100/128) and the modulation depth
 * (CC1 value * 100/127 cents of 5 Hz vibrato). Pan uses the library's
 * (value - 64) / 64 position.
 *
 * Levels: notes are rendered at masterVol 0.05, which keeps the always-present
 * DynamicsCompressor below its threshold, where it applies a constant makeup
 * gain and a fixed pre-delay; the "linearity" scenario checks that. Level
 * assertions are therefore ratios.
 */
"use strict";
const A = require("./analysis");

const LEVEL = 0.05;
const BEND_UNIT_CENTS = 100 / 127; // library baseline (T0 §6); MIDI's RPN 0 unit is 100/128
const LFO_HZ = 5; // library baseline

/* A single sine operator; t:0/f:300 gives a fixed 300 Hz tone (an integer period at 44.1 and 48 kHz). */
const sine = (o) => [Object.assign({ w: "sine", t: 1, f: 0, v: 0.5, a: 0, h: 0.01, d: 0, s: 1, r: 0.02, p: 1, q: 1, k: 0 }, o)];
const sine300 = (o) => sine(Object.assign({ t: 0, f: 300 }, o));

const on = (ch, n, t, v = 100) => ({ call: "noteOn", args: [ch, n, v, t] });
const off = (ch, n, t) => ({ call: "noteOff", args: [ch, n, t] });
const cc = (ch, c, v, t = 0) => ({ send: [0xb0 | ch, c, v], t });
const rpn = (ch, param, msb, lsb) => {
  const s = [cc(ch, 101, 0), cc(ch, 100, param), cc(ch, 6, msb)];
  if (lsb !== undefined) s.push(cc(ch, 38, lsb));
  return s;
};
const gs = (addr, data) => {
  const sum = [...addr, ...data].reduce((a, b) => a + b, 0);
  return { send: [0xf0, 0x41, 0x10, 0x42, 0x12, ...addr, ...data, (128 - (sum % 128)) % 128, 0xf7], t: 0 };
};
const universal = (sub, lsb, msb) => ({ send: [0xf0, 0x7f, 0x7f, 0x04, sub, lsb, msb, 0xf7], t: 0 });
const fine14 = (msb, lsb = 0) => ((msb * 128 + lsb) - 8192) / 8192 * 100;

function pitchCheck(name, measured, expectedHz) {
  return { name, expectedHz, measuredHz: measured ? measured.freq : NaN, cents: measured ? A.cents(measured.freq, expectedHz) : NaN };
}

/* Estimates the pitch of a note sounding over [t0, t1) near expectedHz. */
function notePitch(x, sr, t0, t1, expectedHz) {
  return A.peakFrequency(x, sr, { start: t0, duration: t1 - t0, fmin: expectedHz * Math.pow(2, -1.5 / 12), fmax: expectedHz * Math.pow(2, 1.5 / 12) });
}

function ampOver(x, sr, t0, t1) {
  return A.rms(x, Math.round(t0 * sr), Math.round(t1 * sr)) * Math.SQRT2;
}

const SCENARIOS = [];

/*
 * ---- pitch, tuning, bend, modulation ----
 * Each note is an item rendered alone (a fresh synth and OfflineAudioContext),
 * so no other note's release tail can be measured in its window: with voice
 * pruning stopped, an earlier note on the same pitch would otherwise satisfy
 * a pitch check for a silent note. Every measured window must also carry the
 * note's own energy (amplitude >= noteAmpMin); the only other sound in an
 * item render is the constructor's velocity-1 warm-up note, orders of
 * magnitude below that.
 */
const NOTE_ON = 0.25;
const noteSpec = (steps, duration, timbres = [[0, 0, sine()]]) => ({ duration, masterVol: LEVEL, timbres, steps, pcm: "L" });
function windowCheck(x, sr, w, expectedHz) {
  return Object.assign(pitchCheck(w.name, notePitch(x, sr, w.t0, w.t1, expectedHz), expectedHz), { amp: ampOver(x, sr, w.t0, w.t1) });
}
function verifyPitches(list, tol, check, describe) {
  for (const p of list) {
    if (!check(p.name + ": the note sounds in its own render (amplitude >= " + tol.noteAmpMin + ")", p.amp >= tol.noteAmpMin, p.amp.toExponential(3))) continue;
    check(describe(p), Math.abs(p.cents) <= tol.pitchCents, p.measuredHz.toFixed(4) + " Hz, " + p.cents.toFixed(4) + " cents, tol " + tol.pitchCents);
  }
}
{
  const notes = [45, 57, 60, 69, 81, 93];
  SCENARIOS.push({
    name: "pitch-sine", about: "sine notes A2..A6 against 12-TET, each rendered alone",
    items: notes.map((n) => ({ label: "note " + n, spec: noteSpec([on(0, n, NOTE_ON), off(0, n, NOTE_ON + 0.55)], 0.9), slot: [NOTE_ON + 0.1, NOTE_ON + 0.5] })),
    analyzeItems: (chs, sr) => ({ notes: notes.map((n, i) => windowCheck(chs[i][0], sr, { name: "note " + n, t0: NOTE_ON + 0.1, t1: NOTE_ON + 0.5 }, A.midiHz(n))) }),
    verify: (m, tol, check) => verifyPitches(m.notes, tol, check, (p) => p.name + " " + p.expectedHz.toFixed(3) + " Hz"),
  });
}
{
  const waves = ["square", "sawtooth", "triangle", "w9999"];
  SCENARIOS.push({
    name: "pitch-waves", about: "A4 with each built-in oscillator waveform, each rendered alone",
    items: waves.map((w) => ({ label: w, spec: noteSpec([on(0, 69, NOTE_ON), off(0, 69, NOTE_ON + 0.55)], 0.9, [[0, 0, sine({ w })]]), slot: [NOTE_ON + 0.1, NOTE_ON + 0.5] })),
    analyzeItems: (chs, sr) => ({ notes: waves.map((w, i) => windowCheck(chs[i][0], sr, { name: w, t0: NOTE_ON + 0.1, t1: NOTE_ON + 0.5 }, 440)) }),
    verify: (m, tol, check) => verifyPitches(m.notes, tol, check, (p) => p.name + " A4 fundamental"),
  });
}

/* ---- tuning (RPN, Universal and GS SysEx) ---- */
{
  // GS part number -> MIDI channel: part 0x10 is channel 10 (rhythm), 0x11..0x19 channels 1..9.
  // Each case starts from a fresh synth, so it sends every message its expectation depends on.
  const scaleA = gs([0x40, 0x18, 0x49], [94]);
  const cases = [
    { name: "RPN 1 fine +50", ch: 0, pre: rpn(0, 1, 0x60), cents: fine14(0x60) },
    { name: "RPN 1 fine -25", ch: 1, pre: rpn(1, 1, 48), cents: fine14(48) },
    { name: "RPN 1 fine with LSB +0.78", ch: 2, pre: rpn(2, 1, 0x40, 0x40), cents: fine14(0x40, 0x40) },
    { name: "RPN 2 coarse +2", ch: 3, pre: rpn(3, 2, 66), cents: 200 },
    { name: "RPN 2 coarse -12", ch: 4, pre: rpn(4, 2, 52), cents: -1200 },
    { name: "Universal master fine -25", ch: 5, pre: [universal(3, 0, 48)], cents: fine14(48) },
    { name: "Universal master coarse +1", ch: 5, pre: [universal(4, 0, 65)], cents: 100 },
    { name: "GS master tune +10.0", ch: 6, pre: [gs([0x40, 0x00, 0x00], [0, 4, 6, 4])], cents: (0x464 - 0x400) / 10 },
    { name: "GS master transpose +3", ch: 6, pre: [gs([0x40, 0x00, 0x05], [0x43])], cents: 300 },
    { name: "GS scale tuning A +30 (part 8)", ch: 7, pre: [scaleA], cents: 94 - 64 },
    { name: "GS scale tuning C -20 does not touch A", ch: 7, pre: [scaleA, gs([0x40, 0x18, 0x40], [44])], cents: 30 },
    { name: "RPN coarse +1, fine +50, master fine -25", ch: 8, pre: [...rpn(8, 2, 65), ...rpn(8, 1, 0x60), universal(3, 0, 48)], cents: 100 + 50 - 25 },
  ];
  SCENARIOS.push({
    name: "tuning", about: "RPN fine/coarse, Universal master fine/coarse, GS master tune/transpose/scale tuning on A4, each rendered alone",
    items: cases.map((c) => ({ label: c.name, spec: noteSpec([...c.pre, on(c.ch, 69, NOTE_ON), off(c.ch, 69, NOTE_ON + 0.55)], 0.9), slot: [NOTE_ON + 0.1, NOTE_ON + 0.5] })),
    analyzeItems: (chs, sr) => ({
      notes: cases.map((c, i) => Object.assign(windowCheck(chs[i][0], sr, { name: c.name, t0: NOTE_ON + 0.1, t1: NOTE_ON + 0.5 }, 440 * Math.pow(2, c.cents / 1200)), { expectedCents: c.cents })),
    }),
    verify: (m, tol, check) => verifyPitches(m.notes, tol, check, (p) => p.name + " (" + p.expectedCents.toFixed(3) + " cents)"),
  });
}

/* ---- pitch bend ---- */
{
  const bendCents = (value, range = 256) => (value - 8192) * range * BEND_UNIT_CENTS / 8192;
  const items = [
    { label: "bend before the note", steps: [{ send: [0xe0, 0x7f, 0x7f], t: 0 }, on(0, 69, NOTE_ON), off(0, 69, NOTE_ON + 0.55)],
      windows: [{ name: "bend +8191 before the note (default range)", t0: NOTE_ON + 0.1, t1: NOTE_ON + 0.5, cents: bendCents(16383), midiCents: 8191 / 8192 * 200 }] },
    { label: "mid-note bend", steps: [on(0, 69, NOTE_ON), { send: [0xe0, 0x00, 0x20], t: NOTE_ON + 0.3 }, off(0, 69, NOTE_ON + 0.65)],
      windows: [{ name: "before a mid-note bend", t0: NOTE_ON + 0.05, t1: NOTE_ON + 0.28, cents: 0, midiCents: 0 },
        { name: "after a mid-note bend to 4096", t0: NOTE_ON + 0.35, t1: NOTE_ON + 0.6, cents: bendCents(4096), midiCents: -100 }] },
    { label: "RPN 0 range 12", steps: [...rpn(0, 0, 12, 0), { send: [0xe0, 0x7f, 0x7f], t: 0 }, on(0, 69, NOTE_ON), off(0, 69, NOTE_ON + 0.55)],
      windows: [{ name: "RPN 0 range 12 semitones, bend +8191", t0: NOTE_ON + 0.1, t1: NOTE_ON + 0.5, cents: bendCents(16383, 12 * 128), midiCents: 8191 / 8192 * 1200 }] },
  ];
  SCENARIOS.push({
    name: "bend", about: "pitch bend before and during a note, and with an RPN 0 bend range, each note rendered alone",
    items: items.map((it) => ({ label: it.label, spec: noteSpec(it.steps, 1.0), slot: [it.windows[0].t0, it.windows[it.windows.length - 1].t1] })),
    analyzeItems: (chs, sr) => ({
      parts: items.flatMap((it, i) => it.windows.map((w) => Object.assign(windowCheck(chs[i][0], sr, w, 440 * Math.pow(2, w.cents / 1200)), { expectedCents: w.cents, midiCents: w.midiCents }))),
    }),
    verify: (m, tol, check) => verifyPitches(m.parts, tol, check, (p) => p.name + " (" + p.expectedCents.toFixed(3) + " cents; MIDI unit would give " + p.midiCents.toFixed(3) + ")"),
  });
}

/* ---- modulation (vibrato) ---- */
{
  const parts = [{ name: "CC1 127", value: 127, depth: 127 * 100 / 127 }, { name: "CC1 64", value: 64, depth: 64 * 100 / 127 }];
  const T0 = NOTE_ON + 0.2, T1 = NOTE_ON + 1.9;
  SCENARIOS.push({
    name: "modulation", about: "CC1 vibrato depth and rate on a sine A4, each note rendered alone",
    items: parts.map((p) => ({ label: p.name, spec: noteSpec([cc(0, 1, p.value), on(0, 69, NOTE_ON), off(0, 69, NOTE_ON + 2.0)], 2.4), slot: [T0, T1] })),
    analyzeItems: (chs, sr) => ({
      parts: parts.map((p, i) => {
        const x = chs[i][0];
        const zc = A.zeroCrossingFrequencies(x, sr, { start: T0, duration: T1 - T0 });
        const dev = zc.map((z) => A.cents(z.freq, 440));
        const depth = (Math.max(...dev) - Math.min(...dev)) / 2;
        const mid = (Math.max(...dev) + Math.min(...dev)) / 2;
        const ups = [];
        for (let k = 1; k < dev.length; ++k) if (dev[k - 1] < mid && dev[k] >= mid) ups.push(zc[k - 1].t + (mid - dev[k - 1]) / (dev[k] - dev[k - 1]) * (zc[k].t - zc[k - 1].t));
        return { name: p.name, amp: ampOver(x, sr, T0, T1), expectedDepth: p.depth, depth, centre: mid, rate: (ups.length - 1) / (ups[ups.length - 1] - ups[0]) };
      }),
    }),
    verify: (m, tol, check) => {
      for (const p of m.parts) {
        if (!check(p.name + ": the note sounds in its own render (amplitude >= " + tol.noteAmpMin + ")", p.amp >= tol.noteAmpMin, p.amp.toExponential(3))) continue;
        check(p.name + " depth " + p.expectedDepth.toFixed(2) + " cents", Math.abs(p.depth - p.expectedDepth) <= tol.vibratoDepthCents, p.depth.toFixed(3) + " cents");
        check(p.name + " centred on A4", Math.abs(p.centre) <= tol.vibratoDepthCents, p.centre.toFixed(3) + " cents");
        check(p.name + " rate " + LFO_HZ + " Hz", Math.abs(p.rate - LFO_HZ) <= tol.vibratoRateHz, p.rate.toFixed(3) + " Hz");
      }
    },
  });
}

/* ---- volume, expression, pan ---- */
{
  const steps = [on(0, 69, 0.5), cc(0, 7, 64, 1.0), cc(0, 11, 64, 1.5), off(0, 69, 2.0)];
  SCENARIOS.push({
    name: "volume-expression", about: "CC7 100->64 then CC11 127->64 during a 300 Hz tone",
    spec: { duration: 2.3, masterVol: LEVEL, timbres: [[0, 0, sine300()]], steps, pcm: "L" },
    analyze: ([x], sr) => {
      const a1 = ampOver(x, sr, 0.6, 0.95), a2 = ampOver(x, sr, 1.1, 1.45), a3 = ampOver(x, sr, 1.6, 1.95);
      return { volume: a2 / a1, expression: a3 / a2, expectedVolume: Math.pow(64 / 100, 2), expectedExpression: Math.pow(64 / 127, 2) };
    },
    verify: (m, tol, check) => {
      check("CC7 100->64 gain " + m.expectedVolume.toFixed(5), Math.abs(m.volume / m.expectedVolume - 1) <= tol.levelRatio, m.volume.toFixed(5));
      check("CC11 127->64 gain " + m.expectedExpression.toFixed(5), Math.abs(m.expression / m.expectedExpression - 1) <= tol.levelRatio, m.expression.toFixed(5));
    },
  });
}
{
  const values = [0, 32, 64, 96, 127];
  const steps = [];
  values.forEach((v, i) => { const t = 0.5 + i * 0.6; steps.push(cc(0, 10, v, t - 0.05), on(0, 69, t), off(0, 69, t + 0.45)); });
  SCENARIOS.push({
    name: "pan", about: "CC10 0/32/64/96/127, equal-power StereoPanner law, relative to centre",
    spec: { duration: 0.5 + values.length * 0.6 + 0.2, masterVol: LEVEL, timbres: [[0, 0, sine300()]], steps, pcm: true },
    analyze: ([l, r], sr) => {
      const amps = values.map((v, i) => { const t = 0.5 + i * 0.6; return { v, l: ampOver(l, sr, t + 0.1, t + 0.4), r: ampOver(r, sr, t + 0.1, t + 0.4) }; });
      const c = amps[values.indexOf(64)];
      return {
        pans: amps.map((a) => {
          const x = ((a.v - 64) / 64 + 1) / 2;
          return { v: a.v, l: a.l / c.l, r: a.r / c.r, expectedL: Math.cos(x * Math.PI / 2) / Math.SQRT1_2, expectedR: Math.sin(x * Math.PI / 2) / Math.SQRT1_2 };
        }),
      };
    },
    verify: (m, tol, check) => {
      for (const p of m.pans) {
        check("CC10 " + p.v + " left gain " + p.expectedL.toFixed(5), Math.abs(p.l - p.expectedL) <= tol.panGain, p.l.toFixed(5));
        check("CC10 " + p.v + " right gain " + p.expectedR.toFixed(5), Math.abs(p.r - p.expectedR) <= tol.panGain, p.r.toFixed(5));
      }
    },
  });
}
{
  SCENARIOS.push({
    name: "linearity", about: "masterVol 0.05 vs 0.025: the compressor is linear at test levels",
    spec: { duration: 1.4, masterVol: LEVEL, timbres: [[0, 0, sine300()]], steps: [on(0, 69, 0.5), off(0, 69, 1.2)], pcm: "L" },
    variants: [{ masterVol: LEVEL / 2 }],
    analyze: ([x], sr, [y]) => ({ ratio: ampOver(y, sr, 0.7, 1.1) / ampOver(x, sr, 0.7, 1.1), makeup: ampOver(x, sr, 0.7, 1.1) / (0.5 * 100 * 100 / 16384 * 3 * 100 * 100 / (127 * 127) * LEVEL * Math.SQRT1_2) }),
    verify: (m, tol, check) => {
      check("halving masterVol halves the output", Math.abs(m.ratio / 0.5 - 1) <= tol.levelRatio, m.ratio.toFixed(6));
    },
  });
}

/* ---- envelope, sustain pedal, drum length ---- */
{
  const env = { a: 0.1, h: 0.05, d: 0.1, s: 0.5, r: 0.15 };
  const onT = 0.5, offT = 1.3;
  SCENARIOS.push({
    name: "envelope", about: "AHDSR a=0.1 h=0.05 d=0.1 s=0.5 r=0.15 on a 300 Hz tone, and onset latency of an a=0 note",
    spec: { duration: 4.2, masterVol: LEVEL, timbres: [[0, 0, sine300(env)], [0, 1, sine300()]],
      steps: [on(0, 69, onT), off(0, 69, offT), { call: "setProgram", args: [1, 1] }, on(1, 69, 3.6), off(1, 69, 4.0)], pcm: "L" },
    analyze: ([x], sr) => {
      const steady = ampOver(x, sr, 3.7, 3.95);
      const first = A.firstAbove(x, 1e-3 * steady, Math.round(3.5 * sr));
      const latency = first / sr - 3.6;
      const onset = A.firstAbove(x, 1e-4 * steady, Math.round(0.45 * sr)) / sr;
      const e = A.blockEnvelope(x, sr, sr / 300);
      const rel = (t) => t - onset;
      const peakAmp = ampOver(x, sr, onset + env.a + 0.01, onset + env.a + env.h - 0.005);
      const sustainAmp = ampOver(x, sr, onset + 0.70, onset + 0.78);
      const t10 = rel(A.crossingTime(e.t, e.amp.map((v) => v / peakAmp), 0.1)), t50 = rel(A.crossingTime(e.t, e.amp.map((v) => v / peakAmp), 0.5)), t90 = rel(A.crossingTime(e.t, e.amp.map((v) => v / peakAmp), 0.9));
      const pick = (t0, t1) => { const ts = [], as = []; e.t.forEach((t, i) => { if (t >= t0 && t <= t1) { ts.push(t); as.push(e.amp[i]); } }); return [ts, as]; };
      const [dt, da] = pick(onset + env.a + env.h + 0.01, onset + 0.5);
      const decay = A.fitTau(dt, da, env.s * peakAmp);
      const [rt, ra] = pick(offT + latency + 0.01, offT + latency + 0.5);
      const release = A.fitTau(rt, ra, 0);
      return {
        latencyMs: latency * 1000, onsetDelayMs: (onset - onT) * 1000, attack10: t10, attack50: t50, attack90: t90,
        decayTau: decay.tau, decayR2: decay.r2, sustainRatio: sustainAmp / peakAmp, releaseTau: release.tau, releaseR2: release.r2,
        expected: { attack10: 0.1 * env.a, attack50: 0.5 * env.a, attack90: 0.9 * env.a, decayTau: env.d, sustainRatio: env.s + (1 - env.s) * Math.exp(-(0.74 - env.a - env.h) / env.d), releaseTau: env.r },
      };
    },
    verify: (m, tol, check) => {
      check("onset latency (a=0 note)", Math.abs(m.latencyMs - tol.latencyMs) <= tol.latencyToleranceMs, m.latencyMs.toFixed(3) + " ms, declared " + tol.latencyMs + " +/- " + tol.latencyToleranceMs);
      check("attack onset at the scheduled time + latency", Math.abs(m.onsetDelayMs - tol.latencyMs) <= tol.latencyToleranceMs, m.onsetDelayMs.toFixed(3) + " ms");
      for (const k of ["attack10", "attack50", "attack90"])
        check(k + " at " + (m.expected[k] * 1000).toFixed(1) + " ms after onset (linear ramp)", Math.abs(m[k] - m.expected[k]) * 1000 <= tol.envelopeTimeMs, (m[k] * 1000).toFixed(3) + " ms");
      check("decay time constant " + m.expected.decayTau + " s", Math.abs(m.decayTau / m.expected.decayTau - 1) <= tol.envelopeTauRatio, m.decayTau.toFixed(5) + " s, r2 " + m.decayR2.toFixed(5));
      check("sustain level " + m.expected.sustainRatio.toFixed(4) + " of peak", Math.abs(m.sustainRatio - m.expected.sustainRatio) <= tol.levelRatio, m.sustainRatio.toFixed(5));
      check("release time constant " + m.expected.releaseTau + " s", Math.abs(m.releaseTau / m.expected.releaseTau - 1) <= tol.envelopeTauRatio, m.releaseTau.toFixed(5) + " s, r2 " + m.releaseR2.toFixed(5));
    },
  });
}
{
  const steps = [cc(0, 64, 127, 0.4), on(0, 69, 0.5), off(0, 69, 0.8), cc(0, 64, 0, 1.3), on(1, 69, 2.0), off(1, 69, 2.3)];
  SCENARIOS.push({
    name: "sustain-pedal", about: "CC64 holds a released note until pedal up; control note without pedal",
    spec: { duration: 3.2, masterVol: LEVEL, timbres: [[0, 0, sine300({ r: 0.1 })]], steps, pcm: "L" },
    analyze: ([x], sr) => {
      const held = ampOver(x, sr, 0.6, 0.75), afterOff = ampOver(x, sr, 0.9, 1.25);
      const e = A.blockEnvelope(x, sr, sr / 300);
      const pick = (t0, t1) => { const ts = [], as = []; e.t.forEach((t, i) => { if (t >= t0 && t <= t1) { ts.push(t); as.push(e.amp[i]); } }); return [ts, as]; };
      const rel = A.fitTau(...pick(1.32, 1.6), 0);
      const ctrlHeld = ampOver(x, sr, 2.1, 2.28), ctrlAfter = ampOver(x, sr, 2.5, 2.7);
      return { heldRatio: afterOff / held, releaseTau: rel.tau, controlRatio: ctrlAfter / ctrlHeld, expectedControl: Math.exp(-((2.5 + 2.7) / 2 - 2.306) / 0.1) };
    },
    verify: (m, tol, check) => {
      check("note-off under the pedal keeps the level", Math.abs(m.heldRatio - 1) <= tol.levelRatio, m.heldRatio.toFixed(5));
      check("pedal up releases with r = 0.1 s", Math.abs(m.releaseTau / 0.1 - 1) <= tol.envelopeTauRatio, m.releaseTau.toFixed(5) + " s");
      check("without the pedal the note releases at note-off", m.controlRatio < 0.5, m.controlRatio.toFixed(5) + " (about " + m.expectedControl.toFixed(4) + ")");
    },
  });
}
{
  SCENARIOS.push({
    name: "drum-length", about: "a rhythm-channel note stops 3.5 * d[0] after note-on (d=0.2: 0.7 s)",
    spec: { duration: 1.6, masterVol: LEVEL, timbres: [[1, 38, sine300({ d: 0.2, s: 1 })]], steps: [on(9, 38, 0.5)], pcm: "L" },
    analyze: ([x], sr) => {
      const a = ampOver(x, sr, 0.7, 1.0);
      const last = A.lastAbove(x, 0.5 * a) / sr;
      return { endDelayMs: (last - 0.5 - 0.7) * 1000, tail: A.peak(x, Math.round(1.25 * sr)) / a };
    },
    verify: (m, tol, check) => {
      check("stops at note-on + 0.7 s + latency", Math.abs(m.endDelayMs - tol.latencyMs) <= tol.drumEndMs, m.endDelayMs.toFixed(3) + " ms after note-on + 0.7 s (last sample above half level)");
      check("silent after the stop", m.tail <= tol.silenceRelative, "tail peak " + m.tail.toExponential(3) + " of the note level");
    },
  });
}

/* ---- silence, reverb ---- */
for (const useReverb of [0, 1]) {
  SCENARIOS.push({
    name: "idle-reverb" + useReverb, about: "no notes after construction (useReverb " + useReverb + ")", options: { useReverb },
    spec: { duration: 3, steps: [], pcm: "L" },
    analyze: ([x], sr) => ({ peakAfter1s: A.peak(x, sr), peakAfter2s: A.peak(x, 2 * sr) }),
    verify: (m, tol, check) => check("idle output below " + tol.idlePeak.toExponential(0) + " after 1 s", m.peakAfter1s <= tol.idlePeak, m.peakAfter1s.toExponential(3)),
  });
}
{
  const steps = [on(0, 69, 0.5), off(0, 69, 0.8)];
  const spec = { duration: 1.6, masterVol: LEVEL, timbres: [[0, 0, sine300({ r: 0.01 })]], steps, pcm: true };
  SCENARIOS.push({
    name: "reverb", about: "tail energy 0.1-0.45 s after a note: useReverb 1 vs useReverb 0 vs reverbLev 0", options: { useReverb: 1 },
    spec,
    variants: [{ options: { useReverb: 0 } }, { reverbLev: 0 }],
    analyze: ([wl, wr], sr, [dl, dr], [zl, zr]) => {
      const a = Math.round(0.9 * sr), b = Math.round(1.25 * sr);
      const tail = (l, r) => Math.hypot(A.rms(l, a, b), A.rms(r, a, b));
      const side = new Float32Array(b - a);
      for (let i = a; i < b; ++i) side[i - a] = wl[i] - wr[i];
      const wetTail = tail(wl, wr);
      return {
        wetTail, dryTail: tail(dl, dr), levZeroTail: tail(zl, zr),
        wetBody: A.rms(wl, Math.round(0.6 * sr), Math.round(0.75 * sr)), dryBody: A.rms(dl, Math.round(0.6 * sr), Math.round(0.75 * sr)),
        tailSideRatio: wetTail > 0 ? A.rms(side) / wetTail : 0,
      };
    },
    verify: (m, tol, check) => {
      check("reverb on: tail energy >= " + tol.reverbTailMin, m.wetTail >= tol.reverbTailMin, "wet tail " + m.wetTail.toExponential(3));
      check("useReverb 0: tail <= " + tol.dryTailMax, m.dryTail <= tol.dryTailMax, "dry tail " + m.dryTail.toExponential(3));
      check("reverbLev 0: tail <= " + tol.dryTailMax, m.levZeroTail <= tol.dryTailMax, m.levZeroTail.toExponential(3));
      const ratioDb = A.db(m.wetTail / Math.max(m.dryTail, tol.dryTailMax));
      check("wet tail >= " + tol.reverbTailDb + " dB above the dry tail (or the dry ceiling)", ratioDb >= tol.reverbTailDb, ratioDb.toFixed(1) + " dB");
      check("the reverb tail is stereo (rms(L-R) >= " + tol.reverbTailSide + " of the tail)", m.tailSideRatio >= tol.reverbTailSide, m.tailSideRatio.toFixed(4));
    },
  });
}

/*
 * ---- GM programs and drums ----
 * Every program and drum note is rendered on its own (a fresh synth and
 * OfflineAudioContext per item), so no earlier voice can sound in the slot
 * measured for it: with pruning stopped, a release tail lasts the whole
 * render. The warm-up note the library plays at construction stays far below
 * the audibility threshold in the slot (silent-program floor 2.3e-7, T6.md).
 *
 * Program notes are held 1.2 s, longer than the longest built-in attack
 * (a = 1 s). At baseline a note released before its attack ends is silent
 * until note-off: _releaseNote's cancelScheduledValues(t) removes the whole
 * pending linear ramp. GM 119 (both qualities) and 125 (quality 1) are
 * silent with a 0.3 s note; the variation spec records this (phase B).
 */
const ITEM_ON = 0.25, ITEM_OFF = 1.45, ITEM_DURATION = 1.6;
const ITEM_SLOT = [ITEM_ON, ITEM_DURATION];
const programItem = (n, offAt = ITEM_OFF) => ({ label: "program " + n, spec: { duration: ITEM_DURATION, steps: [{ call: "setProgram", args: [0, n] }, on(0, 60, ITEM_ON), off(0, 60, offAt)], pcm: "L" }, slot: ITEM_SLOT });
const drumItem = (n) => ({ label: "drum " + n, spec: { duration: ITEM_DURATION, steps: [on(9, n, ITEM_ON)], pcm: "L" }, slot: ITEM_SLOT });
for (let b = 0; b < 4; ++b) {
  SCENARIOS.push({
    name: "gm-programs-" + (b * 32) + "-" + (b * 32 + 31), about: "GM programs " + (b * 32) + ".." + (b * 32 + 31) + " at C4 held 1.2 s, each rendered alone, built-in timbres of the case's quality",
    gm: true, options: { useReverb: 0 }, items: Array.from({ length: 32 }, (_, i) => programItem(b * 32 + i)),
    verify: (m, tol, check) => gmVerify(m, tol, check, "program", b * 32),
  });
}
SCENARIOS.push({
  name: "gm-drums", about: "GM drum notes 35..81 on channel 10, each rendered alone",
  gm: true, options: { useReverb: 0 }, items: Array.from({ length: 47 }, (_, i) => drumItem(35 + i)),
  verify: (m, tol, check) => gmVerify(m, tol, check, "drum", 35),
});
function gmVerify(m, tol, check, what, base) {
  const silent = [], loud = [];
  m.slots.forEach((s, i) => { if (!(s.peak >= tol.audiblePeak)) silent.push(base + i); if (!(s.peak <= 1)) loud.push(base + i); });
  check("every " + what + " is audible on its own (peak >= " + tol.audiblePeak + ")", !silent.length,
    (silent.length ? "silent: " + silent.join(",") + "; " : "") + "min peak " + Math.min(...m.slots.map((s) => s.peak)).toExponential(3));
  return { overFullScale: loud, maxPeak: Math.max(...m.slots.map((s) => s.peak)) };
}

module.exports = { SCENARIOS, ITEM_SLOT, programItem, LEVEL, BEND_UNIT_CENTS, LFO_HZ, sine, sine300, on, off, cc, rpn, gs, universal };
