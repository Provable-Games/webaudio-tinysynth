"use strict";

function pcmBuffer(bytes, name) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError(name + " must be a Buffer");
  if (!bytes.length || bytes.length % 4) throw new RangeError(name + " must contain complete Float32 samples");
  return bytes;
}

function pcmPair(left, right, name) {
  left = pcmBuffer(left, name + " left channel");
  right = pcmBuffer(right, name + " right channel");
  if (left.length !== right.length) throw new RangeError(name + " channels have different lengths");
  return [left, right];
}

function analyzePcm(left, right) {
  const channels = pcmPair(left, right, "PCM");
  let nonFiniteSamples = 0, peakAbsolute = 0, nonZeroSamples = 0;
  let firstNonFinite = null;
  for (let channel = 0; channel < channels.length; ++channel) {
    const bytes = channels[channel];
    for (let offset = 0; offset < bytes.length; offset += 4) {
      const value = bytes.readFloatLE(offset);
      if (!Number.isFinite(value)) {
        ++nonFiniteSamples;
        if (!firstNonFinite) firstNonFinite = { channel, sample: offset >> 2, value: String(value) };
      } else {
        const absolute = Math.abs(value);
        if (absolute > peakAbsolute) peakAbsolute = absolute;
        if (value !== 0) ++nonZeroSamples;
      }
    }
  }
  return {
    samplesPerChannel: channels[0].length >> 2,
    finite: nonFiniteSamples === 0,
    nonFiniteSamples,
    firstNonFinite,
    peakAbsolute: nonFiniteSamples ? null : peakAbsolute,
    finitePeakAbsolute: peakAbsolute,
    allZero: nonFiniteSamples === 0 && nonZeroSamples === 0,
    nonZeroSamples,
  };
}

function comparePcm(left, right, reference) {
  const channels = pcmPair(left, right, "candidate PCM");
  if (!Array.isArray(reference) || reference.length !== 2) throw new TypeError("reference must be a two-channel Buffer pair");
  const refs = pcmPair(reference[0], reference[1], "reference PCM");
  if (refs[0].length !== channels[0].length) throw new RangeError("candidate and reference PCM have different lengths");
  let differentSamples = 0, numericDifferentSamples = 0, signedZeroDifferences = 0;
  let first = -1, last = -1, firstChannel = null, maxFiniteAbs = 0;
  let firstNumeric = -1, lastNumeric = -1, firstNumericChannel = null;
  for (let channel = 0; channel < channels.length; ++channel) {
    const bytes = channels[channel], ref = refs[channel];
    for (let offset = 0; offset < bytes.length; offset += 4) {
      const aBits = bytes.readUInt32LE(offset), bBits = ref.readUInt32LE(offset);
      if (aBits === bBits) continue;
      const sample = offset >> 2;
      ++differentSamples;
      if (first < 0 || sample < first) { first = sample; firstChannel = channel; }
      if (sample > last) last = sample;
      const a = bytes.readFloatLE(offset), b = ref.readFloatLE(offset);
      if (a !== b) {
        ++numericDifferentSamples;
        if (firstNumeric < 0 || sample < firstNumeric) { firstNumeric = sample; firstNumericChannel = channel; }
        if (sample > lastNumeric) lastNumeric = sample;
      }
      else if (a === 0 && b === 0) ++signedZeroDifferences;
      if (Number.isFinite(a) && Number.isFinite(b)) maxFiniteAbs = Math.max(maxFiniteAbs, Math.abs(a - b));
    }
  }
  return {
    differentSamples,
    numericDifferentSamples,
    signedZeroDifferences,
    first: first < 0 ? null : first,
    firstChannel,
    firstQuantum: first < 0 ? null : Math.floor(first / 128),
    firstOffsetInQuantum: first < 0 ? null : first % 128,
    last: last < 0 ? null : last,
    firstNumeric: firstNumeric < 0 ? null : firstNumeric,
    firstNumericChannel,
    firstNumericQuantum: firstNumeric < 0 ? null : Math.floor(firstNumeric / 128),
    firstNumericOffsetInQuantum: firstNumeric < 0 ? null : firstNumeric % 128,
    lastNumeric: lastNumeric < 0 ? null : lastNumeric,
    maxFiniteAbs,
    candidate: analyzePcm(channels[0], channels[1]),
    reference: analyzePcm(refs[0], refs[1]),
  };
}

