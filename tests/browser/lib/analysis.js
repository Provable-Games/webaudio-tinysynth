/*
 * Rendered-audio analysis for the browser matrix (scripts/browser-matrix.js).
 *
 * Everything here runs in Node on PCM copied out of the browser, so one
 * implementation measures every engine. The estimators are checked against
 * synthetic signals with known answers by selfTest(), which the matrix runner
 * runs before it launches any browser.
 *
 * Conventions: x is a Float32Array or Array of samples, sr the sample rate in
 * Hz, times in seconds, frequencies in Hz, pitch differences in cents.
 */
"use strict";
const crypto = require("crypto");

const cents = (f, ref) => 1200 * Math.log2(f / ref);
const midiHz = (n) => 440 * Math.pow(2, (n - 69) / 12);
const db = (ratio) => 20 * Math.log10(ratio);

/* In-place iterative radix-2 FFT; re and im are Float64Arrays of length 2^k. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; ++i) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; ++k) {
        const a = i + k, b = a + half;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/* 4-term Blackman-Harris window (-92 dB sidelobes). */
function blackmanHarris(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; ++i) {
    const p = 2 * Math.PI * i / (n - 1);
    w[i] = 0.35875 - 0.48829 * Math.cos(p) + 0.14128 * Math.cos(2 * p) - 0.01168 * Math.cos(3 * p);
  }
  return w;
}

function segment(x, sr, start, duration) {
  const a = Math.max(0, Math.round(start * sr));
  const b = Math.min(x.length, a + Math.round(duration * sr));
  return Array.prototype.slice.call(x, a, b);
}

/*
 * Frequency of the strongest spectral peak between fmin and fmax, in the
 * segment [start, start+duration). Blackman-Harris window, zero padding to at
 * least 8x the segment length, and quadratic interpolation of the log
 * magnitude around the peak bin. Returns {freq, level} (level relative to the
 * strongest bin anywhere, in dB) or null for a silent segment.
 */
function peakFrequency(x, sr, { start = 0, duration, fmin = 20, fmax = sr / 2 } = {}) {
  const seg = segment(x, sr, start, duration === undefined ? x.length / sr - start : duration);
  const m = seg.length;
  if (m < 64) throw new Error("peakFrequency: segment too short (" + m + " samples)");
  let n = 1;
  while (n < m * 8) n <<= 1;
  const re = new Float64Array(n), im = new Float64Array(n);
  const w = blackmanHarris(m);
  let mean = 0;
  for (let i = 0; i < m; ++i) mean += seg[i];
  mean /= m;
  for (let i = 0; i < m; ++i) re[i] = (seg[i] - mean) * w[i];
  fft(re, im);
  const mag = (k) => Math.sqrt(re[k] * re[k] + im[k] * im[k]);
  const k0 = Math.max(1, Math.ceil(fmin * n / sr));
  const k1 = Math.min(n / 2 - 1, Math.floor(fmax * n / sr));
  let best = -1, bestMag = 0, globalMax = 0;
  for (let k = 1; k < n / 2; ++k) {
    const v = mag(k);
    if (v > globalMax) globalMax = v;
    if (k >= k0 && k <= k1 && v > bestMag) { bestMag = v; best = k; }
  }
  if (best < 0 || bestMag === 0) return null;
  const a = Math.log(mag(best - 1) || 1e-300), b = Math.log(bestMag), c = Math.log(mag(best + 1) || 1e-300);
  const den = a - 2 * b + c;
  const delta = den === 0 ? 0 : 0.5 * (a - c) / den;
  return { freq: (best + delta) * sr / n, level: db(bestMag / globalMax) };
}

/*
 * Instantaneous frequency from positive-going zero crossings (linear
 * interpolation), for a pure tone. Returns [{t, freq}] with t the midpoint of
 * each period.
 */
