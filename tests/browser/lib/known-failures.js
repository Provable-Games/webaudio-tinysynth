/* Explicit ordinary-CI exceptions for the retained P1-A2 known failures. */
"use strict";

const { MATRIX } = require("../matrix");
const { tolerances } = require("../tolerances");
const FIRST_ATTEMPT = require("./first-attempt");

const POLICY_ID = "p1-a2-known-failures-v5";
const BUFFER_OBSERVATION = "generated buffer SHA-256 (first reverb-enabled attempt)";
const FAILURE_OBSERVATION = "first-attempt same-engine failures and their diagnostic re-renders (the verdict is the first attempt's; a clean re-render does not clear it)";
const SHORT_FAILURE_OBSERVATION = "first-attempt failures and their diagnostic re-renders (the verdict is the first attempt's; a clean re-render does not clear it)";
const BUFFER_CHECK = "reverb-enabled first-attempt generated Float32 buffers have complete source/min SHA-256 measurements";
const SEED_CHECK = "source/min generated-buffer SHA-256 matches the independent seeded Float32 reference";
const RENDER_NOISE = new Map([
  ["render q0 44100", { quality: 0, sampleRate: 44100, programs: [121, 125] }],
  ["render q0 48000", { quality: 0, sampleRate: 48000, programs: [127] }],
]);
const RENDER_GROUP = "gm-programs-96-127";
const DRUM_GROUP = "gm-drums";
const SHORT_CASE = "short-notes completed min";
const HELD_CASE = "short-notes held source";
const HELD_FOLLOW = 0.0002;
const HELD_CHECK = "until the note-off the short note renders as the uncut note (max |diff| <= " + HELD_FOLLOW + " of the peak)";
const SHORT_CHECK = "every program with an attack, released after its attacks end, renders as with upstream's release (128 programs, max |diff| <= " + String(tolerances("webkit").sameEngineSample) + ")";

function isRecord(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, keys) {
  return isRecord(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys.slice().sort());
}

function validRenderDims(c) {
  return c && c.kind === "assert" && exactKeys(c.dims, ["quality", "sampleRate"]) &&
    [0, 1].includes(c.dims.quality) && MATRIX.sampleRates.includes(c.dims.sampleRate);
}

function validGmMeasurement(row, slots = 32) {
  return exactKeys(row, ["peaks", "rms"]) && Array.isArray(row.peaks) && row.peaks.length === slots &&
    row.peaks.every((x) => typeof x === "number" && Number.isFinite(x) && x > 0) &&
    Array.isArray(row.rms) && row.rms.length === slots &&
    row.rms.every((x) => typeof x === "number" && Number.isFinite(x) && x > 0 && x <= 1);
}

function expectedNoiseFor(engine, c) {
  if (engine !== "webkit" || !c || c.spec !== "render" || !validRenderDims(c)) return [];
  const targets = [];
  if (c.id === "render q1 48000" && c.dims.quality === 1 && c.dims.sampleRate === 48000) {
    targets.push({ group: DRUM_GROUP, slots: 47, signature: "webkit-drum54-q1-48000-first-attempt", minimumFailures: 2,
      items: [DRUM_GROUP + " drum 54 source/min", DRUM_GROUP + " drum 54 repeat"] });
    targets.push({ group: RENDER_GROUP, slots: 32, signature: "webkit-gm125-q1-48000-first-attempt", minimumFailures: 1,
      items: [RENDER_GROUP + " program 125 source/min"] });
    return targets;
  }
  const target = RENDER_NOISE.get(c.id);
  if (target && c.dims.quality === target.quality && c.dims.sampleRate === target.sampleRate)
    targets.push({ group: RENDER_GROUP, slots: 32, signature: "webkit-noise-gm-first-attempt", minimumFailures: 1,
      items: target.programs.map((program) => RENDER_GROUP + " program " + program + " source/min") });
  if (c.id === "render q0 48000" && c.dims.quality === 0 && c.dims.sampleRate === 48000)
    targets.push({ group: DRUM_GROUP, slots: 47, signature: "webkit-drum58-q0-48000-first-attempt", minimumFailures: 1,
      items: [DRUM_GROUP + " drum 58 source/min"] });
  return targets;
}

