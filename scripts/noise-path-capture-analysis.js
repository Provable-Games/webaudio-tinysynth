#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const analysis = require("./noise-path-analysis");

function fail(message) {
  console.error("FAIL: " + message);
  process.exit(2);
}

function parseArgs(argv) {
  const result = {};
  const allowed = new Set(["capture", "out", "evidence-root", "max-lag"]);
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (!match || Object.hasOwn(result, match[1])) fail("expected unique --name=value arguments");
    if (!allowed.has(match[1])) fail("unknown option --" + match[1]);
    result[match[1]] = match[2];
  }
  for (const key of ["capture", "out", "evidence-root"])
    if (!result[key] || !path.isAbsolute(result[key])) fail("--" + key + " must be an absolute path");
  if (!path.resolve(result.out).startsWith(path.resolve(result["evidence-root"]) + path.sep))
    fail("--out must be inside --evidence-root");
  const maxLag = Number(result["max-lag"] || 512);
  if (!Number.isInteger(maxLag) || maxLag < 0 || maxLag > 4096) fail("--max-lag must be from 0 to 4096");
  return { capture: path.resolve(result.capture), out: path.resolve(result.out), maxLag };
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function one(rows, kind) {
  const found = rows.filter((row) => row.kind === kind);
  if (found.length !== 1) throw new Error("capture must contain exactly one " + kind + " record");
  return found[0];
}