function zeroCrossingFrequencies(x, sr, { start = 0, duration } = {}) {
  const a = Math.max(1, Math.round(start * sr));
  const b = Math.min(x.length, duration === undefined ? x.length : a + Math.round(duration * sr));
  const crossings = [];
  for (let i = a; i < b; ++i) {
    if (x[i - 1] < 0 && x[i] >= 0) crossings.push((i - 1 + x[i - 1] / (x[i - 1] - x[i])) / sr);
  }
  const out = [];
  for (let i = 1; i < crossings.length; ++i)
    out.push({ t: (crossings[i] + crossings[i - 1]) / 2, freq: 1 / (crossings[i] - crossings[i - 1]) });
  return out;
}

/*
 * Amplitude envelope of a tone of known frequency: one value per block of
 * `period` samples (an integer number of samples per cycle makes the block an
 * exact number of cycles), sqrt(2 * mean square). Returns {t, amp} arrays,
 * t being the block centres.
 */
function blockEnvelope(x, sr, period) {
  const t = [], amp = [];
  for (let i = 0; i + period <= x.length; i += period) {
    let s = 0;
    for (let j = i; j < i + period; ++j) s += x[j] * x[j];
    t.push((i + period / 2) / sr);
    amp.push(Math.sqrt(2 * s / period));
  }
  return { t, amp };
}

/* Index of the first sample whose magnitude exceeds threshold, from `from`. */
function firstAbove(x, threshold, from = 0) {
  for (let i = from; i < x.length; ++i) if (Math.abs(x[i]) > threshold) return i;
  return -1;
}

/* Index of the last sample whose magnitude exceeds threshold. */
function lastAbove(x, threshold) {
  for (let i = x.length - 1; i >= 0; --i) if (Math.abs(x[i]) > threshold) return i;
  return -1;
}

function rms(x, from = 0, to = x.length) {
  let s = 0;
  for (let i = from; i < to; ++i) s += x[i] * x[i];
  return to > from ? Math.sqrt(s / (to - from)) : 0;
}

function peak(x, from = 0, to = x.length) {
  let p = 0;
  for (let i = from; i < to; ++i) {
    const v = Math.abs(x[i]);
    if (v > p) p = v;
  }
  return p;
}

/* Counts of NaN and infinite samples. */
function nonFinite(x) {
  let nan = 0, inf = 0;
  for (let i = 0; i < x.length; ++i) {
    if (Number.isNaN(x[i])) ++nan;
    else if (!Number.isFinite(x[i])) ++inf;
  }
  return { nan, inf };
}

/*
 * Least-squares fit of ln(y - floor) = c - t/tau over points with
 * y - floor > minAbove. Returns {tau, r2, n}.
 */
function fitTau(t, y, floor = 0, minAbove = 1e-9) {
  let n = 0, st = 0, sl = 0, stt = 0, stl = 0;
  const pts = [];
  for (let i = 0; i < t.length; ++i) {
    const v = y[i] - floor;
    if (v > minAbove) pts.push([t[i], Math.log(v)]);
  }
  for (const [ti, li] of pts) { ++n; st += ti; sl += li; stt += ti * ti; stl += ti * li; }
  if (n < 3) return { tau: NaN, r2: 0, n };
  const slope = (n * stl - st * sl) / (n * stt - st * st);
  const icpt = (sl - slope * st) / n;
  let ssr = 0, sst = 0;
  const ml = sl / n;
  for (const [ti, li] of pts) {
    const e = li - (icpt + slope * ti);
    ssr += e * e;
    sst += (li - ml) * (li - ml);
  }
  return { tau: -1 / slope, r2: sst > 0 ? 1 - ssr / sst : 1, n };
}

/* Time at which a rising envelope first reaches `level` (linear interpolation). */
function crossingTime(t, y, level, fromIndex = 0) {
  for (let i = Math.max(1, fromIndex); i < y.length; ++i) {
    if (y[i - 1] < level && y[i] >= level) return t[i - 1] + (level - y[i - 1]) / (y[i] - y[i - 1]) * (t[i] - t[i - 1]);
  }
  return NaN;
}