function validOutcome(failure) {
  if (!isRecord(failure) || !isRecord(failure.firstAttempt) || !Array.isArray(failure.firstAttempt.reasons) ||
      failure.firstAttempt.reasons.length !== 1 || typeof failure.firstAttempt.reasons[0] !== "string" || !failure.firstAttempt.reasons[0] ||
      !Number.isSafeInteger(failure.attempts) || failure.attempts < 1 || !Array.isArray(failure.diagnostics) ||
      failure.attempts !== failure.diagnostics.length + 1 ||
      ![FIRST_ATTEMPT.OUTCOMES.INTERMITTENT, FIRST_ATTEMPT.OUTCOMES.REPRODUCED, FIRST_ATTEMPT.OUTCOMES.NOT_RERENDERED].includes(failure.outcome)) return false;
  for (let i = 0; i < failure.diagnostics.length; ++i) {
    const diagnostic = failure.diagnostics[i];
    if (!isRecord(diagnostic) || diagnostic.attempt !== i + 2 || typeof diagnostic.ok !== "boolean" ||
        !Array.isArray(diagnostic.reasons) || !diagnostic.reasons.every((reason) => typeof reason === "string") ||
        (diagnostic.ok ? diagnostic.reasons.length !== 0 : diagnostic.reasons.length === 0)) return false;
  }
  if (failure.outcome === FIRST_ATTEMPT.OUTCOMES.INTERMITTENT &&
      (!failure.diagnostics.length || !failure.diagnostics.at(-1).ok)) return false;
  if (failure.outcome === FIRST_ATTEMPT.OUTCOMES.REPRODUCED &&
      (!failure.diagnostics.length || failure.diagnostics.some((x) => x.ok))) return false;
  if (failure.outcome === FIRST_ATTEMPT.OUTCOMES.NOT_RERENDERED && failure.diagnostics.length) return false;
  return true;
}