function correlateLag(candidate, reference, maxLag = 512, sampleRate = 44100) {
  const candidates = pcmPair(candidate[0], candidate[1], "candidate PCM");
  const references = pcmPair(reference[0], reference[1], "reference PCM");
  if (candidates[0].length !== references[0].length) throw new RangeError("candidate and reference PCM have different lengths");
  if (!Number.isInteger(maxLag) || maxLag < 0) throw new RangeError("maxLag must be a non-negative integer");
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError("sampleRate must be positive and finite");
  const candidateInfo = analyzePcm(candidates[0], candidates[1]);
  const referenceInfo = analyzePcm(references[0], references[1]);
  if (!candidateInfo.finite || !referenceInfo.finite) {
    return { finite: false, status: "non-finite", candidate: candidateInfo, reference: referenceInfo };
  }

  const length = candidateInfo.samplesPerChannel;
  let peak = 0, candidateStart = length, candidateEnd = 0, referenceStart = length, referenceEnd = 0;
  for (let channel = 0; channel < 2; ++channel) {
    for (let sample = 0; sample < length; ++sample) {
      const c = Math.abs(candidates[channel].readFloatLE(sample * 4));
      const r = Math.abs(references[channel].readFloatLE(sample * 4));
      if (c > peak) peak = c;
      if (r > peak) peak = r;
    }
  }
  if (peak === 0) {
    return { finite: true, status: "silent", normalizedCorrelation: null, bestLagFrames: null, bestLagSeconds: null, channels: [0, 1] };
  }
  const threshold = peak * 0.01;
  for (let sample = 0; sample < length; ++sample) {
    let candidateActive = false, referenceActive = false;
    for (let channel = 0; channel < 2; ++channel) {
      candidateActive ||= Math.abs(candidates[channel].readFloatLE(sample * 4)) > threshold;
      referenceActive ||= Math.abs(references[channel].readFloatLE(sample * 4)) > threshold;
    }
    if (candidateActive) {
      candidateStart = Math.min(candidateStart, sample);
      candidateEnd = sample + 1;
    }
    if (referenceActive) {
      referenceStart = Math.min(referenceStart, sample);
      referenceEnd = sample + 1;
    }
  }

  let bestLag = 0, bestCorrelation = -Infinity, bestWindow = null;
  for (let lag = -Math.min(maxLag, length - 1); lag <= Math.min(maxLag, length - 1); ++lag) {
    const start = Math.max(candidateStart, referenceStart + lag, lag, 0);
    const end = Math.min(candidateEnd, referenceEnd + lag, length, length + lag);
    if (end - start < 2) continue;
    const sums = [{ x: 0, y: 0, xx: 0, yy: 0, xy: 0 }, { x: 0, y: 0, xx: 0, yy: 0, xy: 0 }];
    const count = end - start;
    for (let channel = 0; channel < 2; ++channel) {
      const x = candidates[channel], y = references[channel], acc = sums[channel];
      for (let sample = start; sample < end; ++sample) {
        const xv = x.readFloatLE(sample * 4), yv = y.readFloatLE((sample - lag) * 4);
        acc.x += xv;
        acc.y += yv;
        acc.xx += xv * xv;
        acc.yy += yv * yv;
        acc.xy += xv * yv;
      }
    }
    let covariance = 0, energyCandidate = 0, energyReference = 0;
    for (const acc of sums) {
      covariance += acc.xy - acc.x * acc.y / count;
      energyCandidate += acc.xx - acc.x * acc.x / count;
      energyReference += acc.yy - acc.y * acc.y / count;
    }
    const denominator = Math.sqrt(energyCandidate * energyReference);
    if (!denominator) continue;
    const correlation = covariance / denominator;
    if (correlation > bestCorrelation + 1e-12 || (Math.abs(correlation - bestCorrelation) <= 1e-12 && Math.abs(lag) < Math.abs(bestLag))) {
      bestLag = lag;
      bestCorrelation = correlation;
      bestWindow = { candidateStart: start, candidateEnd: end, referenceStart: start - lag, referenceEnd: end - lag, samplesPerChannel: count };
    }
  }
  if (!bestWindow) {
    return { finite: true, status: "no-energy", normalizedCorrelation: null, bestLagFrames: null, bestLagSeconds: null, channels: [0, 1] };
  }
  const channelCoefficients = {};
  for (let channel = 0; channel < 2; ++channel) {
    const start = bestWindow.candidateStart, end = bestWindow.candidateEnd, count = end - start;
    let sumX = 0, sumY = 0, sumXX = 0, sumYY = 0, sumXY = 0;
    for (let sample = start; sample < end; ++sample) {
      const x = candidates[channel].readFloatLE(sample * 4);
      const y = references[channel].readFloatLE((sample - bestLag) * 4);
      sumX += x; sumY += y; sumXX += x * x; sumYY += y * y; sumXY += x * y;
    }
    const covariance = sumXY - sumX * sumY / count;
    const denominator = Math.sqrt((sumXX - sumX * sumX / count) * (sumYY - sumY * sumY / count));
    channelCoefficients[channel] = denominator ? covariance / denominator : null;
  }
  return {
    finite: true,
    status: "correlated",
    normalizedCorrelation: bestCorrelation,
    channelCoefficients,
    bestLagFrames: bestLag,
    bestLagSeconds: bestLag / sampleRate,
    sampleRate,
    maxLagFrames: maxLag,
    thresholdAbsolute: threshold,
    activeWindow: { candidateStart, candidateEnd, referenceStart, referenceEnd },
    overlapWindow: bestWindow,
    channels: [0, 1],
  };
}

function compareAlignedPcm(candidate, reference, lag) {
  const candidates = pcmPair(candidate[0], candidate[1], "candidate PCM");
  const references = pcmPair(reference[0], reference[1], "reference PCM");
  if (candidates[0].length !== references[0].length) throw new RangeError("candidate and reference PCM have different lengths");
  if (!Number.isInteger(lag)) throw new TypeError("lag must be an integer number of frames");
  const samples = candidates[0].length >> 2;
  if (Math.abs(lag) >= samples) throw new RangeError("lag must be smaller than the PCM length");
  const candidateStart = Math.max(0, lag);
  const referenceStart = Math.max(0, -lag);
  const overlapSamplesPerChannel = samples - Math.abs(lag);
  const alignedCandidate = candidates.map((channel) => channel.subarray(candidateStart * 4, (candidateStart + overlapSamplesPerChannel) * 4));
  const alignedReference = references.map((channel) => channel.subarray(referenceStart * 4, (referenceStart + overlapSamplesPerChannel) * 4));
  return {
    lagFrames: lag,
    candidateStartSample: candidateStart,
    referenceStartSample: referenceStart,
    overlapSamplesPerChannel,
    comparison: comparePcm(alignedCandidate[0], alignedCandidate[1], alignedReference),
  };
}

module.exports = { analyzePcm, comparePcm, correlateLag, compareAlignedPcm };
