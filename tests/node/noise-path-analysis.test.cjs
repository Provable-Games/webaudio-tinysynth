"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { analyzePcm, comparePcm, correlateLag, compareAlignedPcm } = require("../../scripts/noise-path-analysis");

function pcm(values) {
  return Buffer.from(Float32Array.from(values).buffer);
}

function signal(length) {
  return Array.from({ length }, (_, i) => Math.sin(i * 0.071) * 0.3 + Math.cos(i * 0.019) * 0.2);
}

function shifted(values, lag) {
  const result = new Array(values.length).fill(0);
  for (let i = 0; i < values.length; ++i) {
    const target = i + lag;
    if (target >= 0 && target < values.length) result[target] = values[i];
  }
  return result;
}

test("identical non-finite first PCM is still invalid", () => {
  const left = pcm([0.1, NaN, 0.2, 0.1]);
  const right = pcm([0.1, NaN, 0.2, 0.1]);
  const result = comparePcm(left, right, [left, right]);
  assert.equal(result.differentSamples, 0);
  assert.equal(result.candidate.finite, false);
  assert.equal(result.candidate.nonFiniteSamples, 2);
  assert.equal(result.candidate.firstNonFinite.channel, 0);
  assert.equal(result.reference.finite, false);
});

test("a finite transient records its first sample and render quantum", () => {
  const reference = [pcm(new Array(257).fill(0.125)), pcm(new Array(257).fill(0.125))];
  const candidateLeft = new Array(257).fill(0.125);
  candidateLeft[128] = 0.625;
  const result = comparePcm(pcm(candidateLeft), reference[1], reference);
  assert.equal(result.differentSamples, 1);
  assert.equal(result.first, 128);
  assert.equal(result.firstQuantum, 1);
  assert.equal(result.firstOffsetInQuantum, 0);
  assert.equal(result.maxFiniteAbs, 0.5);
});

test("exact-zero finite PCM is identified without an audibility threshold", () => {
  const left = pcm(new Array(128).fill(0));
  const right = pcm(new Array(128).fill(0));
  assert.deepEqual(analyzePcm(left, right), {
    samplesPerChannel: 128,
    finite: true,
    nonFiniteSamples: 0,
    firstNonFinite: null,
    peakAbsolute: 0,
    finitePeakAbsolute: 0,
    allZero: true,
    nonZeroSamples: 0,
  });
  const negativeZeros = Buffer.alloc(128 * 4);
  for (let offset = 0; offset < negativeZeros.length; offset += 4) negativeZeros.writeUInt32LE(0x80000000, offset);
  assert.equal(analyzePcm(negativeZeros, negativeZeros).allZero, true);
});

test("bitwise signed-zero differences are separated from numeric sample changes", () => {
  const positiveZero = pcm([0]);
  const negativeZero = Buffer.alloc(4);
  negativeZero.writeUInt32LE(0x80000000);
  const result = comparePcm(positiveZero, positiveZero, [negativeZero, positiveZero]);
  assert.equal(result.differentSamples, 1);
  assert.equal(result.numericDifferentSamples, 0);
  assert.equal(result.signedZeroDifferences, 1);
  assert.equal(result.maxFiniteAbs, 0);
});

test("numeric mismatch location is reported separately from an earlier signed-zero bit difference", () => {
  const referenceLeft = Buffer.alloc(8);
  referenceLeft.writeUInt32LE(0x80000000, 0);
  referenceLeft.writeFloatLE(0.25, 4);
  const referenceRight = pcm([0, 0]);
  const candidateLeft = pcm([0, 0.5]);
  const result = comparePcm(candidateLeft, referenceRight, [referenceLeft, referenceRight]);
  assert.equal(result.differentSamples, 2);
  assert.equal(result.numericDifferentSamples, 1);
  assert.equal(result.signedZeroDifferences, 1);
  assert.equal(result.first, 0);
  assert.equal(result.firstNumeric, 1);
  assert.equal(result.firstNumericChannel, 0);
  assert.equal(result.firstNumericQuantum, 0);
  assert.equal(result.firstNumericOffsetInQuantum, 1);
  assert.equal(result.lastNumeric, 1);
});