function finiteDifferenceReason(reasons, tolerance, style) {
  if (!Array.isArray(reasons) || reasons.length !== 1) return false;
  const pattern = style === "render"
    ? /^max \|diff\| ([0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?) at sample (\d+) \(tolerance ([0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?)\)$/i
    : /^max \|diff\| ([0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?) > ([0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?)$/i;
  const match = pattern.exec(reasons[0]);
  if (!match) return false;
  const difference = Number(match[1]);
  const reportedTolerance = Number(style === "render" ? match[3] : match[2]);
  return Number.isFinite(difference) && difference > tolerance && reportedTolerance === tolerance &&
    (style !== "render" || Number.isSafeInteger(Number(match[2])));
}

function validSummary(summary, { items, minimumFailures, maximumFailures }) {
  if (!isRecord(summary) || summary.items !== items || !Array.isArray(summary.failures) ||
      summary.failures.length < minimumFailures || summary.failures.length > maximumFailures ||
      summary.firstAttemptFailures !== summary.failures.length ||
      !Number.isSafeInteger(summary.intermittent) || !Number.isSafeInteger(summary.reproduced) ||
      !Number.isSafeInteger(summary.notRerendered) ||
      summary.intermittent < 0 || summary.reproduced < 0 || summary.notRerendered < 0 ||
      summary.intermittent + summary.reproduced + summary.notRerendered !== summary.failures.length ||
      !Number.isSafeInteger(summary.diagnosticRenderAttempts) ||
      summary.diagnosticRenderAttempts < 0 ||
      summary.diagnosticRenderAttempts !== summary.failures.reduce((n, f) => n + (Array.isArray(f.diagnostics) ? f.diagnostics.length : 0), 0) ||
      summary.rendersIncludingFirstAttempts !== summary.items + summary.diagnosticRenderAttempts) return false;
  if (!summary.failures.every(validOutcome)) return false;
  const counts = Object.fromEntries(Object.values(FIRST_ATTEMPT.OUTCOMES).map((outcome) => [outcome, 0]));
  for (const failure of summary.failures) ++counts[failure.outcome];
  return counts[FIRST_ATTEMPT.OUTCOMES.INTERMITTENT] === summary.intermittent &&
    counts[FIRST_ATTEMPT.OUTCOMES.REPRODUCED] === summary.reproduced &&
    counts[FIRST_ATTEMPT.OUTCOMES.NOT_RERENDERED] === summary.notRerendered;
}

function knownNoiseFailures(engine, c) {
  if (engine !== "webkit" || !c || c.status !== "fail" || !Array.isArray(c.checks)) return null;
  const first = c.observations && c.observations[FAILURE_OBSERVATION];
  const targets = expectedNoiseFor(engine, c);
  if (targets.length) {
    const allowedItems = targets.flatMap((target) => target.items);
    if (!validSummary(first, { items: 268, minimumFailures: 1, maximumFailures: allowedItems.length })) return null;
    const allow = new Set(allowedItems);
    if (new Set(first.failures.map((failure) => failure.item)).size !== first.failures.length ||
        !first.failures.every((failure) => allow.has(failure.item) && finiteDifferenceReason(
      failure.firstAttempt.reasons, tolerances(engine).sameEngineSample, "render"))) return null;
    const classifications = [];
    for (const target of targets) {
      const { group, slots } = target;
      const failures = first.failures.filter((failure) => target.items.includes(failure.item));
      if (!failures.length) continue;
      if (failures.length < target.minimumFailures) return null;
      const checkFor = (failure) => group + (failure.item.endsWith(" repeat")
        ? ": a repeat render in a fresh page matches (max |diff| <= "
        : ": min renders the same PCM as source (max |diff| <= ") + String(tolerances(engine).sameEngineSample) + ")";
      const checkNames = [...new Set(failures.map(checkFor))];
      for (const checkName of checkNames) {
        const matchingChecks = c.checks.filter((check) => check && check.ok === false && check.name === checkName);
        const expectedDetail = failures.filter((failure) => checkFor(failure) === checkName)
          .map((failure) => failure.item + ": " + failure.firstAttempt.reasons[0] +
            " (first attempt; " + FIRST_ATTEMPT.SHORT[failure.outcome] + ")").join(" | ");
        if (matchingChecks.length !== 1 || matchingChecks[0].detail !== expectedDetail) return null;
      }
      const measurements = c.observations && c.observations.measurements;
      if (!isRecord(measurements) || Object.prototype.hasOwnProperty.call(measurements, group) ||
          !validGmMeasurement(measurements[group + "/source"], slots) ||
          !validGmMeasurement(measurements[group + "/min"], slots)) return null;
      classifications.push({ signature: target.signature, checkNames, splitMeasurementGroup: group, splitMeasurementSlots: slots,
        evidenceItems: failures.map((failure) => failure.item), firstAttemptFailures: failures });
    }
    return classifications;
  }

  if (c.kind === "assert" && c.spec === "short-notes" && c.id === HELD_CASE &&
      exactKeys(c.dims, ["build"]) && c.dims.build === "source") {
    const summary = c.observations && c.observations[SHORT_FAILURE_OBSERVATION];
    const checks = c.checks.filter((check) => check && check.ok === false && check.name === HELD_CHECK);
    if (checks.length !== 1 || !validSummary(summary, { items: 768, minimumFailures: 1, maximumFailures: 1 })) return null;
    const failure = summary.failures[0];
    if (failure.item !== "q1 119 @0.0700 s") return null;
    const match = /^differs from the uncut note before the note-off \(([0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?) of the peak > 0\.0002\)$/i
      .exec(failure.firstAttempt.reasons[0]);
    if (!match || !Number.isFinite(Number(match[1])) || Number(match[1]) <= HELD_FOLLOW ||
        checks[0].detail !== failure.item + ": " + match[1] + " [" + FIRST_ATTEMPT.SHORT[failure.outcome] + "]") return null;
    return [{ signature: "webkit-held-source-q1-119-070-first-attempt", checkNames: [HELD_CHECK],
      evidenceItems: [failure.item], firstAttemptFailures: summary.failures }];
  }

  if (c.kind !== "assert" || c.spec !== "short-notes" || c.id !== SHORT_CASE ||
      !exactKeys(c.dims, ["build"]) || c.dims.build !== "min") return null;
  const summary = c.observations && c.observations[SHORT_FAILURE_OBSERVATION];
  const failedChecks = c.checks.filter((check) => check && check.ok === false);
  const matchingChecks = failedChecks.filter((check) => check.name === SHORT_CHECK);
  if (matchingChecks.length !== 1 ||
      !validSummary(summary, { items: 128, minimumFailures: 1, maximumFailures: 2 })) return null;
  if (new Set(summary.failures.map((failure) => failure.item)).size !== summary.failures.length ||
      !summary.failures.every((failure) => ["q1 120", "q1 126"].includes(failure.item) &&
        finiteDifferenceReason(failure.firstAttempt.reasons, tolerances(engine).sameEngineSample, "short"))) return null;
  const expectedDetail = summary.failures.map((failure) => failure.item + ": " + failure.firstAttempt.reasons[0] +
    " [" + FIRST_ATTEMPT.SHORT[failure.outcome] + "]").join(", ");
  if (matchingChecks[0].detail !== expectedDetail) return null;
  return [{ signature: "webkit-short-notes-q1-120-126-first-attempt", checkNames: [SHORT_CHECK],
    evidenceItems: summary.failures.map((failure) => failure.item), firstAttemptFailures: summary.failures }];
}

function knownConvBufDescriptor(engine, c, bufferProblems, verifyNormalized) {
  if (!c || c.spec !== "render" || !validRenderDims(c) || !MATRIX.engines.includes(engine) ||
      !Array.isArray(bufferProblems) || typeof verifyNormalized !== "function") return null;
  const observation = c.observations && c.observations[BUFFER_OBSERVATION];
  if (!isRecord(observation) || !isRecord(observation.builds)) return null;
  const anomalies = [];
  for (const build of ["source", "min"]) {
    const row = observation.builds[build] && observation.builds[build].convBuf;
    if (!isRecord(row)) return null;
    if (row.channels === 2) continue;
    const trace = row.captureTrace;
    if (row.channels !== 1 || !isRecord(trace) || !isRecord(trace.browser) || !isRecord(trace.node) ||
        trace.browser.channels !== 2 || trace.node.channels !== 2 ||
        trace.browser.frames !== trace.node.frames || trace.browser.frames !== row.frames ||
        trace.browser.byteLength !== trace.node.byteLength || trace.node.byteLength !== row.byteLength ||
        trace.node.decodedByteLength !== row.byteLength || trace.node.sha256 !== row.sha256) return null;
    anomalies.push(build);
  }
  if (anomalies.length !== 1) return null;
  const build = anomalies[0];
  const prefix = engine + " " + c.id + " " + build + " convBuf ";
  const expectedProblems = [
    prefix + "channel count is 1, expected 2",
    prefix + "final descriptor differs from the Node-validated capture-stage snapshot",
  ].sort();
  if (JSON.stringify([...bufferProblems].sort()) !== JSON.stringify(expectedProblems)) return null;
  let normalized;
  try {
    normalized = structuredClone(observation);
    normalized.builds[build].convBuf.channels = 2;
    const remaining = verifyNormalized(normalized);
    if (!Array.isArray(remaining) || remaining.length) return null;
  } catch {
    return null;
  }
  return {
    signature: "generated-convbuf-final-channel-descriptor-contradiction",
    checkNames: [BUFFER_CHECK, SEED_CHECK],
    allowedBufferProblems: expectedProblems,
    normalizedObservation: normalized,
    evidenceItems: [build + "/convBuf"],
  };
}

function classifyKnownCase(engine, c, { bufferProblems = [], rawBufferProblems = [], verifyNormalizedBuffer } = {}) {
  if (!c || c.status !== "fail" || !Array.isArray(c.checks) || !c.checks.length || rawBufferProblems.length) return null;
  const failures = [];
  const descriptor = knownConvBufDescriptor(engine, c, bufferProblems, verifyNormalizedBuffer);
  if (descriptor) failures.push(descriptor);
  const noise = knownNoiseFailures(engine, c);
  if (noise) failures.push(...noise);
  if (!failures.length) return null;
  const allowedCheckNames = new Set(failures.flatMap((failure) => failure.checkNames));
  const failedChecks = c.checks.filter((check) => check && check.ok === false);
  if (!failedChecks.length || failedChecks.some((check) => !allowedCheckNames.has(check.name)) ||
      new Set(failedChecks.map((check) => check.name)).size !== failedChecks.length) return null;
  if (bufferProblems.length && (!descriptor || JSON.stringify([...bufferProblems].sort()) !== JSON.stringify(descriptor.allowedBufferProblems))) return null;
  if (descriptor && (c.checks.filter((check) => check && check.ok === false && [BUFFER_CHECK, SEED_CHECK].includes(check.name)).length !== 2)) return null;
  return { failures, allowedCheckNames, allowedBufferProblems: descriptor ? descriptor.allowedBufferProblems : [] };
}

function projectNoisyMeasurements(c, knownFailures) {
  if (!knownFailures || !c || !c.observations || !isRecord(c.observations.measurements)) return c;
  const noises = knownFailures.failures.filter((failure) => failure.splitMeasurementGroup);
  if (!noises.length) return c;
  const m = c.observations.measurements, measurements = Object.assign({}, m);
  for (const noise of noises) {
    const group = noise.splitMeasurementGroup, slots = noise.splitMeasurementSlots;
    const source = m[group + "/source"], min = m[group + "/min"];
    if (Object.prototype.hasOwnProperty.call(m, group) || !validGmMeasurement(source, slots) || !validGmMeasurement(min, slots)) return c;
    measurements[group] = source;
  }
  return Object.assign({}, c, { observations: Object.assign({}, c.observations, { measurements }) });
}

module.exports = {
  POLICY_ID,
  BUFFER_OBSERVATION,
  FAILURE_OBSERVATION,
  SHORT_FAILURE_OBSERVATION,
  BUFFER_CHECK,
  SEED_CHECK,
  SHORT_CHECK,
  HELD_CHECK,
  RENDER_GROUP,
  DRUM_GROUP,
  classifyKnownCase,
  knownConvBufDescriptor,
  knownNoiseFailures,
  projectNoisyMeasurements,
  validGmMeasurement,
};
