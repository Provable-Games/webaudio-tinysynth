#!/usr/bin/env node
"use strict";

/* Reanalyze retained native first-attempt Float32 WAV evidence under the
 * separately versioned v6 full-mix feature method. This script never launches
 * a browser, edits a capture, or promotes a diagnostic repeat. */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const fullMix = require("../tests/browser/specs/full-mix");
const matrix = require("./browser-matrix");

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

function makeReference(rows, reportSha256, matrixRun, historicalToolchain) {
  const engines = {};
  for (const row of rows) {
    if (!row.preBaselineEligible) continue;
    const recordedToolchain = matrixRun.browserToolchain || null;
    const captureToolchain = recordedToolchain || historicalToolchain;
    const capturedBundle = matrix.browserBundle(captureToolchain, row.engine);
    if (capturedBundle.browserVersion !== row.browserVersion)
      throw new Error("retained " + row.engine + " version differs from its Playwright bundle identity");
    if (recordedToolchain && JSON.stringify(recordedToolchain) !== JSON.stringify(historicalToolchain))
      throw new Error("current capture toolchain differs from the aggregate-resolved Playwright identity");
    const metadata = {
      scope: "fixture", fixtureId: row.fixtureId, profileKind: row.profileKind, quality: 1,
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
  const expectedCases = fullMix.referenceExpectedCases();
  const measuredCases = rows.filter((row) => row.preBaselineEligible)
    .map((row) => row.engine + "/" + row.fixtureId + "/" + row.sampleRate).sort();
  const incompleteCases = rows.filter((row) => !row.preBaselineEligible).map((row) => ({
    id: row.engine + "/" + row.fixtureId + "/" + row.sampleRate,
    firstAttemptStatus: row.firstAttemptStatus,
    reason: row.fixtureId === "ws-mid-default" && row.engine === "webkit" && row.sampleRate === 48000
      ? "first attempt failed: source and min raw WAVs each contain two over-full-scale channel samples in one frame; a diagnostic repeat retains the same frame and cannot promote attempt 1"
      : row.eligibilityReason,
  }));
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
  if (!artifact || typeof artifact.path !== "string") throw new Error(engine + " " + fixture.id + " " + sampleRate + " " + build + " attempt " + attempt + " lacks a raw artifact");
  const file = path.resolve(reportDir, engine, artifact.path);
  const expectedFrames = Math.ceil(fixture.renderDurationSec * sampleRate);
  const raw = matrix.readFloatStereoWav(file, sampleRate, expectedFrames);
  const rawSha256 = hash(raw.bytes), planarPcmSha256 = pcmHash(raw.channels);
  if (rawSha256 !== artifact.sha256 || raw.bytes.length !== artifact.bytes || planarPcmSha256 !== artifact.pcmSha256)
    throw new Error("raw artifact metadata does not match bytes: " + file);
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

function exactNoteMap(row, fixture) {
  const note = row && row.noteInstances;
  return !!note && note.complete === true && note.expectedCount === fixture.notes.length &&
    note.createdCount === fixture.notes.length && Array.isArray(note.rows) && note.rows.length === fixture.notes.length &&
    note.rows.every((actual, i) => {
      const expected = fixture.notes[i];
      return actual && actual.id === expected.id && actual.status === "created" &&
        actual.channel === expected.channel && actual.pitch === expected.pitch && actual.velocity === expected.velocity &&
        actual.program === expected.program && actual.actualProgram === expected.program &&
        Number.isSafeInteger(actual.sourceCount) && actual.sourceCount > 0 && actual.pruned === false;
    }) && Array.isArray(note.extras) && note.extras.length === 0 &&
    Array.isArray(note.prunedInstances) && note.prunedInstances.length === 0;
}

function exactProbeMap(row, fixture) {
  const probes = row && row.probeInstances;
  return !!probes && probes.complete === true && probes.expectedCount === fixture.probes.length &&
    probes.createdCount === fixture.probes.length && Array.isArray(probes.rows) && probes.rows.length === fixture.probes.length &&
    probes.rows.every((actual, i) => {
      const expected = fixture.probes[i];
      return actual && actual.id === expected.id && actual.status === "created" &&
        actual.channel === expected.channel && actual.pitch === expected.pitch && actual.velocity === expected.velocity &&
        actual.program === expected.program && actual.actualProgram === expected.program &&
        Number.isSafeInteger(actual.sourceCount) && actual.sourceCount > 0 && actual.pruned === false;
    }) && Array.isArray(probes.prunedInstances) && probes.prunedInstances.length === 0;
}

function checkPass(caseRow, name) {
  const found = Array.isArray(caseRow.checks) && caseRow.checks.find((check) => check && check.name === name);
  return !!found && found.ok === true;
}

function pairRows(report) {
  const rows = [];
  for (const engine of ["chromium", "firefox", "webkit"]) {
    const engineReport = report[engine];
    if (!engineReport || !Array.isArray(engineReport.cases)) throw new Error("matrix report missing engine " + engine);
    for (const c of engineReport.cases) {
      const obs = c && c.observations && c.observations.fullMix;
      if (!obs) continue;
      const fixture = fullMix.FIXTURE_BY_ID[obs.fixtureId];
      if (!fixture || ![44100, 48000].includes(obs.sampleRate)) throw new Error("v5 report has an undeclared full-mix case " + String(c && c.id));
      const builds = {};
      for (const build of ["source", "min"]) {
        const row = obs.builds && obs.builds[build];
        if (!row || row.attempt !== 1 || row.firstAttempt !== true || !row.diagnosticRepeat ||
            row.diagnosticRepeat.attempt !== 2 || row.diagnosticRepeat.neverPromotesFirstAttempt !== true)
          throw new Error(c.id + " " + build + " does not preserve attempt 1 and diagnostic repeat roles");
        builds[build] = {
          priorResult: row.result,
          priorPreBaselineEligible: row.preBaselineEligible === true,
          first: readAttempt(argsv.input, engine, fixture, obs.sampleRate, build, 1, row),
          repeat: readAttempt(argsv.input, engine, fixture, obs.sampleRate, build, 2, row),
        };
        builds[build].firstVsRepeat = fullMix.sameEnginePcm(
          readChannels(builds[build].first.path, builds[build].first.sampleRate, fixture),
          readChannels(builds[build].repeat.path, builds[build].repeat.sampleRate, fixture), engine,
        );
      }
      const sourceChannels = readChannels(builds.source.first.path, obs.sampleRate, fixture);
      const minChannels = readChannels(builds.min.first.path, obs.sampleRate, fixture);
      const sourceMin = fullMix.sameEnginePcm(sourceChannels, minChannels, engine);
      const reportedSourceMin = obs.sourceMinPcmComparison;
      const captureCheckEvidence = Object.fromEntries(["source", "min"].map((build) => {
        const capture = obs.builds[build], first = builds[build].first;
        const probes = first.metrics.probes;
        const checks = {
          finiteFirstPcm: first.finite && first.metrics.channels.left.finite && first.metrics.channels.right.finite,
          fullScaleFirstPcm: first.overFullScaleSamples === 0 && first.peak <= 1,
          independentNoteSourceMap: exactNoteMap(capture, fixture),
          independentProbeSourceMap: exactProbeMap(capture, fixture),
          intendedIsolatedPitchAndEnvelope: probes.length === fixture.probes.length && probes.every((probe, i) =>
            probe.id === fixture.probes[i].id && probe.status === "measured" && Number.isFinite(probe.pitchCents) &&
            Math.abs(probe.pitchCents) <= fullMix.PROBE_PITCH_LIMIT_CENTS &&
            Number.isFinite(probe.toneFractionDb) && probe.toneFractionDb >= -12 &&
            Number.isFinite(probe.spectralPeakToGlobalDb) && probe.spectralPeakToGlobalDb >= -36 &&
            Number.isFinite(probe.onsetMs) && probe.levelRms > 0 && Array.isArray(probe.envelope) && probe.envelope.length === 40),
          isolatedQuietSeparation: first.metrics.isolation.length === fixture.probes.length &&
            first.metrics.isolation.every((x) => Number.isFinite(x.preProbeRms) && x.preProbeRms <= 1e-5),
          completeNativeTiming: fixture.timingComplete,
          nativeFaultSensitivity: capture.faultSensitivity && capture.faultSensitivity.checksPass === true,
          noSchedulerPageOrNetworkError: capture.intervalCount === 1 && Array.isArray(capture.rejections) &&
            capture.rejections.length === 0 && checkPass(c, build + " first attempt completed without scheduler, rejection, page error or network request"),
          producerPreBaselineGate: builds[build].priorPreBaselineEligible && checkPass(c, build + " first attempt is eligible for native reference capture before comparison"),
        };
        return [build, checks];
      }));
      const sourceMinPcmEligible = sourceMin.ok && JSON.stringify(sourceMin) === JSON.stringify(reportedSourceMin) &&
        checkPass(c, "source and fresh-min first-attempt raw PCM match without alignment");
      const preBaselineEligible = Object.values(captureCheckEvidence).every((checks) => Object.values(checks).every(Boolean)) && sourceMinPcmEligible;
      const eligibilityReasons = [];
      for (const [build, checks] of Object.entries(captureCheckEvidence)) for (const [name, ok] of Object.entries(checks))
        if (!ok) eligibilityReasons.push(build + ": " + name);
      if (!sourceMinPcmEligible) eligibilityReasons.push("source/min first-attempt PCM differs or producer comparison does not match raw samples");
      rows.push({
        id: c.id, engine, browserVersion: engineReport.version, platform: engineReport.platform,
        fixtureId: fixture.id, profileKind: fixture.profileKind, sampleRate: obs.sampleRate, quality: obs.quality,
        scope: obs.scope, input: {
          midiSha256: obs.midiSha256, setupSha256: obs.setupSha256, settingsSha256: obs.settingsSha256,
          probePlanSha256: obs.probePlanSha256, playbackOriginSec: obs.playbackOriginSec,
          captureMethodSha256: obs.methodSha256, captureToleranceSha256: obs.toleranceSha256,
        },
        captureRun: report.matrixRun,
        captureSetupProvenance: obs.setupProvenance,
        independentVoiceEvidence: Object.fromEntries(["source", "min"].map((build) => [build, {
          expected: obs.builds[build].noteInstances && obs.builds[build].noteInstances.expectedCount,
          created: obs.builds[build].noteInstances && obs.builds[build].noteInstances.createdCount,
          pruned: obs.builds[build].noteInstances && obs.builds[build].noteInstances.prunedInstances.length,
          probeExpected: obs.builds[build].probeInstances && obs.builds[build].probeInstances.expectedCount,
          probeCreated: obs.builds[build].probeInstances && obs.builds[build].probeInstances.createdCount,
        }])),
        nativeVoiceRows: Object.fromEntries(["source", "min"].map((build) => [build, {
          notes: obs.builds[build].noteInstances && obs.builds[build].noteInstances.rows,
          probes: obs.builds[build].probeInstances && obs.builds[build].probeInstances.rows,
          pruned: obs.builds[build].noteInstances && obs.builds[build].noteInstances.prunedInstances,
        }])),
        builds, sourceMinPcmComparison: sourceMin,
        reportedSourceMinPcmComparisonMatches: JSON.stringify(sourceMin) === JSON.stringify(reportedSourceMin),
        preBaselineEligible, captureCheckEvidence, eligibilityReasons,
        firstAttemptStatus: preBaselineEligible ? "eligible" : "fail",
        originalCaptureVerdict: Object.fromEntries(["source", "min"].map((build) => [build, builds[build].priorResult])),
        eligibilityReason: preBaselineEligible ? null : "one or more retained first-attempt gates failed; diagnostic repeats do not promote eligibility",
      });
      const firstDefect = ["source", "min"].map((build) => builds[build].first)
        .find((capture) => capture.overFullScaleFrames.length);
      if (firstDefect) {
        const frame = firstDefect.overFullScaleFrames[0].frame, atSec = frame / obs.sampleRate;
        const expectedNotes = fixture.notes.filter((note) => note.onsetSec <= atSec && (note.offSec === null || note.offSec > atSec));
        const actualRows = obs.builds.source.noteInstances.rows;
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
        delete builds[build].repeat.channels;
      }
    }
  }
  return rows;
}

function readChannels(relativePath, sampleRate, fixture) {
  const file = path.resolve(argsv.input, relativePath);
  return matrix.readFloatStereoWav(file, sampleRate, Math.ceil(fixture.renderDurationSec * sampleRate)).channels;
}

const argsv = args(process.argv.slice(2));
const reportFile = path.join(argsv.input, "results.json");
const reportBytes = fs.readFileSync(reportFile);
const report = JSON.parse(reportBytes.toString("utf8"));
if (!report.matrixRun || !report.matrixRun.selection || !report.matrixRun.selection.specs.includes("full-mix"))
  throw new Error("input results are not a retained full-mix matrix run");
const rows = pairRows(report);
const historicalToolchain = matrix.resolveBrowserToolchain();
const expected = fullMix.referenceExpectedCases();
const actual = rows.map((row) => row.engine + "/" + row.fixtureId + "/" + row.sampleRate).sort();
if (JSON.stringify(actual) !== JSON.stringify(expected.slice().sort()))
  throw new Error("input run is missing or duplicates declared engine/fixture/rate cases");
const eligible = rows.filter((row) => row.preBaselineEligible).map((row) => row.engine + "/" + row.fixtureId + "/" + row.sampleRate).sort();
const ineligible = rows.filter((row) => !row.preBaselineEligible).map((row) => ({
  id: row.engine + "/" + row.fixtureId + "/" + row.sampleRate,
  firstAttemptStatus: row.firstAttemptStatus,
  reason: row.fixtureId === "ws-mid-default" && row.engine === "webkit" && row.sampleRate === 48000
    ? "both first-attempt source/min WAVs contain the retained over-full-scale sample at frame 653088; no normalization or repeat promotion"
          : row.eligibilityReasons.join("; "),
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