test("a bad first reference stays visible when later PCM is clean", () => {
  const bad = [pcm([NaN, 0.2]), pcm([0.1, 0.2])];
  const cleanLeft = pcm([0.1, 0.2]);
  const cleanRight = pcm([0.1, 0.2]);
  const result = comparePcm(cleanLeft, cleanRight, bad);
  assert.equal(result.reference.finite, false);
  assert.equal(result.candidate.finite, true);
  assert.equal(result.differentSamples, 1);
});

test("malformed or unequal PCM channels fail closed", () => {
  assert.throws(() => analyzePcm(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 3])), /complete Float32/);
  assert.throws(() => analyzePcm(pcm([0]), pcm([0, 1])), /different lengths/);
  assert.throws(() => comparePcm(pcm([0]), pcm([0]), [pcm([0, 1]), pcm([0, 1])]), /different lengths/);
});

test("lag diagnostics report a delayed candidate and exact aligned equality", () => {
  const left = signal(2048), right = left.map((value, i) => value * 0.7 + Math.sin(i * 0.11) * 0.05);
  const reference = [pcm(left), pcm(right)];
  const candidate = [pcm(shifted(left, 128)), pcm(shifted(right, 128))];
  const lag = correlateLag(candidate, reference, 512, 48000);
  assert.equal(lag.bestLagFrames, 128);
  assert.equal(lag.bestLagSeconds, 128 / 48000);
  assert.ok(lag.normalizedCorrelation > 0.999999);
  assert.ok(lag.channelCoefficients[0] > 0.999999);
  const aligned = compareAlignedPcm(candidate, reference, lag.bestLagFrames);
  assert.equal(aligned.comparison.differentSamples, 0);
  assert.equal(aligned.overlapSamplesPerChannel, 1920);
});

test("aligned lag diagnostics preserve a local transient difference", () => {
  const left = signal(2048), right = left.map((value, i) => value * 0.7 + Math.sin(i * 0.11) * 0.05);
  const candidateLeft = shifted(left, 128);
  candidateLeft[528] += 0.125;
  const reference = [pcm(left), pcm(right)];
  const candidate = [pcm(candidateLeft), pcm(shifted(right, 128))];
  const lag = correlateLag(candidate, reference, 512);
  assert.equal(lag.bestLagFrames, 128);
  const unaligned = comparePcm(candidate[0], candidate[1], reference);
  const aligned = compareAlignedPcm(candidate, reference, lag.bestLagFrames);
  assert.ok(unaligned.differentSamples > 1);
  assert.equal(aligned.comparison.differentSamples, 1);
  assert.equal(aligned.comparison.first, 400);
});

test("lag diagnostics do not infer a shift from numerical silence", () => {
  const silent = [pcm(new Array(128).fill(0)), pcm(new Array(128).fill(0))];
  assert.equal(correlateLag(silent, silent).status, "silent");
});

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function copyRows(rows) {
  return JSON.parse(JSON.stringify(rows));
}