function decode(value, name) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw new Error(name + " is not canonical base64");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error(name + " is not canonical base64");
  return bytes;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = fs.readFileSync(args.capture);
  const rows = input.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
  const metadata = one(rows, "metadata"), browser = one(rows, "browser"), summary = one(rows, "summary");
  const count = metadata.attemptsRequested;
  if (!Number.isInteger(count) || count < 1 || count > 6000 || summary.attemptsRequested !== count ||
      metadata.sampleRate !== 44100 && metadata.sampleRate !== 48000 || summary.rendered !== count ||
      summary.errors !== 0 || summary.analysisErrors !== 0 || summary.protocolErrors !== 0 ||
      !Number.isFinite(metadata.duration) || metadata.duration <= 0 || metadata.duration > 10)
    throw new Error("capture is incomplete, invalid, or outside the bounded reducer contract");
  const attempts = rows.filter((row) => row.kind === "attempt");
  if (attempts.length !== count) throw new Error("capture does not contain every first attempt");
  const byTrial = new Map();
  for (const attempt of attempts) {
    if (!Number.isInteger(attempt.trial) || attempt.trial < 0 || attempt.trial >= count || byTrial.has(attempt.trial) ||
        attempt.firstAttempt !== true || attempt.state !== "rendered")
      throw new Error("capture has an invalid, duplicate, or non-rendered first attempt");
    byTrial.set(attempt.trial, attempt);
  }
  for (let trial = 0; trial < count; ++trial) if (!byTrial.has(trial)) throw new Error("missing trial " + trial);
  const marked = attempts.filter((attempt) => attempt.firstSuccessfullyRenderedPcm === true);
  if (marked.length !== 1 || marked[0].trial !== 0 || summary.firstSuccessfullyRenderedTrial !== 0)
    throw new Error("complete rendered capture must retain trial 0 as its first successfully rendered reference");
  const first = marked[0];
  const expectedFrames = Math.ceil(metadata.duration * metadata.sampleRate);
  const expectedBytes = expectedFrames * 4;
  if (!Number.isSafeInteger(expectedFrames) || !Number.isSafeInteger(expectedBytes) || expectedBytes <= 0)
    throw new Error("capture duration produces an invalid PCM length");
  const reference = [decode(first.leftPcm, "first left PCM"), decode(first.rightPcm, "first right PCM")];
  if (reference[0].length !== expectedBytes || reference[1].length !== expectedBytes ||
      sha256(Buffer.concat(reference)) !== first.pcmSha256 || first.pcmSha256 !== first.firstPcmReferenceSha256)
    throw new Error("retained first PCM length or SHA-256 is invalid");
  const firstResult = analysis.analyzePcm(reference[0], reference[1]);
  if (!firstResult.finite || summary.firstReferenceFinite !== true) throw new Error("first reference is non-finite");

  const outputRows = [{
    kind: "metadata",
    task: "#91 within-capture finite first-reference lag diagnostics",
    capture: args.capture,
    captureSha256: sha256(input),
    engine: metadata.engine,
    browserVersion: browser.version,
    sampleRate: metadata.sampleRate,
    graph: metadata.graph,
    variant: metadata.variant,
    program: metadata.program,
    note: metadata.note,
    playbackRate: summary.effectivePlaybackRateMin,
    firstTrial: first.trial,
    sourceSha256: metadata.librarySourceSha256,
    minSha256: metadata.freshMinSha256,
    maxLagFrames: args.maxLag,
    lagUse: "diagnostic only; original unaligned first-reference mismatch remains the verdict",
  }];
  let numericDivergent = 0, bitwiseOnly = 0, finiteLagDiagnostics = 0;
  let disagreements = 0, nonFiniteAttempts = 0, nonFiniteSamples = 0, exactZeroAttempts = 0;
  const referenceHash = first.pcmSha256;
  for (let trial = 0; trial < count; ++trial) {
    const attempt = byTrial.get(trial);
    if (attempt.firstPcmReferenceSha256 !== referenceHash || !/^[0-9a-f]{64}$/.test(attempt.pcmSha256 || ""))
      throw new Error("trial " + trial + " has an invalid first-reference digest");
    const leftPresent = typeof attempt.leftPcm === "string", rightPresent = typeof attempt.rightPcm === "string";
    if (leftPresent !== rightPresent) throw new Error("trial " + trial + " retains only one PCM channel");
    let candidate = reference;
    if (leftPresent) {
      candidate = [decode(attempt.leftPcm, "trial " + trial + " left PCM"), decode(attempt.rightPcm, "trial " + trial + " right PCM")];
      if (candidate[0].length !== expectedBytes || candidate[1].length !== expectedBytes ||
          sha256(Buffer.concat(candidate)) !== attempt.pcmSha256)
        throw new Error("trial " + trial + " retained PCM length or SHA-256 is invalid");
    } else if (attempt.pcmSha256 !== referenceHash) throw new Error("trial " + trial + " omitted divergent PCM");
    const candidateResult = analysis.analyzePcm(candidate[0], candidate[1]);
    if (!candidateResult.finite) throw new Error("trial " + trial + " is non-finite; capture analysis requires finite PCM");
    if (attempt.outputFinite !== candidateResult.finite || attempt.outputNonFiniteSamples !== candidateResult.nonFiniteSamples ||
        attempt.outputAllZero !== candidateResult.allZero)
      throw new Error("trial " + trial + " recorded finite/nonzero flags disagree with retained PCM");
    if (!candidateResult.finite) ++nonFiniteAttempts;
    nonFiniteSamples += candidateResult.nonFiniteSamples;
    if (candidateResult.allZero) ++exactZeroAttempts;
    const original = analysis.comparePcm(candidate[0], candidate[1], reference);
    const disagrees = original.differentSamples > 0;
    if (attempt.disagreementWithFirstPcm !== disagrees)
      throw new Error("trial " + trial + " recorded disagreement flag differs from retained PCM");
    if (disagrees) ++disagreements;
    if (attempt.pcmDifference) {
      for (const key of ["differentSamples", "numericDifferentSamples", "firstNumeric"])
        if (Object.hasOwn(attempt.pcmDifference, key) && original[key] !== attempt.pcmDifference[key])
          throw new Error("trial " + trial + " recorded comparison differs from retained PCM at " + key);
    }
    if (original.numericDifferentSamples === 0) {
      if (original.signedZeroDifferences) ++bitwiseOnly;
      continue;
    }
    ++numericDivergent;
    const finite = candidateResult.finite && firstResult.finite;
    const lag = finite ? analysis.correlateLag(candidate, reference, args.maxLag, metadata.sampleRate) : null;
    const aligned = lag && lag.bestLagFrames !== null
      ? analysis.compareAlignedPcm(candidate, reference, lag.bestLagFrames)
      : null;
    if (lag) ++finiteLagDiagnostics;
    outputRows.push({
      kind: "divergent-first-attempt",
      trial,
      finite,
      originalUnalignedDifference: original,
      lagDiagnostic: lag,
      alignedDifferenceDiagnostic: aligned,
    });
  }
  if (summary.nonFiniteAttempts !== nonFiniteAttempts || summary.nonFiniteOutputSamples !== nonFiniteSamples ||
      summary.exactZeroOutputAttempts !== exactZeroAttempts || summary.disagreementsWithFirstPcm !== disagreements ||
      summary.firstReferencePeakAbsolute !== firstResult.peakAbsolute)
    throw new Error("recorded summary totals disagree with retained PCM");
  outputRows.push({
    kind: "summary",
    attemptsRequested: count,
    numericDivergentAttempts: numericDivergent,
    signedZeroOnlyAttempts: bitwiseOnly,
    finiteLagDiagnostics,
    eventRateClaim: "none",
    verdict: "lag alignment is diagnostic and does not reclassify first-attempt differences",
  });
  fs.writeFileSync(args.out, outputRows.map((row) => JSON.stringify(row)).join("\n") + "\n", { flag: "wx" });
  console.log(JSON.stringify({ out: args.out, attemptsRequested: count, numericDivergentAttempts: numericDivergent, signedZeroOnlyAttempts: bitwiseOnly, finiteLagDiagnostics }));
}

try {
  main();
} catch (error) {
  console.error(error && error.stack || error);
  process.exit(1);
}
