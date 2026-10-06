#!/usr/bin/env node
"use strict";

/* Reanalyze retained native first-attempt Float32 WAV evidence under the
 * separately versioned v6 full-mix feature method. This script never launches
 * a browser, edits a capture, or promotes a diagnostic repeat. */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const fullMix = require("../tests/browser/specs/full-mix");
const { MATRIX } = require("../tests/browser/matrix");
const matrix = require("./browser-matrix");
const browserToolchain = require("./browser-toolchain");

function hash(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function args(argv) {
  const out = {};
  for (const value of argv) {
    const m = /^--(input|out|reference-out)=(.+)$/.exec(value);
    if (!m) throw new Error("usage: node scripts/reanalyze-fullmix-v6.js --input=<v5-results-dir> --out=<json-path> [--reference-out=<json-path>]");
    out[m[1]] = path.resolve(m[2]);
  }
  if (!out.input || !out.out) throw new Error("both --input and --out are required");
  return out;
}

const REFERENCE_TOLERANCES = {
  overallDb: 0.001, peakAbs: 1e-6, windowFloor: 1e-8, windowDb: 0.001,
  noteWindowDb: 0.001, independentProbePitchCents: 35, downbeatBandDb: 0.001,
  probePitchCents: 0.1, transientEnvelopeDb: 0.001, balanceDb: 0.001,
  probeOnsetMs: 0.1, probeLevelDb: 0.001, probeEnvelopeDb: 0.001, relativeProbeDb: 0.001,
};

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}

const referenceToleranceSha256 = hash(Buffer.from(canonical(REFERENCE_TOLERANCES)));

function compactMetrics(metrics) {
  return {
    channels: Object.fromEntries(["left", "right"].map((side) => [side, {
      finite: metrics.channels[side].finite,
      nan: metrics.channels[side].nan,
      inf: metrics.channels[side].inf,
      songRms: metrics.channels[side].songRms,
      fullRenderPeak: metrics.channels[side].fullRenderPeak,
      windowLevels: metrics.channels[side].windowLevels.map(({ startSec, durationSec, rms, levelDb }) =>
        ({ startSec, durationSec, rms, levelDb })),
    }])),
    overall: {
      rms: metrics.overall.rms, peak: metrics.overall.peak, rawRenderRms: metrics.overall.rawRenderRms,
      channelBalanceDb: metrics.overall.channelBalanceDb, rawRenderBalanceDb: metrics.overall.rawRenderBalanceDb,
      overFullScaleSamples: metrics.overall.overFullScaleSamples,
    },
    notes: metrics.notes.map(({ id, windowRms }) => ({ id, windowRms })),
    transient: { noteId: metrics.transient.noteId, left: metrics.transient.left, right: metrics.transient.right },
    downbeat: {
      status: metrics.downbeat.status, noteId: metrics.downbeat.noteId,
      expectedPitch: metrics.downbeat.expectedPitch, targetHz: metrics.downbeat.targetHz,
      bandRms: metrics.downbeat.bandRms, leftBandRms: metrics.downbeat.leftBandRms,
      rightBandRms: metrics.downbeat.rightBandRms,
    },
    probes: metrics.probes.map(({ id, status, pitchCents, toneFractionDb, spectralPeakToGlobalDb,
      levelRms, onsetMs, envelope }) => ({ id, status, pitchCents, toneFractionDb, spectralPeakToGlobalDb,
      levelRms, onsetMs, envelope })),
    relativeProbeLevelDb: metrics.relativeProbeLevelDb,
    isolation: metrics.isolation.map(({ id, startSec, preProbeRms }) => ({ id, startSec, preProbeRms })),
    voiceDemand: metrics.voiceDemand,
  };
}