function pairFixture(graph) {
  const sampleRate = 44100;
  const duration = 0.2;
  const outputBytes = Buffer.alloc(Math.ceil(duration * sampleRate) * 4);
  for (let offset = 0; offset < outputBytes.length; offset += 4) outputBytes.writeFloatLE(0.25, offset);
  const rightBytes = Buffer.from(outputBytes);
  const outputHash = sha256(Buffer.concat([outputBytes, rightBytes]));
  const sourceBytes = Buffer.alloc(Math.floor(sampleRate * 0.5) * 4);
  const sourceHash = sha256(sourceBytes);
  const operator = { w: "n0", v: 0.5, a: 0.2, d: 11, t: 0, f: 44, g: 0, h: 0.01, s: 0, r: 0.05, p: 1, q: 1, k: 0 };
  const settings = {
    masterGain: 0.5,
    channelVolume: 1.86000372000744,
    expression: 1,
    channelGain: 1.8600037097930908,
    pan: 0,
    pannerPresent: true,
    modulationGain: 0,
    bend: 0,
    lfoFrequency: 5,
    compressorPresent: true,
    compressorParameters: { threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 },
  };
  const makeSource = (includePcm) => ({
    operator: 0,
    wave: "n0",
    playbackRate: 0.10000000149011612,
    detune: 0,
    loop: true,
    loopStart: 0,
    loopEnd: 0,
    registeredBufferIdentity: graph === "library",
    sourceBufferIdentityMatches: true,
    bufferOwnership: graph === "library" ? "synth.noiseBuf[n0]" : "manual local AudioBuffer",
    graphSettings: settings,
    bufferSampleRate: sampleRate,
    bufferLength: Math.floor(sampleRate * 0.5),
    bufferHash32: "0000000000000000",
    bufferSha256: sourceHash,
    bufferFinite: true,
    bufferPeakAbsolute: 0,
    ...(includePcm ? { bufferPcm: sourceBytes.toString("base64") } : {}),
  });
  const metadata = {
    kind: "metadata",
    engine: "webkit",
    node: "v24.21.0",
    playwrightCore: "1.63.0",
    browserPath: "/tmp/noise-pair-test-browser",
    library: "source",
    graph,
    librarySourceSha256: "a".repeat(64),
    freshMinSha256: "b".repeat(64),
    sampleRate,
    quality: 0,
    program: 126,
    note: 60,
    velocity: 100,
    start: 0.05,
    hold: 0.07,
    duration,
    attemptsRequested: 2,
    noiseSeed: 0,
    noiseBufferVersion: 1,
    noiseBufferAlgorithm: "fmix32-mulberry32-n0-stream-1",
    noiseBufferSampleRate: sampleRate,
    noiseBufferFrames: Math.floor(sampleRate * 0.5),
    programOperators: [operator],
  };
  const attempts = [0, 1].map((trial) => ({
    kind: "attempt",
    trial,
    state: "rendered",
    firstAttempt: true,
    firstSuccessfullyRenderedPcm: trial === 0,
    renderMs: 1,
    pcmSha256: outputHash,
    comparisonReferenceTrial: 0,
    firstPcmReferenceSha256: outputHash,
    outputFinite: true,
    outputNonFiniteSamples: 0,
    outputPeakAbsolute: 0.25,
    outputFinitePeakAbsolute: 0.25,
    outputAllZero: false,
    disagreementWithFirstPcm: false,
    effectivePlaybackRates: [0.10000000149011612],
    sources: [makeSource(trial === 0)],
    nodes: {},
    ...(trial === 0 ? { leftPcm: outputBytes.toString("base64"), rightPcm: rightBytes.toString("base64") } : {}),
  }));
  const rows = [metadata, { kind: "browser", name: "webkit", version: "26.6" }, ...attempts, {
    kind: "summary",
    attemptsRequested: 2,
    rendered: 2,
    errors: 0,
    analysisErrors: 0,
    protocolErrors: 0,
    firstSuccessfullyRenderedTrial: 0,
    firstReferenceFinite: true,
    firstReferencePeakAbsolute: 0.25,
    disagreementsWithFirstPcm: 0,
    nonFiniteAttempts: 0,
    nonFiniteOutputSamples: 0,
    exactZeroOutputAttempts: 0,
  }];
  return { rows, outputBytes, rightBytes, outputHash, sourceBytes, sourceHash };
}