function mean(a) {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
}

function sha256(...arrays) {
  const h = crypto.createHash("sha256");
  for (const a of arrays) h.update(Buffer.from(a.buffer, a.byteOffset, a.byteLength));
  return h.digest("hex");
}

/* 32-bit float WAV (WAVE_FORMAT_IEEE_FLOAT) for manual listening. */
function wav(channels, sr) {
  const n = channels[0].length, nc = channels.length;
  const data = Buffer.alloc(n * nc * 4);
  for (let i = 0; i < n; ++i)
    for (let c = 0; c < nc; ++c) data.writeFloatLE(channels[c][i], (i * nc + c) * 4);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(3, 20); h.writeUInt16LE(nc, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * nc * 4, 28); h.writeUInt16LE(nc * 4, 32); h.writeUInt16LE(32, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/* Deterministic pseudo-random numbers for the self-test (mulberry32). */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/*
 * Checks every estimator against signals with known answers. Returns
 * [{name, ok, detail}]. The pitch cases use frequencies that fall between FFT
 * bins, harmonics and noise; the bound is far below the render tolerances.
 */
function selfTest() {
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
  const rnd = prng(12345);
  for (const sr of [44100, 48000]) {
    for (const f of [110, 261.6255653005986, 440, 452.8929841231365, 1760, 2093.004522404789]) {
      const n = Math.round(0.4 * sr);
      const x = new Float32Array(n);
      for (let i = 0; i < n; ++i) {
        const p = 2 * Math.PI * f * i / sr;
        x[i] = 0.3 * Math.sin(p + 0.3) + 0.2 * Math.sin(2 * p) + 0.1 * Math.sin(3 * p + 1) + 0.001 * (rnd() - 0.5);
      }
      const est = peakFrequency(x, sr, { fmin: f * 0.94, fmax: f * 1.06 });
      const err = cents(est.freq, f);
      check("peakFrequency " + f.toFixed(3) + " Hz @" + sr, Math.abs(err) < 0.01, err.toFixed(5) + " cents");
    }
    // Vibrato: 440 Hz, +/-50 cents at 5 Hz, read back by zero crossings.
    const n = sr;
    const x = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; ++i) {
      const fi = 440 * Math.pow(2, 50 * Math.sin(2 * Math.PI * 5 * i / sr) / 1200);
      ph += 2 * Math.PI * fi / sr;
      x[i] = 0.5 * Math.sin(ph);
    }
    const zc = zeroCrossingFrequencies(x, sr).map((p) => cents(p.freq, 440));
    const depth = (Math.max(...zc) - Math.min(...zc)) / 2;
    check("zeroCrossing vibrato depth @" + sr, Math.abs(depth - 50) < 1, depth.toFixed(3) + " cents (50)");
    // Envelope: exponential decay with tau 0.1 s of a 300 Hz tone.
    const period = sr / 300;
    const y = new Float32Array(sr);
    for (let i = 0; i < sr; ++i) y[i] = 0.5 * Math.exp(-i / sr / 0.1) * Math.sin(2 * Math.PI * 300 * i / sr);
    const env = blockEnvelope(y, sr, period);
    const fit = fitTau(env.t, env.amp);
    check("blockEnvelope + fitTau @" + sr, Math.abs(fit.tau - 0.1) < 0.0005, fit.tau.toFixed(6) + " s (0.1)");
  }
  const z = new Float32Array([0, 1, NaN, Infinity, -Infinity]);
  const nf = nonFinite(z);
  check("nonFinite", nf.nan === 1 && nf.inf === 2, JSON.stringify(nf));
  return results;
}

module.exports = {
  cents, midiHz, db, fft, peakFrequency, zeroCrossingFrequencies, blockEnvelope, firstAbove, lastAbove,
  rms, peak, nonFinite, fitTau, crossingTime, mean, sha256, wav, prng, selfTest, segment,
};