function makeReference(rows, reportSha256, matrixRun, historicalToolchain, env = process.env, root = path.resolve(__dirname, "..")) {
  const engines = {};
  const expectedCases = fullMix.referenceExpectedCases();
  const expectedCaseSet = new Set(expectedCases);
  const seenCases = new Set();
  const hasCurrentCaptureIdentity = (row) => {
    const fixture = fullMix.FIXTURE_BY_ID[row.fixtureId];
    return !!fixture && row.input?.captureMethodSha256 === fixture.methodSha256 &&
      row.input?.captureToleranceSha256 === fixture.toleranceSha256;
  };
  const hasPinnedSeed = (row) => row.seed === MATRIX.seed && row.matrixSeed === MATRIX.seed &&
    row.captureRun?.selection?.seed === MATRIX.seed && matrixRun?.selection?.seed === MATRIX.seed &&
    row.input?.settingsSha256 === fullMix.FIXTURE_BY_ID[row.fixtureId]?.settingsSha256;
  const canExport = (row) => row.referenceExportEligible === true && hasPinnedSeed(row) && hasCurrentCaptureIdentity(row);
  for (const row of rows) {
    const caseId = row.engine + "/" + row.fixtureId + "/" + row.sampleRate;
    if (!expectedCaseSet.has(caseId) || seenCases.has(caseId)) continue;
    seenCases.add(caseId);
    if (!canExport(row)) continue;
    const recordedToolchain = matrixRun.browserToolchain || null;
    const captureToolchain = recordedToolchain || historicalToolchain;
    const capturedBundle = matrix.browserBundle(captureToolchain, row.engine);
    if (capturedBundle.engine !== row.engine ||
        !browserToolchain.isPinnedBrowserBundle(capturedBundle, env, root) ||
        !browserToolchain.matchesBrowserVersion(capturedBundle, row.browserVersion))
      throw new Error("retained " + row.engine + " version differs from its Playwright bundle identity");
    if (recordedToolchain && JSON.stringify(recordedToolchain) !== JSON.stringify(historicalToolchain))
      throw new Error("current capture toolchain differs from the aggregate-resolved Playwright identity");
    const metadata = {
      scope: "fixture", fixtureId: row.fixtureId, profileKind: row.profileKind, quality: 1, seed: row.seed,
      engine: row.engine, browserVersion: row.browserVersion, platform: row.platform, sampleRate: row.sampleRate,
      browserBundle: capturedBundle,
      captureToolchain: {
        source: recordedToolchain ? "recorded-in-capture-matrixRun-browserToolchain" : "reconstructed-from-retained-v5-pinned-runner-toolchain",
        schemaVersion: 1,
        playwrightCoreVersion: captureToolchain.playwrightCoreVersion,
        browsersManifestSha256: captureToolchain.browsersManifestSha256,
        browserBundle: capturedBundle,
        ...(recordedToolchain ? {} : { limitation: "v5 results schema did not record Playwright/browser bundle identity; this reconstruction uses the retained pinned 1.63.0 package and browser installation identity, without editing the original report" }),
      },
      midiSha256: row.input.midiSha256, setupSha256: row.input.setupSha256,
      settingsSha256: row.input.settingsSha256, probePlanSha256: row.input.probePlanSha256,
      methodSha256: fullMix.FIXTURE_BY_ID[row.fixtureId].methodSha256,
      toleranceSha256: fullMix.FIXTURE_BY_ID[row.fixtureId].toleranceSha256,
      referenceToleranceSha256,
      playbackOriginSec: row.input.playbackOriginSec,
      captureRun: matrixRun, captureReportSha256: reportSha256,
      captureMethodSha256: row.input.captureMethodSha256,
      captureToleranceSha256: row.input.captureToleranceSha256,
      rawCaptureAnalysis: recordedToolchain
        ? "offline v6 analysis of preserved first-attempt Float32 WAV; no rerender or metadata relabel"
        : "v6 reanalysis of preserved v5 first-attempt Float32 WAV; no rerender or metadata relabel",
    };
    const pair = { metadata };
    for (const build of ["source", "min"]) {
      const capture = row.builds[build].first;
      pair[build] = {
        capture: {
          path: capture.path, sha256: capture.sha256, pcmSha256: capture.pcmSha256,
          bytes: capture.bytes, frames: capture.frames, sampleRate: capture.sampleRate,
          attempt: 1, firstAttempt: true, eligible: true,
          finite: capture.finite, overFullScaleSamples: capture.overFullScaleSamples,
          priorCaptureVerdict: row.builds[build].priorResult,
          captureMethodSha256: row.input.captureMethodSha256,
        },
        metrics: compactMetrics(capture.metrics),
      };
    }
    if (!engines[row.engine]) engines[row.engine] = {};
    if (!engines[row.engine][row.fixtureId]) engines[row.engine][row.fixtureId] = {};
    engines[row.engine][row.fixtureId][row.sampleRate] = pair;
  }
  const measuredCases = rows.filter(canExport)
    .map((row) => row.engine + "/" + row.fixtureId + "/" + row.sampleRate)
    .filter((id, index, all) => expectedCaseSet.has(id) && all.indexOf(id) === index).sort();
  const incompleteCases = rows.filter((row) => !canExport(row)).map((row) => ({
    id: row.engine + "/" + row.fixtureId + "/" + row.sampleRate,
    firstAttemptStatus: row.firstAttemptStatus,
    reason: row.fixtureId === "ws-mid-default" && row.engine === "webkit" && row.sampleRate === 48000
      ? "first attempt failed: source and min raw WAVs each contain two over-full-scale channel samples in one frame; a diagnostic repeat retains the same frame and cannot promote attempt 1"
      : row.referenceExportEligible && !hasPinnedSeed(row)
        ? "retained matrix seed or fixture settings identity differs from the independently pinned matrix seed"
        : row.referenceExportEligible && !hasCurrentCaptureIdentity(row)
          ? "original capture method/tolerance identity differs from the current fixture contract"
          : row.referenceEligibilityReason || "row did not pass independent first-attempt reference export eligibility",
  }));
  for (const id of expectedCases) {
    const count = rows.filter((row) => row.engine + "/" + row.fixtureId + "/" + row.sampleRate === id).length;
    if (count !== 1) incompleteCases.push({
      id, firstAttemptStatus: "incomplete",
      reason: count === 0 ? "no retained first-attempt row was supplied" : "duplicate first-attempt rows were supplied",
    });
  }
  for (const row of rows) {
    const id = row.engine + "/" + row.fixtureId + "/" + row.sampleRate;
    if (!expectedCaseSet.has(id)) incompleteCases.push({ id, firstAttemptStatus: "incomplete", reason: "row is outside the declared full-mix matrix" });
  }
  return {
    schemaVersion: 2, scope: "fixture", status: incompleteCases.length ? "incomplete" : "complete",
    analysisVersion: fullMix.ANALYSIS_VERSION, methodSha256: fullMix.FIXTURES[0].methodSha256,
    toleranceSha256: fullMix.FIXTURES[0].toleranceSha256, referenceToleranceSha256,
    coverage: { expectedCases, measuredCases, incompleteCases },
    tolerances: REFERENCE_TOLERANCES, engines,
  };
}