function runPairCli(libraryRows, manualRows) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "noise-pair-analysis-"));
  const libraryPath = path.join(temp, "library.jsonl");
  const manualPath = path.join(temp, "manual.jsonl");
  const outputPath = path.join(temp, "result.jsonl");
  const scriptPath = path.resolve(__dirname, "../../scripts/noise-path-pair-analysis.js");
  fs.writeFileSync(libraryPath, libraryRows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  fs.writeFileSync(manualPath, manualRows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const result = spawnSync(process.execPath, [
    scriptPath,
    "--library=" + libraryPath,
    "--manual=" + manualPath,
    "--out=" + outputPath,
  ], { encoding: "utf8" });
  let outputRows = [];
  if (fs.existsSync(outputPath)) outputRows = fs.readFileSync(outputPath, "utf8").trim().split("\n").map(JSON.parse);
  fs.rmSync(temp, { recursive: true, force: true });
  return { result, outputRows };
}

function runCaptureCli(rows) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "noise-capture-analysis-"));
  const capturePath = path.join(temp, "capture.jsonl");
  const outputPath = path.join(temp, "analysis.jsonl");
  const scriptPath = path.resolve(__dirname, "../../scripts/noise-path-capture-analysis.js");
  fs.writeFileSync(capturePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const result = spawnSync(process.execPath, [
    scriptPath,
    "--capture=" + capturePath,
    "--out=" + outputPath,
    "--evidence-root=" + temp,
  ], { encoding: "utf8" });
  let outputRows = [];
  if (fs.existsSync(outputPath)) outputRows = fs.readFileSync(outputPath, "utf8").trim().split("\n").map(JSON.parse);
  fs.rmSync(temp, { recursive: true, force: true });
  return { result, outputRows };
}

test("capture-analysis CLI validates first PCM and indexed attempts before reporting", () => {
  const fixture = pairFixture("library");
  const { result, outputRows } = runCaptureCli(fixture.rows);
  assert.equal(result.status, 0, result.stderr);
  const summary = outputRows.find((row) => row.kind === "summary");
  assert.equal(summary.attemptsRequested, 2);
  assert.equal(summary.numericDivergentAttempts, 0);

  const missing = copyRows(fixture.rows);
  missing.splice(missing.findIndex((row) => row.kind === "attempt" && row.trial === 1), 1);
  const rejected = runCaptureCli(missing);
  assert.notEqual(rejected.result.status, 0);
  assert.match(rejected.result.stderr, /does not contain every first attempt/);
});

test("capture-analysis CLI rejects promoted references, invalid duration, and contradictory PCM summaries", () => {
  const fixture = pairFixture("library");
  const promoted = copyRows(fixture.rows);
  const first = promoted.find((row) => row.kind === "attempt" && row.trial === 0);
  const second = promoted.find((row) => row.kind === "attempt" && row.trial === 1);
  first.firstSuccessfullyRenderedPcm = false;
  second.firstSuccessfullyRenderedPcm = true;
  second.leftPcm = fixture.outputBytes.toString("base64");
  second.rightPcm = fixture.rightBytes.toString("base64");
  const promotedSummary = promoted.find((row) => row.kind === "summary");
  promotedSummary.firstSuccessfullyRenderedTrial = 1;
  const promotedResult = runCaptureCli(promoted);
  assert.notEqual(promotedResult.result.status, 0);
  assert.match(promotedResult.result.stderr, /trial 0 as its first successfully rendered reference/);

  const invalidDuration = copyRows(fixture.rows);
  invalidDuration.find((row) => row.kind === "metadata").duration = null;
  const durationResult = runCaptureCli(invalidDuration);
  assert.notEqual(durationResult.result.status, 0);
  assert.match(durationResult.result.stderr, /bounded reducer contract/);

  const contradictory = copyRows(fixture.rows);
  contradictory.find((row) => row.kind === "attempt" && row.trial === 1).disagreementWithFirstPcm = true;
  const contradictionResult = runCaptureCli(contradictory);
  assert.notEqual(contradictionResult.result.status, 0);
  assert.match(contradictionResult.result.stderr, /disagreement flag differs/);

  const contradictorySummary = copyRows(fixture.rows);
  contradictorySummary.find((row) => row.kind === "summary").exactZeroOutputAttempts = 1;
  const summaryResult = runCaptureCli(contradictorySummary);
  assert.notEqual(summaryResult.result.status, 0);
  assert.match(summaryResult.result.stderr, /summary totals disagree/);
});

