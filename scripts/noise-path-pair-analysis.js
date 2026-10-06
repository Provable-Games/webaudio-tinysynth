#!/usr/bin/env node
/*
 * Pair-index analysis for the bounded library/manual noise-path reducer.
 * The two captures are independent runs matched by first-attempt trial index
 * and source-buffer identity. Lag alignment is diagnostic only: original
 * unaligned PCM differences remain the recorded comparison verdict.
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { isDeepStrictEqual } = require("util");
const analysis = require("./noise-path-analysis");

function fail(message) {
  console.error("FAIL: " + message);
  process.exit(2);
}

function optionsOf(argv) {
  const values = {};
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (!match) fail("expected --name=value, got " + arg);
    if (Object.prototype.hasOwnProperty.call(values, match[1])) fail("duplicate option --" + match[1]);
    values[match[1]] = match[2];
  }
  const allowed = new Set(["library", "manual", "out", "evidence-root", "max-lag"]);
  for (const key of Object.keys(values)) if (!allowed.has(key)) fail("unknown option --" + key);
  for (const key of ["library", "manual", "out"]) {
    if (!values[key] || !path.isAbsolute(values[key])) fail("--" + key + " must be an absolute path");
  }
  if (path.extname(values.out) !== ".jsonl") fail("--out must have a .jsonl extension");
  if (values["evidence-root"]) {
    if (!path.isAbsolute(values["evidence-root"])) fail("--evidence-root must be absolute");
    const root = path.resolve(values["evidence-root"]);
    if (!path.resolve(values.out).startsWith(root + path.sep)) fail("--out must be inside --evidence-root");
  }
  const maxLag = Number(values["max-lag"] || 512);
  if (!Number.isInteger(maxLag) || maxLag < 0 || maxLag > 4096) fail("--max-lag must be an integer from 0 to 4096");
  return Object.assign(values, { maxLag });
}

const GRAPH_SETTING_KEYS = [
  "masterGain", "channelVolume", "expression", "channelGain", "pan",
  "pannerPresent", "modulationGain", "bend", "lfoFrequency",
  "compressorPresent", "compressorParameters",
];
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function oneRecord(rows, kind, file) {
  const matches = rows.filter((row) => row.kind === kind);
  if (matches.length !== 1) throw new Error(file + " must contain exactly one " + kind + " record");
  return matches[0];
}

function decodeBase64(value, label) {
  if (typeof value !== "string" || !BASE64_RE.test(value)) throw new Error(label + " is not canonical base64");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error(label + " is not canonical base64");
  return bytes;
}

function graphSettings(source, file, trial) {
  const settings = source && source.graphSettings;
  if (!settings || typeof settings !== "object") throw new Error(file + " trial " + trial + " has no graph settings");
  const result = {};
  for (const key of GRAPH_SETTING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(settings, key)) throw new Error(file + " trial " + trial + " graph settings omit " + key);
    result[key] = settings[key];
  }
  for (const key of ["masterGain", "channelVolume", "expression", "channelGain", "pan", "modulationGain", "bend", "lfoFrequency"]) {
    if (!Number.isFinite(result[key])) throw new Error(file + " trial " + trial + " graph setting " + key + " is not finite");
  }
  if (typeof result.pannerPresent !== "boolean" || typeof result.compressorPresent !== "boolean")
    throw new Error(file + " trial " + trial + " graph node presence is malformed");
  const compressor = result.compressorParameters;
  if (!compressor || typeof compressor !== "object") throw new Error(file + " trial " + trial + " compressor parameters are missing");
  for (const key of ["threshold", "knee", "ratio", "attack", "release"])
    if (!Number.isFinite(compressor[key])) throw new Error(file + " trial " + trial + " compressor setting " + key + " is not finite");
  return result;
}

function validateSource(attempt, capture) {
  const { file, metadata } = capture;
  const sources = attempt.sources;
  if (!Array.isArray(sources) || sources.length !== 1) throw new Error(file + " trial " + attempt.trial + " must contain one n0 source");
  const source = sources[0];
  if (source.operator !== 0 || source.wave !== "n0" || source.loop !== true)
    throw new Error(file + " trial " + attempt.trial + " is not the expected looped n0 operator");
  if (!Number.isFinite(source.playbackRate) || !Array.isArray(attempt.effectivePlaybackRates) ||
      attempt.effectivePlaybackRates.length !== 1 || attempt.effectivePlaybackRates[0] !== source.playbackRate)
    throw new Error(file + " trial " + attempt.trial + " has inconsistent effective playback rate metadata");
  if (source.bufferSampleRate !== metadata.noiseBufferSampleRate || source.bufferLength !== metadata.noiseBufferFrames)
    throw new Error(file + " trial " + attempt.trial + " source buffer dimensions differ from metadata");
  if (!/^[0-9a-f]{64}$/.test(source.bufferSha256 || "")) throw new Error(file + " trial " + attempt.trial + " has an invalid source buffer SHA-256");
  if (source.sourceBufferIdentityMatches !== true) throw new Error(file + " trial " + attempt.trial + " source buffer identity check failed");
  graphSettings(source, file, attempt.trial);
  if (attempt.trial === capture.summary.firstSuccessfullyRenderedTrial && source.bufferPcm === undefined)
    throw new Error(file + " first successful trial does not retain source buffer PCM");

  if (source.bufferPcm !== undefined) {
    const sourcePcm = decodeBase64(source.bufferPcm, file + " trial " + attempt.trial + " source buffer PCM");
    if (sourcePcm.length !== metadata.noiseBufferFrames * 4 || sha256(sourcePcm) !== source.bufferSha256)
      throw new Error(file + " trial " + attempt.trial + " retained source buffer PCM does not match its length/hash");
  }
  return source;
}

function readCapture(file) {
  const text = fs.readFileSync(file, "utf8").trim();
  if (!text) throw new Error(file + " is empty");
  const rows = text.split("\n").map((line) => JSON.parse(line));
  const metadata = oneRecord(rows, "metadata", file);
  const browser = oneRecord(rows, "browser", file);
  const summary = oneRecord(rows, "summary", file);
  if (!Number.isInteger(metadata.attemptsRequested) || metadata.attemptsRequested < 1 || metadata.attemptsRequested > 6000)
    throw new Error(file + " has invalid attemptsRequested metadata");
  for (const key of ["noiseSeed", "noiseBufferVersion", "noiseBufferSampleRate", "noiseBufferFrames"])
    if (!Number.isInteger(metadata[key])) throw new Error(file + " is missing valid " + key + " metadata");
  if (metadata.noiseBufferSampleRate !== metadata.sampleRate || metadata.noiseBufferFrames !== Math.floor(metadata.sampleRate * 0.5))
    throw new Error(file + " has inconsistent noise buffer dimensions");
  if (metadata.noiseBufferAlgorithm !== "fmix32-mulberry32-n0-stream-1") throw new Error(file + " has an unknown n0 buffer algorithm version");
  if (!Array.isArray(metadata.programOperators) || metadata.programOperators.length !== 1 || metadata.programOperators[0].w !== "n0")
    throw new Error(file + " does not identify the single quality-0 n0 program operator");
  if (browser.name !== metadata.engine || typeof browser.version !== "string" || !browser.version)
    throw new Error(file + " browser metadata does not match the capture engine");
  if (summary.attemptsRequested !== metadata.attemptsRequested) throw new Error(file + " summary attempt count differs from metadata");

  const attempts = rows.filter((row) => row.kind === "attempt");
  if (attempts.length !== metadata.attemptsRequested) throw new Error(file + " does not have one attempt record per requested trial");
  const byTrial = new Map();
  for (const attempt of attempts) {
    if (!Number.isInteger(attempt.trial) || attempt.trial < 0 || attempt.trial >= metadata.attemptsRequested || byTrial.has(attempt.trial))
      throw new Error(file + " has invalid or duplicate attempt trial records");
    if (attempt.firstAttempt !== true) throw new Error(file + " trial " + attempt.trial + " is not marked as its first attempt");
    byTrial.set(attempt.trial, attempt);
  }
  for (let trial = 0; trial < metadata.attemptsRequested; ++trial)
    if (!byTrial.has(trial)) throw new Error(file + " is missing expected trial " + trial);

  const firstMarkers = attempts.filter((attempt) => attempt.firstSuccessfullyRenderedPcm === true);
  if (firstMarkers.length !== 1 || firstMarkers[0].state !== "rendered")
    throw new Error(file + " must mark exactly one successfully rendered first PCM reference");
  const first = firstMarkers[0];
  if (summary.firstSuccessfullyRenderedTrial !== first.trial) throw new Error(file + " first PCM trial differs from summary");
  const expectedBytes = Math.ceil(metadata.duration * metadata.sampleRate) * 4;
  const hasLeft = typeof first.leftPcm === "string", hasRight = typeof first.rightPcm === "string";
  if (!hasLeft || !hasRight) throw new Error(file + " first PCM reference must retain both channels");
  const referencePcm = [
    decodeBase64(first.leftPcm, file + " first left PCM"),
    decodeBase64(first.rightPcm, file + " first right PCM"),
  ];
  if (referencePcm[0].length !== expectedBytes || referencePcm[1].length !== expectedBytes)
    throw new Error(file + " first PCM channel length does not match sample rate and duration");
  const referenceHash = sha256(Buffer.concat(referencePcm));
  if (first.pcmSha256 !== referenceHash || first.firstPcmReferenceSha256 !== referenceHash)
    throw new Error(file + " first PCM hash does not match its retained channel data");
  if (summary.firstReferenceFinite !== true) throw new Error(file + " first PCM reference contains non-finite samples");

  const capture = { file, rows, metadata, browser, summary, attempts, first, byTrial, referencePcm, referenceHash, sourceByTrial: new Map() };
  for (const attempt of attempts) {
    if (attempt.state !== "rendered") continue;
    const leftPresent = typeof attempt.leftPcm === "string";
    const rightPresent = typeof attempt.rightPcm === "string";
    if (leftPresent !== rightPresent) throw new Error(file + " trial " + attempt.trial + " retains only one PCM channel");
    if (!/^[0-9a-f]{64}$/.test(attempt.pcmSha256 || "")) throw new Error(file + " trial " + attempt.trial + " has an invalid PCM SHA-256");
    if (attempt.firstPcmReferenceSha256 !== referenceHash)
      throw new Error(file + " trial " + attempt.trial + " names the wrong first PCM reference hash");
    if (leftPresent) {
      const pcm = [
        decodeBase64(attempt.leftPcm, file + " trial " + attempt.trial + " left PCM"),
        decodeBase64(attempt.rightPcm, file + " trial " + attempt.trial + " right PCM"),
      ];
      if (pcm[0].length !== expectedBytes || pcm[1].length !== expectedBytes)
        throw new Error(file + " trial " + attempt.trial + " PCM channel length does not match sample rate and duration");
      if (sha256(Buffer.concat(pcm)) !== attempt.pcmSha256)
        throw new Error(file + " trial " + attempt.trial + " PCM SHA-256 does not match its retained channel data");
    } else if (attempt.pcmSha256 !== referenceHash) {
      throw new Error(file + " trial " + attempt.trial + " omits divergent PCM payload");
    }
    if (attempt.trial === first.trial && !leftPresent) throw new Error(file + " first PCM reference payload is missing");
    capture.sourceByTrial.set(attempt.trial, validateSource(attempt, capture));
  }
  return capture;
}

function pcmFor(attempt, capture) {
  if (!attempt || attempt.state !== "rendered") return null;
  if (typeof attempt.leftPcm === "string" && typeof attempt.rightPcm === "string")
    return [Buffer.from(attempt.leftPcm, "base64"), Buffer.from(attempt.rightPcm, "base64")];
  if (attempt.pcmSha256 !== capture.referenceHash) throw new Error(capture.file + " trial " + attempt.trial + " cannot fall back to first PCM");
  return capture.referencePcm;
}

function main() {
  const args = optionsOf(process.argv.slice(2));
  const library = readCapture(args.library);
  const manual = readCapture(args.manual);
  if (library.metadata.graph !== "library" || manual.metadata.graph !== "manual-chain")
    fail("expected --library capture with graph=library and --manual capture with graph=manual-chain");
  for (const key of [
    "engine", "sampleRate", "quality", "program", "note", "velocity", "start", "hold", "duration",
    "librarySourceSha256", "freshMinSha256", "noiseSeed", "noiseBufferVersion", "noiseBufferAlgorithm",
    "noiseBufferSampleRate", "noiseBufferFrames",
  ]) {
    if (!isDeepStrictEqual(library.metadata[key], manual.metadata[key])) fail("capture metadata differs at " + key);
  }
  if (!isDeepStrictEqual(library.metadata.programOperators, manual.metadata.programOperators)) fail("program operator definitions differ");
  for (const key of ["version", "name"])
    if (library.browser[key] !== manual.browser[key]) fail("browser metadata differs at " + key);
  for (const key of ["node", "playwrightCore", "browserPath"])
    if (library.metadata[key] !== manual.metadata[key]) fail("capture runtime metadata differs at " + key);

  const firstLibraryPcm = pcmFor(library.first, library);
  const firstManualPcm = pcmFor(manual.first, manual);
  const firstCrossGraphDifference = analysis.comparePcm(firstManualPcm[0], firstManualPcm[1], firstLibraryPcm);
  const firstCrossGraphLag = firstCrossGraphDifference.numericDifferentSamples && firstCrossGraphDifference.candidate.finite && firstCrossGraphDifference.reference.finite
    ? analysis.correlateLag(firstManualPcm, firstLibraryPcm, args.maxLag, library.metadata.sampleRate)
    : null;
  const firstAligned = firstCrossGraphLag && firstCrossGraphLag.bestLagFrames !== null
    ? analysis.compareAlignedPcm(firstManualPcm, firstLibraryPcm, firstCrossGraphLag.bestLagFrames)
    : null;

  const output = fs.openSync(args.out, "wx");
  const metadata = {
    kind: "metadata",
    task: "#91 paired-index library/manual-chain graph comparison",
    createdAt: new Date().toISOString(),
    pairing: "independent fresh-context captures paired by first-attempt trial index; same deterministic seed and source-buffer hash required",
    engine: library.metadata.engine,
    browserVersion: library.browser.version,
    sampleRate: library.metadata.sampleRate,
    quality: library.metadata.quality,
    program: library.metadata.program,
    note: library.metadata.note,
    sourceLibrarySha256: library.metadata.librarySourceSha256,
    freshMinSha256: library.metadata.freshMinSha256,
    noiseSeed: library.metadata.noiseSeed,
    noiseBufferVersion: library.metadata.noiseBufferVersion,
    noiseBufferAlgorithm: library.metadata.noiseBufferAlgorithm,
    noiseBufferSampleRate: library.metadata.noiseBufferSampleRate,
    noiseBufferFrames: library.metadata.noiseBufferFrames,
    programOperators: library.metadata.programOperators,
    libraryCapture: path.resolve(args.library),
    manualCapture: path.resolve(args.manual),
    maxLagFrames: args.maxLag,
    lagDiagnostic: "computed only for finite divergent PCM; it does not replace the original unaligned comparison or hide local/envelope differences",
    firstLibraryReferenceTrial: library.summary.firstSuccessfullyRenderedTrial,
    firstManualReferenceTrial: manual.summary.firstSuccessfullyRenderedTrial,
    firstCrossGraphUnalignedDifference: firstCrossGraphDifference,
    firstCrossGraphLag: firstCrossGraphLag,
    firstCrossGraphAlignedDifference: firstAligned,
  };
  fs.writeSync(output, JSON.stringify(metadata) + "\n");

  const allTrials = [...new Set([...library.byTrial.keys(), ...manual.byTrial.keys()])].sort((a, b) => a - b);
  let comparedPairs = 0, exactBitwiseMatches = 0, numericSignalMatches = 0, signedZeroOnlyPairs = 0;
  let divergentPairs = 0, numericDivergentPairs = 0, invalidPairs = 0, lagAt128 = 0, lagAt256 = 0;
  let sourceHashMismatches = 0, rateMismatches = 0, graphSettingsMismatches = 0;
  const lagCounts = {};
  for (const trial of allTrials) {
    const left = library.byTrial.get(trial), right = manual.byTrial.get(trial);
    const librarySource = library.sourceByTrial.get(trial), manualSource = manual.sourceByTrial.get(trial);
    const sourceHashesMatch = !!librarySource && !!manualSource && librarySource.bufferSha256 === manualSource.bufferSha256;
    const ratesMatch = !!librarySource && !!manualSource && librarySource.playbackRate === manualSource.playbackRate;
    const graphSettingsMatch = !!librarySource && !!manualSource && isDeepStrictEqual(
      graphSettings(librarySource, library.file, trial),
      graphSettings(manualSource, manual.file, trial),
    );
    if (!sourceHashesMatch) ++sourceHashMismatches;
    if (!ratesMatch) ++rateMismatches;
    if (!graphSettingsMatch) ++graphSettingsMismatches;
    const record = {
      kind: "pair",
      trial,
      libraryState: left && left.state,
      manualState: right && right.state,
      sourceBufferHashesMatch: sourceHashesMatch,
      sourceBufferSha256Library: librarySource && librarySource.bufferSha256,
      sourceBufferSha256Manual: manualSource && manualSource.bufferSha256,
      effectivePlaybackRatesMatch: ratesMatch,
      graphSettingsMatch,
      playbackRateLibrary: librarySource && librarySource.playbackRate,
      playbackRateManual: manualSource && manualSource.playbackRate,
      graphSettingsLibrary: librarySource && librarySource.graphSettings,
      graphSettingsManual: manualSource && manualSource.graphSettings,
    };
    const libraryPcm = pcmFor(left, library);
    const manualPcm = pcmFor(right, manual);
    if (!libraryPcm || !manualPcm) {
      ++invalidPairs;
      record.state = "incomplete";
      fs.writeSync(output, JSON.stringify(record) + "\n");
      continue;
    }
    ++comparedPairs;
    const original = analysis.comparePcm(manualPcm[0], manualPcm[1], libraryPcm);
    record.state = "compared";
    record.libraryPcmSha256 = left.pcmSha256 || library.first.pcmSha256;
    record.manualPcmSha256 = right.pcmSha256 || manual.first.pcmSha256;
    record.libraryPeakAbsolute = original.reference.peakAbsolute;
    record.manualPeakAbsolute = original.candidate.peakAbsolute;
    record.originalUnalignedDifference = original;
    if (!original.differentSamples) {
      ++exactBitwiseMatches;
      ++numericSignalMatches;
      record.lagDiagnostic = null;
      record.alignedDifference = null;
    } else {
      ++divergentPairs;
      if (original.numericDifferentSamples === 0 && original.signedZeroDifferences > 0) {
        ++numericSignalMatches;
        ++signedZeroOnlyPairs;
        record.differenceKind = "signed-zero-bit-pattern-only";
        record.lagDiagnostic = null;
        record.alignedDifference = null;
      } else {
        ++numericDivergentPairs;
        record.differenceKind = "numeric-sample-difference";
        const lag = original.candidate.finite && original.reference.finite
          ? analysis.correlateLag(manualPcm, libraryPcm, args.maxLag, library.metadata.sampleRate)
          : null;
        record.lagDiagnostic = lag;
        if (lag && lag.bestLagFrames !== null) {
          lagCounts[lag.bestLagFrames] = (lagCounts[lag.bestLagFrames] || 0) + 1;
          if (Math.abs(lag.bestLagFrames) === 128) ++lagAt128;
          if (Math.abs(lag.bestLagFrames) === 256) ++lagAt256;
          record.alignedDifference = analysis.compareAlignedPcm(manualPcm, libraryPcm, lag.bestLagFrames);
        } else record.alignedDifference = null;
      }
    }
    fs.writeSync(output, JSON.stringify(record) + "\n");
  }
  const summary = {
    kind: "summary",
    pairsRequested: allTrials.length,
    comparedPairs,
    exactBitwiseMatches,
    numericSignalMatches,
    signedZeroOnlyPairs,
    bitwiseDivergentPairs: divergentPairs,
    numericDivergentPairs,
    incompletePairs: invalidPairs,
    sourceHashMismatches,
    playbackRateMismatches: rateMismatches,
    graphSettingsMismatches,
    divergentPairsWithAbsoluteLag128: lagAt128,
    divergentPairsWithAbsoluteLag256: lagAt256,
    lagCounts,
    eventRateClaim: "none; this is graph-parity and diagnostic evidence, not a rare-event rate estimate",
    lagInterpretation: "positive frames mean manual candidate is delayed versus library reference; original unaligned differences remain verdict data",
  };
  fs.writeSync(output, JSON.stringify(summary) + "\n");
  fs.closeSync(output);
  console.log(JSON.stringify(Object.assign({ out: args.out }, summary)));
  if (invalidPairs || sourceHashMismatches || rateMismatches || graphSettingsMismatches) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error && error.stack || error);
  process.exit(1);
}