function pcmHash(channels) {
  return hash(Buffer.concat(channels.map((x) => Buffer.from(x.buffer, x.byteOffset, x.byteLength))));
}

function overFullScaleFrames(channels) {
  const byFrame = new Map();
  channels.forEach((channel, channelIndex) => channel.forEach((value, frame) => {
    if (Number.isFinite(value) && Math.abs(value) > 1) {
      const row = byFrame.get(frame) || { frame, channels: {} };
      row.channels[channelIndex === 0 ? "left" : "right"] = {
        value,
        nearby: Array.from({ length: 5 }, (_, i) => channel[frame + i - 2] || 0),
      };
      byFrame.set(frame, row);
    }
  }));
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

function readAttempt(reportDir, engine, fixture, sampleRate, build, attempt, sourceRef) {
  const artifact = attempt === 1 ? sourceRef.artifact : sourceRef.diagnosticRepeat && sourceRef.diagnosticRepeat.artifact;
  const attemptName = attempt === 1 ? "first" : attempt === 2 ? "diagnostic-repeat" : null;
  if (!attemptName) throw new Error("unsupported retained full-mix attempt " + String(attempt));
  const expectedPath = path.posix.join("full-mix", fixture.id + "-q1-" + sampleRate + "-" + build + "-" + attemptName + ".wav");
  if (!artifact || artifact.path !== expectedPath)
    throw new Error(engine + " " + fixture.id + " " + sampleRate + " " + build + " attempt " + attempt +
      " artifact path must be exactly " + expectedPath);
  if (!artifact || typeof artifact.path !== "string" || artifact.saved !== true ||
      artifact.sampleRate !== sampleRate || artifact.channels !== 2 || artifact.encoding !== "WAVE_FORMAT_IEEE_FLOAT")
    throw new Error(engine + " " + fixture.id + " " + sampleRate + " " + build + " attempt " + attempt + " lacks a retained stereo Float32 artifact");
  const expectedFrames = Math.ceil(fixture.renderDurationSec * sampleRate);
  const expectedByteLength = 44 + expectedFrames * 8;
  const shardRoot = path.join(reportDir, engine);
  const bytes = matrix.readArtifactUnderShard(shardRoot, artifact.path, expectedByteLength);
  const raw = matrix.parseFloatStereoWav(bytes, sampleRate, expectedFrames);
  const rawSha256 = hash(raw.bytes), planarPcmSha256 = pcmHash(raw.channels);
  if (rawSha256 !== artifact.sha256 || raw.bytes.length !== artifact.bytes || planarPcmSha256 !== artifact.pcmSha256)
    throw new Error("raw artifact metadata does not match bytes: " + path.join(engine, artifact.path));
  const metrics = fullMix.analyzeChannels(raw.channels, sampleRate, fixture);
  const finite = raw.channels.every((x) => fullMixFinite(x));
  return {
    attempt, firstAttempt: attempt === 1, role: attempt === 1 ? "first-attempt" : "diagnostic-only",
    path: engine + "/" + artifact.path, sha256: rawSha256, pcmSha256: planarPcmSha256,
    bytes: raw.bytes.length, frames: expectedFrames, sampleRate, finite,
    peak: metrics.overall.peak, overFullScaleSamples: metrics.overall.overFullScaleSamples,
    overFullScaleFrames: overFullScaleFrames(raw.channels), metrics, channels: raw.channels,
  };
}

function fullMixFinite(channel) {
  for (let i = 0; i < channel.length; ++i) if (!Number.isFinite(channel[i])) return false;
  return true;
}

function checkPass(caseRow, name) {
  const found = Array.isArray(caseRow.checks) ? caseRow.checks.filter((check) => check && check.name === name) : [];
  return found.length === 1 && found[0].ok === true;
}

function sameJson(a, b) {
  return canonical(a) === canonical(b);
}

function noteTimingComplete(obs, fixture) {
  const timing = obs && obs.noteTiming;
  return fixture.timingComplete === true && !!timing && timing.complete === fixture.timingComplete &&
    timing.unmatchedNoteOffs === fixture.unmatchedNoteOffs &&
    timing.unpitchedOneShotCount === fixture.unpitchedOneShotCount &&
    timing.ambiguousPairings === fixture.notes.filter((n) => n.pairingAmbiguous).length &&
    timing.durationUnknown === fixture.notes.filter((n) => n.durationSec === null).length;
}

function currentFixtureIdentity(obs, fixture, engine, engineReport) {
  const input = obs && obs.input;
  return obs.engine === engine && obs.browserVersion === engineReport.version && obs.platform === engineReport.platform &&
    obs.scope === "fixture" && obs.qualification === "fixture-only-no-production-approval" &&
    obs.fixtureId === fixture.id && obs.profileKind === fixture.profileKind && obs.quality === 1 && obs.seed === MATRIX.seed &&
    obs.midiSha256 === fixture.midiSha256 && obs.setupSha256 === fixture.setupSha256 &&
    obs.settingsSha256 === fixture.settingsSha256 && obs.probePlanSha256 === fixture.probePlanSha256 &&
    obs.methodSha256 === fixture.methodSha256 && obs.toleranceSha256 === fixture.toleranceSha256 &&
    obs.playbackOriginSec === fullMix.ORIGIN && obs.masterVol === fixture.settings.masterVol &&
    obs.reverbLev === fixture.settings.reverbLev && obs.songEndSec === fixture.songEndSec &&
    obs.durationSec === fixture.renderDurationSec && sameJson(obs.setupProvenance, fixture.setupProvenance) &&
    !!input && sameJson(input.setupProvenance, fixture.setupProvenance) &&
    input.noteCount === fixture.notes.length &&
    input.midiPath === (fixture.id === "tinychip-ws-mid" ? "tests/fixtures/consumer/waves-song.mid" : "ws.mid");
}

function producerBuildStatusConsistent(capture) {
  if (!capture || typeof capture.preBaselineEligible !== "boolean" ||
      !["pass", "fail", "incomplete"].includes(capture.result)) return false;
  if (!capture.preBaselineEligible) return capture.result === "fail";
  if (capture.result === "incomplete") return capture.referenceStatus === undefined || capture.referenceStatus === "incomplete";
  if (capture.result === "pass") return capture.referenceStatus === "measured" &&
    Array.isArray(capture.comparisonProblems) && capture.comparisonProblems.length === 0;
  return capture.referenceStatus === "measured" && Array.isArray(capture.comparisonProblems) &&
    capture.comparisonProblems.length > 0;
}

function producerSummaryConsistent(obs, sourceMin) {
  const derived = fullMix.deriveFullMixStatus(obs && obs.builds, sourceMin.ok);
  return sameJson(derived, {
    captureEligiblePreBaseline: obs && obs.captureEligiblePreBaseline,
    status: obs && obs.status,
  });
}

function pairRows(report, reportDir, { env = process.env, root = path.resolve(__dirname, "..") } = {}) {
  if (typeof reportDir !== "string" || !reportDir) throw new Error("pairRows requires the retained report directory");
  const resolvedToolchain = matrix.resolveBrowserToolchain(env);
  const recordedToolchain = report.matrixRun && report.matrixRun.browserToolchain;
  const toolchainMatches = !!recordedToolchain && sameJson(recordedToolchain, resolvedToolchain);
  const rows = [];
  for (const engine of ["chromium", "firefox", "webkit"]) {
    const engineReport = report[engine];
    if (!engineReport || !Array.isArray(engineReport.cases)) throw new Error("matrix report missing engine " + engine);
    for (const c of engineReport.cases) {
      const obs = c && c.observations && c.observations.fullMix;
      if (!obs) continue;
      const fixture = fullMix.FIXTURE_BY_ID[obs.fixtureId];
      if (!fixture || ![44100, 48000].includes(obs.sampleRate)) throw new Error("v5 report has an undeclared full-mix case " + String(c && c.id));
      const currentMethod = obs.methodSha256 === fixture.methodSha256 && obs.toleranceSha256 === fixture.toleranceSha256;
      const matrixSeed = report.matrixRun && report.matrixRun.selection && report.matrixRun.selection.seed;
      const pinnedMatrixSeed = matrixSeed === MATRIX.seed && obs.seed === MATRIX.seed;
      const builds = {};
      for (const build of ["source", "min"]) {
        const row = obs.builds && obs.builds[build];
        const diagnostic = row && row.diagnosticRepeat;
        if (!row || row.attempt !== 1 || row.firstAttempt !== true || !diagnostic ||
            diagnostic.attempt !== 2 || diagnostic.role !== "diagnostic-only" ||
            diagnostic.neverPromotesFirstAttempt !== true || diagnostic.firstVerdict !== row.result ||
            !["captured", "incomplete"].includes(diagnostic.result))
          throw new Error(c.id + " " + build + " does not preserve attempt 1 and diagnostic repeat roles");
        if (diagnostic.result === "incomplete" &&
            (typeof diagnostic.error !== "string" || diagnostic.error.length === 0))
          throw new Error(c.id + " " + build + " incomplete diagnostic repeat must preserve a nonempty error");
        if (diagnostic.result === "captured" &&
            (!diagnostic.metrics || typeof diagnostic.metrics !== "object" || Array.isArray(diagnostic.metrics) ||
             !diagnostic.sameEnginePcm || typeof diagnostic.sameEnginePcm !== "object" || Array.isArray(diagnostic.sameEnginePcm) ||
             typeof diagnostic.sameEnginePcm.ok !== "boolean" ||
             !["identical", "summation", "mismatch"].includes(diagnostic.sameEnginePcm.category) ||
             !(Number.isFinite(diagnostic.sameEnginePcm.maxDiff) || diagnostic.sameEnginePcm.maxDiff === null) ||
             !Number.isFinite(diagnostic.sameEnginePcm.tolerance) ||
             !Number.isSafeInteger(diagnostic.sameEnginePcm.firstDifferingSample) ||
             !Array.isArray(diagnostic.sameEnginePcm.reasons) ||
             diagnostic.sameEnginePcm.reasons.some((reason) => typeof reason !== "string")))
          throw new Error(c.id + " " + build + " captured diagnostic repeat evidence is malformed");
        const first = readAttempt(reportDir, engine, fixture, obs.sampleRate, build, 1, row);
        const reportedMetrics = row.metrics;
        const reportedMetricsPresent = !!reportedMetrics && typeof reportedMetrics === "object" && !Array.isArray(reportedMetrics);
        const reportedMetricsSha256 = reportedMetrics === undefined
          ? null : hash(Buffer.from(canonical(reportedMetrics)));
        const firstMetricsMatch = currentMethod && reportedMetricsPresent && sameJson(reportedMetrics, first.metrics);
        const firstMetricsStatus = !currentMethod ? "prior-method"
          : !reportedMetricsPresent ? "missing" : firstMetricsMatch ? "matched" : "mismatch";
        const repeat = diagnostic.result === "captured"
          ? readAttempt(reportDir, engine, fixture, obs.sampleRate, build, 2, row)
          : null;
        const firstVsRepeat = repeat ? fullMix.sameEnginePcm(first.channels, repeat.channels, engine) : null;
        if (repeat && currentMethod && !sameJson(diagnostic.metrics, repeat.metrics))
          throw new Error(c.id + " " + build + " diagnostic metrics differ from retained repeat WAV");
        if (repeat && currentMethod && !sameJson(diagnostic.sameEnginePcm, firstVsRepeat))
          throw new Error(c.id + " " + build + " diagnostic PCM comparison differs from retained first/repeat WAVs");
        builds[build] = {
          priorResult: row.result,
          priorPreBaselineEligible: row.preBaselineEligible === true,
          firstMetricsEvidence: {
            status: firstMetricsStatus, reportedPresent: reportedMetricsPresent,
            reportedSha256: reportedMetricsSha256,
            recomputedSha256: hash(Buffer.from(canonical(first.metrics))),
            matchesCurrentMethodWav: firstMetricsMatch,
          },
          first,
          repeat,
          diagnosticRepeat: {
            attempt: diagnostic.attempt,
            role: diagnostic.role,
            result: diagnostic.result,
            firstVerdict: diagnostic.firstVerdict,
            neverPromotesFirstAttempt: diagnostic.neverPromotesFirstAttempt,
            error: diagnostic.result === "incomplete" ? diagnostic.error : null,
            artifactPath: repeat ? repeat.path : null,
            reportedMetricsSha256: repeat ? hash(Buffer.from(canonical(diagnostic.metrics))) : null,
            recomputedMetricsSha256: repeat ? hash(Buffer.from(canonical(repeat.metrics))) : null,
            reportedComparisonSha256: repeat ? hash(Buffer.from(canonical(diagnostic.sameEnginePcm))) : null,
            recomputedComparisonSha256: repeat ? hash(Buffer.from(canonical(firstVsRepeat))) : null,
            priorMethodEvidence: !currentMethod,
          },
        };
        builds[build].firstVsRepeat = firstVsRepeat;
      }
      const sourceChannels = builds.source.first.channels;
      const minChannels = builds.min.first.channels;
      const sourceMin = fullMix.sameEnginePcm(sourceChannels, minChannels, engine);
      const comparisonEvidenceFor = (owner, key) => {
        const present = !!owner && typeof owner === "object" && !Array.isArray(owner) && Object.hasOwn(owner, key);
        const reported = present ? owner[key] : undefined;
        const serialized = reported === undefined ? null : canonical(reported);
        return {
          present,
          reported: reported === undefined ? null : reported,
          reportedSha256: typeof serialized === "string" ? hash(Buffer.from(serialized)) : null,
          matchesRecomputed: present && reported !== undefined && sameJson(sourceMin, reported),
        };
      };
      const firstSourceMinPcmComparisonEvidence = {
        recomputedSha256: hash(Buffer.from(canonical(sourceMin))),
        topLevel: comparisonEvidenceFor(obs, "sourceMinPcmComparison"),
        builds: Object.fromEntries(["source", "min"].map((build) => [build,
          comparisonEvidenceFor(obs.builds && obs.builds[build], "sourceMinPcmComparison")])),
      };
      const sourceMinComparisonsMatch = firstSourceMinPcmComparisonEvidence.topLevel.matchesRecomputed &&
        ["source", "min"].every((build) => firstSourceMinPcmComparisonEvidence.builds[build].matchesRecomputed);
      const producerStatusMatches = producerSummaryConsistent(obs, sourceMin);
      const expectedBundle = matrix.browserBundle(resolvedToolchain, engine);
      const currentBundleIdentity = toolchainMatches && sameJson(obs.browserBundle, expectedBundle) &&
        expectedBundle.engine === engine && browserToolchain.isPinnedBrowserBundle(expectedBundle, env, root) &&
        browserToolchain.matchesBrowserVersion(expectedBundle, engineReport.version);
      const captureCheckEvidence = Object.fromEntries(["source", "min"].map((build) => {
        const capture = obs.builds[build], first = builds[build].first;
        const probes = first.metrics.probes;
        let recomputedFault = null;
        try {
          if (matrix.nativeNoteEvidenceComplete(capture.noteInstances, fixture, obs.sampleRate))
            recomputedFault = fullMix.faultSensitivity(first.channels, obs.sampleRate, fixture, first.metrics, capture.noteInstances);
        } catch { /* malformed native evidence remains ineligible */ }
        const faultMatchesCurrentMethod = currentMethod && !!recomputedFault && recomputedFault.checksPass === true &&
          sameJson(capture.faultSensitivity, recomputedFault);
        const priorMethodEvidence = !currentMethod;
        const reportedFault = capture.faultSensitivity;
        const reportedFaultSha256 = reportedFault === undefined ? null : hash(Buffer.from(canonical(reportedFault)));
        const checks = {
          pinnedMatrixSeed,
          currentFixtureIdentity: currentFixtureIdentity(obs, fixture, engine, engineReport),
          reportedFirstMetricsMatchRecomputedWav: builds[build].firstMetricsEvidence.matchesCurrentMethodWav,
          reportedFirstSourceMinPcmComparisonMatchesRecomputed:
            firstSourceMinPcmComparisonEvidence.topLevel.matchesRecomputed &&
            firstSourceMinPcmComparisonEvidence.builds[build].matchesRecomputed,
          currentBrowserBundleIdentity: currentBundleIdentity,
          finiteFirstPcm: first.finite && first.metrics.channels.left.finite && first.metrics.channels.right.finite,
          fullScaleFirstPcm: first.overFullScaleSamples === 0 && first.peak <= 1,
          independentNoteSourceMap: matrix.nativeNoteEvidenceComplete(capture.noteInstances, fixture, obs.sampleRate),
          independentProbeSourceMap: matrix.nativeProbeEvidenceComplete(capture.probeInstances, fixture, obs.sampleRate),
          intendedIsolatedPitchAndEnvelope: probes.length === fixture.probes.length && probes.every((probe, i) =>
            probe.id === fixture.probes[i].id && probe.status === "measured" && Number.isFinite(probe.pitchCents) &&
            Math.abs(probe.pitchCents) <= fullMix.PROBE_PITCH_LIMIT_CENTS &&
            Number.isFinite(probe.toneFractionDb) && probe.toneFractionDb >= -12 &&
            Number.isFinite(probe.spectralPeakToGlobalDb) && probe.spectralPeakToGlobalDb >= -36 &&
            Number.isFinite(probe.onsetMs) && probe.levelRms > 0 && Array.isArray(probe.envelope) && probe.envelope.length === 40),
          isolatedQuietSeparation: first.metrics.isolation.length === fixture.probes.length &&
            first.metrics.isolation.every((x) => Number.isFinite(x.preProbeRms) && x.preProbeRms <= 1e-5),
          completeNativeTiming: noteTimingComplete(obs, fixture),
          nativeFaultSensitivity: faultMatchesCurrentMethod,
          currentCaptureMethod: currentMethod,
          noSchedulerPageOrNetworkError: matrix.firstAttemptPageClean(capture, c.checks, build),
          producerPreBaselineGate: capture.preBaselineEligible === true &&
            checkPass(c, build + " first attempt is eligible for native reference capture before comparison"),
          producerStatusShape: producerBuildStatusConsistent(capture),
          producerAggregateStatus: producerStatusMatches,
        };
        return [build, { ...checks, firstMetricsEvidence: builds[build].firstMetricsEvidence,
          originalFaultSensitivity: reportedFault || null,
          originalFaultSummarySha256: reportedFaultSha256, recomputedFault, priorMethodEvidence }];
      }));
      const sourceMinPcmEligible = sourceMin.ok && sourceMinComparisonsMatch &&
        checkPass(c, "source and fresh-min first-attempt raw PCM match without alignment");
      const captureGateChecks = Object.fromEntries(Object.entries(captureCheckEvidence).map(([build, checks]) => [build,
        Object.fromEntries(Object.entries(checks).filter(([name, value]) =>
          typeof value === "boolean" && !["priorMethodEvidence"].includes(name)))]));
      const independentlyEligible = Object.values(captureGateChecks).every((checks) => Object.values(checks).every(Boolean)) &&
        sourceMinPcmEligible;
      const priorFirstFailure = ["source", "min"].some((build) => builds[build].priorResult === "fail");
      const preBaselineEligible = independentlyEligible && !priorFirstFailure;
      const eligibilityReasons = [];
      for (const [build, checks] of Object.entries(captureGateChecks)) for (const [name, ok] of Object.entries(checks))
        if (typeof ok === "boolean" && !ok) eligibilityReasons.push(build + ": " + name);
      if (!sourceMinPcmEligible) eligibilityReasons.push("source/min first-attempt PCM differs or producer comparison does not match raw samples");
      if (priorFirstFailure) eligibilityReasons.push("producer retained a first-attempt fail; a later or offline reanalysis cannot promote it");
      if (!currentMethod) eligibilityReasons.push("retained capture method/tolerance differs from the current hashed fixture contract");
      if (captureCheckEvidence.source.priorMethodEvidence || captureCheckEvidence.min.priorMethodEvidence)
        eligibilityReasons.push("prior-method fault summaries are historical; missing current-method page/fault evidence cannot certify a current reference");
      const referenceExportEligible = preBaselineEligible && ["source", "min"].every((build) =>
        builds[build].priorResult === "pass" || builds[build].priorResult === "incomplete");
      const referenceEligibilityReason = !preBaselineEligible
        ? "one or more current first-attempt integrity, method, native identity/timing, page or fault gates are incomplete or failed"
        : referenceExportEligible ? null : "a first-attempt engine/build comparison failed; it cannot be exported as a new reference";
      rows.push({
        id: c.id, engine, browserVersion: engineReport.version, platform: engineReport.platform,
        fixtureId: fixture.id, profileKind: fixture.profileKind, sampleRate: obs.sampleRate, quality: obs.quality,
        scope: obs.scope, seed: obs.seed, matrixSeed: matrixSeed === undefined ? null : matrixSeed, input: {
          midiSha256: obs.midiSha256, setupSha256: obs.setupSha256, settingsSha256: obs.settingsSha256,
          probePlanSha256: obs.probePlanSha256, playbackOriginSec: obs.playbackOriginSec,
          captureMethodSha256: obs.methodSha256, captureToleranceSha256: obs.toleranceSha256,
        },
        captureRun: report.matrixRun,
        browserBundle: obs.browserBundle || null,
        currentToolchainMatches: toolchainMatches,
        captureSetupProvenance: obs.setupProvenance,
        independentVoiceEvidence: Object.fromEntries(["source", "min"].map((build) => [build, {
          expected: obs.builds[build].noteInstances && obs.builds[build].noteInstances.expectedCount,
          created: obs.builds[build].noteInstances && obs.builds[build].noteInstances.createdCount,
          pruned: obs.builds[build].noteInstances && Array.isArray(obs.builds[build].noteInstances.prunedInstances)
            ? obs.builds[build].noteInstances.prunedInstances.length : null,
          probeExpected: obs.builds[build].probeInstances && obs.builds[build].probeInstances.expectedCount,
          probeCreated: obs.builds[build].probeInstances && obs.builds[build].probeInstances.createdCount,
        }])),
        nativeVoiceRows: Object.fromEntries(["source", "min"].map((build) => [build, {
          notes: obs.builds[build].noteInstances && obs.builds[build].noteInstances.rows,
          probes: obs.builds[build].probeInstances && obs.builds[build].probeInstances.rows,
          pruned: obs.builds[build].noteInstances && obs.builds[build].noteInstances.prunedInstances,
        }])),
        builds, sourceMinPcmComparison: sourceMin,
        firstSourceMinPcmComparisonEvidence,
        reportedSourceMinPcmComparisonMatches: firstSourceMinPcmComparisonEvidence.topLevel.matchesRecomputed,
        reportedFirstSourceMinPcmComparisonsMatch: sourceMinComparisonsMatch,
        producerAggregateStatusMatches: producerStatusMatches,
        preBaselineEligible, independentlyEligible, referenceExportEligible,
        captureCheckEvidence, eligibilityReasons,
        firstAttemptStatus: preBaselineEligible ? "eligible" : priorFirstFailure ||
          !captureCheckEvidence.source.fullScaleFirstPcm || !captureCheckEvidence.min.fullScaleFirstPcm ? "fail" : "incomplete",
        originalCaptureVerdict: Object.fromEntries(["source", "min"].map((build) => [build, builds[build].priorResult])),
        referenceEligibilityReason,
      });
      const firstDefect = ["source", "min"].map((build) => builds[build].first)
        .find((capture) => capture.overFullScaleFrames.length);
      if (firstDefect) {
        const frame = firstDefect.overFullScaleFrames[0].frame, atSec = frame / obs.sampleRate;
        const expectedNotes = fixture.notes.filter((note) => note.onsetSec <= atSec && (note.offSec === null || note.offSec > atSec));
        const actualRows = obs.builds.source.noteInstances && obs.builds.source.noteInstances.rows || [];
        rows[rows.length - 1].activeNativeVoiceMapAtFirstOverFullScaleFrame = {
          seconds: atSec,
          independentExpectedNotes: expectedNotes.map((note) => ({
            id: note.id, channel: note.channel, pitch: note.pitch, velocity: note.velocity,
            program: note.program, onsetSec: note.onsetSec, offSec: note.offSec,
          })),
          instrumentedSources: actualRows.filter((row) => expectedNotes.some((note) => note.id === row.id)),
          note: "event/source creation proves mapped native voice creation, not audibility or causal attribution",
        };
      }
      for (const build of ["source", "min"]) {
        delete builds[build].first.channels;
        if (builds[build].repeat) delete builds[build].repeat.channels;
      }
    }
  }
  return rows;
}

function main(argv) {
  const argsv = args(argv);
  const reportFile = path.join(argsv.input, "results.json");
  const reportBytes = fs.readFileSync(reportFile);
  const report = JSON.parse(reportBytes.toString("utf8"));
  if (!report.matrixRun || !report.matrixRun.selection || !report.matrixRun.selection.specs.includes("full-mix"))
    throw new Error("input results are not a retained full-mix matrix run");
  const rows = pairRows(report, argsv.input);
  const historicalToolchain = matrix.resolveBrowserToolchain();
  const expected = fullMix.referenceExpectedCases();
  const actual = rows.map((row) => row.engine + "/" + row.fixtureId + "/" + row.sampleRate).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected.slice().sort()))
    throw new Error("input run is missing or duplicates declared engine/fixture/rate cases");
  const eligible = rows.filter((row) => row.referenceExportEligible).map((row) => row.engine + "/" + row.fixtureId + "/" + row.sampleRate).sort();
  const ineligible = rows.filter((row) => !row.referenceExportEligible).map((row) => ({
    id: row.engine + "/" + row.fixtureId + "/" + row.sampleRate,
    firstAttemptStatus: row.firstAttemptStatus, reason: row.referenceEligibilityReason,
  }));
  const result = {
    schemaVersion: 1, scope: "fixture", reportKind: "offline-reanalysis-no-rerender-no-promotion",
    analysisVersion: fullMix.ANALYSIS_VERSION, methodSha256: fullMix.FIXTURES[0].methodSha256,
    toleranceSha256: fullMix.FIXTURES[0].toleranceSha256, referenceToleranceSha256,
    referenceToleranceDerivation: "eligible first-attempt versus retained diagnostic-repeat features: max window drift 0.0003422 dB, max note-window 0.00000773 dB, max transient envelope 0.00000270 dB, max downbeat projection 0.000000612 dB, max peak delta 1.78814e-7; tighter measured features retain modest bounded floors; 35-cent isolated pitch threshold is the independently justified normative policy",
    capture: { reportPath: "results.json", reportSha256: hash(reportBytes), matrixRun: report.matrixRun,
      toolchain: report.matrixRun.browserToolchain || historicalToolchain,
      toolchainSource: report.matrixRun.browserToolchain ? "recorded-in-capture-matrixRun-browserToolchain" : "reconstructed-from-retained-v5-pinned-runner-toolchain" },
    expectedCases: expected, rows, coverage: {
      expected: expected.length, eligible: eligible.length, status: eligible.length === expected.length ? "complete" : "incomplete",
      eligibleCases: eligible, incompleteCases: ineligible,
    },
  };
  fs.mkdirSync(path.dirname(argsv.out), { recursive: true });
  fs.writeFileSync(argsv.out, JSON.stringify(result, null, 2) + "\n");
  if (argsv["reference-out"]) {
    const reference = makeReference(rows, result.capture.reportSha256, report.matrixRun, historicalToolchain);
    fs.mkdirSync(path.dirname(argsv["reference-out"]), { recursive: true });
    fs.writeFileSync(argsv["reference-out"], JSON.stringify(reference, null, 2) + "\n");
    result.reference = { path: argsv["reference-out"], status: reference.status,
      measured: reference.coverage.measuredCases.length, expected: reference.coverage.expectedCases.length };
    fs.writeFileSync(argsv.out, JSON.stringify(result, null, 2) + "\n");
  }
  console.log("v6 offline reanalysis: " + rows.length + " engine/fixture/rate cases, " + eligible.length + "/" + expected.length + " reference-eligible; " + argsv.out);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { pairRows, makeReference, main, REFERENCE_TOLERANCES };