test("capture-analysis CLI retains the original numeric first-attempt disagreement", () => {
  const fixture = pairFixture("library");
  const rows = copyRows(fixture.rows);
  const changedLeft = Buffer.from(fixture.outputBytes);
  const unchangedRight = Buffer.from(fixture.rightBytes);
  changedLeft.writeFloatLE(0.5, 0);
  const changedAttempt = rows.find((row) => row.kind === "attempt" && row.trial === 1);
  changedAttempt.leftPcm = changedLeft.toString("base64");
  changedAttempt.rightPcm = unchangedRight.toString("base64");
  changedAttempt.pcmSha256 = sha256(Buffer.concat([changedLeft, unchangedRight]));
  changedAttempt.disagreementWithFirstPcm = true;
  rows.find((row) => row.kind === "summary").disagreementsWithFirstPcm = 1;
  const { result, outputRows } = runCaptureCli(rows);
  assert.equal(result.status, 0, result.stderr);
  const divergent = outputRows.find((row) => row.kind === "divergent-first-attempt");
  assert.equal(divergent.trial, 1);
  assert.equal(divergent.originalUnalignedDifference.numericDifferentSamples, 1);
  const summary = outputRows.find((row) => row.kind === "summary");
  assert.equal(summary.numericDivergentAttempts, 1);
  assert.equal(summary.eventRateClaim, "none");
});

test("pair-analysis CLI accepts complete indexed PCM with hash-verified reference fallback", () => {
  const library = pairFixture("library").rows;
  const manual = pairFixture("manual-chain").rows;
  const { result, outputRows } = runPairCli(library, manual);
  assert.equal(result.status, 0, result.stderr);
  const summary = outputRows.find((row) => row.kind === "summary");
  assert.equal(summary.pairsRequested, 2);
  assert.equal(summary.comparedPairs, 2);
  assert.equal(summary.graphSettingsMismatches, 0);
});

test("pair-analysis CLI rejects missing, half, malformed, or hash-mismatched PCM payloads", async (t) => {
  const validLibrary = pairFixture("library").rows;
  const validManual = pairFixture("manual-chain").rows;
  const faults = [
    {
      name: "divergent PCM omitted",
      mutate(rows, fixture) {
        const attempt = rows.find((row) => row.kind === "attempt" && row.trial === 1);
        const changed = Buffer.from(fixture.outputBytes);
        changed.writeFloatLE(0.5, 0);
        attempt.pcmSha256 = sha256(Buffer.concat([changed, fixture.rightBytes]));
      },
      error: /omits divergent PCM payload/,
    },
    {
      name: "one channel omitted",
      mutate(rows, fixture) {
        const attempt = rows.find((row) => row.kind === "attempt" && row.trial === 1);
        attempt.leftPcm = fixture.outputBytes.toString("base64");
      },
      error: /only one PCM channel/,
    },
    {
      name: "malformed channel length",
      mutate(rows) {
        const attempt = rows.find((row) => row.kind === "attempt" && row.trial === 1);
        const short = Buffer.alloc(4);
        short.writeFloatLE(0.25, 0);
        attempt.leftPcm = short.toString("base64");
        attempt.rightPcm = short.toString("base64");
        attempt.pcmSha256 = sha256(Buffer.concat([short, short]));
      },
      error: /channel length does not match/,
    },
    {
      name: "malformed base64 payload",
      mutate(rows, fixture) {
        const attempt = rows.find((row) => row.kind === "attempt" && row.trial === 1);
        attempt.leftPcm = "not-base64";
        attempt.rightPcm = fixture.rightBytes.toString("base64");
      },
      error: /not canonical base64/,
    },
    {
      name: "retained PCM hash mismatch",
      mutate(rows, fixture) {
        const attempt = rows.find((row) => row.kind === "attempt" && row.trial === 1);
        const changed = Buffer.from(fixture.outputBytes);
        changed.writeFloatLE(0.5, 0);
        attempt.leftPcm = changed.toString("base64");
        attempt.rightPcm = fixture.rightBytes.toString("base64");
      },
      error: /PCM SHA-256 does not match/,
    },
  ];
  for (const fault of faults) {
    await t.test(fault.name, () => {
      const library = copyRows(validLibrary);
      const manual = copyRows(validManual);
      fault.mutate(library, pairFixture("library"));
      const { result } = runPairCli(library, manual);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, fault.error);
    });
  }
});

test("pair-analysis CLI rejects incomplete/duplicate trial sets and multiple first references", async (t) => {
  const validLibrary = pairFixture("library").rows;
  const validManual = pairFixture("manual-chain").rows;
  const faults = [
    {
      name: "missing trial",
      mutate(rows) { rows.splice(rows.findIndex((row) => row.kind === "attempt" && row.trial === 1), 1); },
      error: /one attempt record per requested trial/,
    },
    {
      name: "duplicate trial identity",
      mutate(rows) {
        const attempt = rows.find((row) => row.kind === "attempt" && row.trial === 0);
        rows.splice(rows.findIndex((row) => row.kind === "summary"), 0, copyRows([attempt])[0]);
      },
      error: /one attempt record per requested trial|duplicate attempt trial/,
    },
    {
      name: "multiple first reference markers",
      mutate(rows) { rows.find((row) => row.kind === "attempt" && row.trial === 1).firstSuccessfullyRenderedPcm = true; },
      error: /exactly one successfully rendered first PCM reference/,
    },
  ];
  for (const fault of faults) {
    await t.test(fault.name, () => {
      const library = copyRows(validLibrary);
      fault.mutate(library);
      const { result } = runPairCli(library, copyRows(validManual));
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, fault.error);
    });
  }
});

test("pair-analysis CLI flags seed, buffer-version, effective-rate, and graph-setting mismatches", async (t) => {
  const validLibrary = pairFixture("library").rows;
  const validManual = pairFixture("manual-chain").rows;
  const faults = [
    {
      name: "noise seed mismatch",
      mutate(rows) { rows[0].noiseSeed = 9; },
      error: /capture metadata differs at noiseSeed/,
    },
    {
      name: "buffer version mismatch",
      mutate(rows) { rows[0].noiseBufferVersion = 2; },
      error: /capture metadata differs at noiseBufferVersion/,
    },
    {
      name: "effective playback-rate mismatch",
      mutate(rows) {
        for (const attempt of rows.filter((row) => row.kind === "attempt")) {
          attempt.effectivePlaybackRates = [0.2];
          attempt.sources[0].playbackRate = 0.2;
        }
      },
      summaryField: "playbackRateMismatches",
    },
    {
      name: "graph readback mismatch",
      mutate(rows) {
        for (const attempt of rows.filter((row) => row.kind === "attempt")) attempt.sources[0].graphSettings.channelGain += 0.01;
      },
      summaryField: "graphSettingsMismatches",
    },
  ];
  for (const fault of faults) {
    await t.test(fault.name, () => {
      const library = copyRows(validLibrary);
      const manual = copyRows(validManual);
      fault.mutate(manual);
      const { result, outputRows } = runPairCli(library, manual);
      assert.notEqual(result.status, 0);
      if (fault.error) assert.match(result.stderr, fault.error);
      else assert.ok(outputRows.find((row) => row.kind === "summary")[fault.summaryField] > 0);
    });
  }
});
