/*
 * Sharding and merged browser-matrix release gate. These tests exercise the
 * actual --merge CLI with synthetic but complete current-spec reports; no
 * browser runs. Artifact identity, independent run context, current build
 * hashes, exact case manifests and cross-engine measurements are all checked.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const H = require("../harness");
const MATRIX = require("../browser/matrix").MATRIX;
const CONTEXT = {
  repository: "Provable-Games/webaudio-tinysynth",
  workflowRef: "Provable-Games/webaudio-tinysynth/.github/workflows/browser-matrix.yml@refs/pull/79/merge",
  eventName: "pull_request",
  runId: "4711223344",
  runAttempt: "1",
  testedSha: "5c71dd213d85232aa9bc498a615d7e95fd8bb2ab",
};
const GROUPS = ["gm-programs-0-31", "gm-programs-32-63", "gm-programs-64-95", "gm-programs-96-127", "gm-drums"];

const TEST_REFERENCE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "browser-matrix-reference-"));
const TEST_REFERENCE_FILE = path.join(TEST_REFERENCE_DIR, "full-mix-reference.json");
const previousReference = process.env.TINYSYNTH_BROWSER_MATRIX_REFERENCE;
const seedFullMixSpec = require("../browser/specs/full-mix");
const renderSpec = require("../browser/specs/render");
const gestureSpec = require("../browser/specs/gesture");
const { SCENARIOS } = require("../browser/lib/scenarios");
const testAnalysis = require("../browser/lib/analysis");
const knownFailurePolicy = require("../browser/lib/known-failures");
const FIRST_ATTEMPT = require("../browser/lib/first-attempt");
const { tolerances } = require("../browser/tolerances");
const float32Digest = require("../browser/lib/float32-digest");
const { SEED_EXPECTED } = require("../browser/specs/seed-expected");
const browserToolchain = require("../../scripts/browser-toolchain");
const TEST_TOOLCHAIN = browserToolchain.resolveBrowserToolchain(process.env, H.ROOT);
const testBrowserBundle = (engine) => browserToolchain.engineBundle(TEST_TOOLCHAIN, engine);
const stableSha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const stableCanonical = (value) => Array.isArray(value) ? "[" + value.map(stableCanonical).join(",") + "]"
  : value && typeof value === "object" ? "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stableCanonical(value[key])).join(",") + "}"
    : JSON.stringify(value);
let seedReference;
test.before(async () => { seedReference = (await import("../unit/seed-reference.mjs")).reference; });

test("generated-buffer SHA-256 uses known Float32LE planar channel bytes", async () => {
  const channels = [new Float32Array([0, 1, -1]), new Float32Array([0.5, -0.5, 2])];
  const bytes = float32Digest.planarFloat32Bytes(channels);
  const expectedBytes = "000000000000803f000080bf0000003f000000bf00000040";
  assert.equal(Buffer.from(bytes).toString("hex"), expectedBytes);
  const encoded = float32Digest.base64Planar(channels);
  assert.equal(Buffer.from(encoded, "base64").toString("hex"), expectedBytes);
  assert.equal(await float32Digest.sha256Planar(channels), "bb0c06c2c79f00aaf570ef2cba7813d41a60ab3093bf17becaf11ff10a779fe0");
  assert.deepEqual(float32Digest.sha256Base64Planar(encoded, 2, 3), {
    sha256: "bb0c06c2c79f00aaf570ef2cba7813d41a60ab3093bf17becaf11ff10a779fe0", channels: 2, frames: 3, byteLength: 24,
  });
  assert.notEqual(await float32Digest.sha256Planar(channels), await float32Digest.sha256Planar(channels.slice().reverse()));
  assert.throws(() => float32Digest.sha256Base64Planar(encoded, 2, 2), /length or base64/);
  assert.throws(() => float32Digest.sha256Base64Planar(float32Digest.base64Planar([new Float32Array([NaN])]), 1, 1), /non-finite/);
  assert.throws(() => float32Digest.planarFloat32Bytes([new Float32Array([1]), new Float32Array([1, 2])]), /equal frame counts/);
  assert.throws(() => float32Digest.planarFloat32Bytes([[1, 2]]), /Float32Array/);

  const scenario = SCENARIOS.find((item) => item.name === "reverb");
  const sampleRate = 44100, quality = 1;
  const seed = 1;
  const generated = {
    convBuf: seedReference.convBuf(seed, sampleRate),
    n0: seedReference.n0(seed, sampleRate),
    n1: seedReference.n1(seed, sampleRate),
  };
  const captureBuilds = async ({ afterRender, afterCombine } = {}) => {
    const captures = {};
    for (const build of ["source", "min"]) {
      const actualSpec = renderSpec.renderSpec(scenario, { seed, sr: sampleRate, quality }, { captureBufferSha256: true });
      const bufferBytes = Object.fromEntries(Object.entries(generated).map(([name, channels]) => [name, {
        bytesBase64: float32Digest.base64Planar(channels), channels: channels.length, frames: channels[0].length,
        byteLength: channels.length * channels[0].length * 4,
      }]));
      const captured = await renderSpec.render({ page: { evaluate: async () => ({ bufferBytes }) } }, actualSpec);
      if (afterRender) afterRender(build, captured);
      const combined = renderSpec.combine(scenario, [captured]);
      if (afterCombine) afterCombine(build, combined);
      captures[build] = combined;
    }
    return captures;
  };
  const makeObservation = (captures) => JSON.parse(JSON.stringify({
    schemaVersion: 1, method: "sha256-f32le-planar-channel-order-v1",
    producer: "node-crypto-after-browser-byte-transfer",
    encoding: "IEEE-754 binary32 little-endian; planar channel-index order; sample bytes only",
    scenarioId: "reverb", attempt: 1, firstAttempt: true,
    settings: { source: captures.source.bufferCaptureSettings, min: captures.min.bufferCaptureSettings },
    builds: { source: captures.source.bufferSha256, min: captures.min.bufferSha256 },
  }));
  const dimensions = { dims: { sampleRate, quality } };
  const noOutputCaptures = await captureBuilds();
  for (const build of ["source", "min"])
    renderSpec.saveGeneratedBufferCaptures(noOutputCaptures[build], quality, sampleRate, build, { out: null, save: () => null });
  const noOutputObservation = makeObservation(noOutputCaptures);
  assert.equal(noOutputObservation.settings.source.seed, seed);
  assert.deepEqual(renderBufferShaProblems(dimensions, noOutputObservation, "local no-output producer", { expectedSeed: seed, requireSaved: false }), [],
    "local no-output producer retains valid first-attempt metadata without claiming sidecars were saved");
  assert.ok(renderBufferShaProblems(dimensions, noOutputObservation, "strict aggregate", { expectedSeed: seed, requireSaved: true })
    .some((problem) => /retention is false, expected true/.test(problem)),
  "strict aggregate still refuses local no-output descriptors");
  const localEngines = Object.fromEntries(MATRIX.engines.map((engine) => [engine, { version: "synthetic",
    cases: [{ id: "render-reverb-q1-44100", spec: "render", dims: dimensions.dims,
      observations: { measurements: measurements(), "generated buffer SHA-256 (first reverb-enabled attempt)": noOutputObservation } }] }]));
  const localChecks = crossEngine(localEngines, "core", { expectedSeed: seed, requireSaved: false });
  assert.ok(localChecks.some((check) => check.name.includes("actual generated-buffer SHA-256") && check.ok),
    "local cross-engine validation accepts no-output descriptors only under its explicit local retention policy");
  assert.ok(crossEngine(localEngines).some((check) => check.name.includes("actual generated-buffer SHA-256") && !check.ok),
    "default strict cross-engine validation does not infer local seed or no-output policy");
  assert.ok(renderBufferShaProblems(dimensions, noOutputObservation, "wrong expected seed", { expectedSeed: MATRIX.seed, requireSaved: false })
    .some((problem) => /active reverb-probe settings|independent seeded reference/.test(problem)),
  "a stale independently expected seed cannot validate an alternate-seed report");

  const captures = await captureBuilds();
  const persisted = [];
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-buffer-producer-"));
  const resultFile = path.join(artifactRoot, "browser-results-chromium-1", "browser-matrix", "results.json");
  const inheritedChannels = Object.getOwnPropertyDescriptor(Object.prototype, "channels");
  const inheritedConvBuf = Object.getOwnPropertyDescriptor(Object.prototype, "convBuf");
  const originalNodeOptions = process.env.NODE_OPTIONS;
  const hadNodeOptions = Object.prototype.hasOwnProperty.call(process.env, "NODE_OPTIONS");
  const originalExecArgvDescriptor = Object.getOwnPropertyDescriptor(process, "execArgv");
  let inheritedChannelsGetterCalls = 0, inheritedChannelsSetterCalls = 0;
  let inheritedConvBufGetterCalls = 0, inheritedConvBufSetterCalls = 0;
  const installSyntheticAccessors = () => {
    Object.defineProperty(Object.prototype, "channels", {
      configurable: true,
      get() { ++inheritedChannelsGetterCalls; return undefined; },
      set(value) {
        ++inheritedChannelsSetterCalls;
        Object.defineProperty(this, "channels", { configurable: true, enumerable: true, writable: true, value });
      },
    });
    Object.defineProperty(Object.prototype, "convBuf", {
      configurable: true,
      get() { ++inheritedConvBufGetterCalls; return undefined; },
      set(value) {
        ++inheritedConvBufSetterCalls;
        Object.defineProperty(this, "convBuf", { configurable: true, enumerable: true, writable: true, value });
      },
    });
  };
  const restoreSyntheticAccessors = () => {
    if (inheritedChannels) Object.defineProperty(Object.prototype, "channels", inheritedChannels);
    else delete Object.prototype.channels;
    if (inheritedConvBuf) Object.defineProperty(Object.prototype, "convBuf", inheritedConvBuf);
    else delete Object.prototype.convBuf;
  };
  try {
    installSyntheticAccessors();
    process.env.NODE_OPTIONS = "T6_PRIVATE_NODE_OPTIONS_DO_NOT_EMIT";
    const privateExecArgv = ["--require=/T6_PRIVATE_PRELOAD_PATH", "--credential=T6_PRIVATE_ARG_VALUE", "--import", "/T6_PRIVATE_IMPORT_PATH"];
    for (let i = 0; i < 70; ++i) privateExecArgv.push("--T6_PRIVATE_FLAG_" + i + "=T6_PRIVATE_FLAG_VALUE");
    Object.defineProperty(process, "execArgv", {
      configurable: true,
      enumerable: originalExecArgvDescriptor ? !!originalExecArgvDescriptor.enumerable : true,
      writable: true,
      value: privateExecArgv,
    });
    for (const build of ["source", "min"]) {
      renderSpec.saveGeneratedBufferCaptures(captures[build], quality, sampleRate, build, {
        out: resultFile,
        save: (rel, bytes) => {
          const target = path.join(path.dirname(resultFile), "chromium", rel);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, bytes);
          persisted.push([build, rel, bytes]);
          return target;
        },
      });
    }
    restoreSyntheticAccessors();
    const originCaptures = await captureBuilds({
      afterRender(build, rendered) {
        installSyntheticAccessors();
        if (build === "source") {
          const original = rendered.bufferSha256.convBuf;
          rendered.bufferSha256.convBuf = Object.freeze({
            sha256: original.sha256,
            channels: 1,
            frames: original.frames,
            byteLength: original.byteLength,
          });
        }
      },
      afterCombine(build, combined) {
        try {
          renderSpec.saveGeneratedBufferCaptures(combined, quality, sampleRate, build, { out: resultFile, save: () => true });
        } finally {
          restoreSyntheticAccessors();
        }
      },
    });
    const originIntegrity = renderSpec.generatedBufferIntegrityCheck(originCaptures.source.bufferSha256,
      originCaptures.min.bufferSha256, {
        quality, sampleRate, expectedFrames: Math.floor(sampleRate * 0.5), requireSaved: true,
      });
    assert.equal(originIntegrity.ok, false, "the actual generated-buffer guard still rejects a frozen post-render channel replacement");
    assert.match(originIntegrity.detail, /source convBuf channels=1 expected=2/);
    const originMarker = " | integrity-context=";
    const originMarkerAt = originIntegrity.detail.lastIndexOf(originMarker);
    assert.notEqual(originMarkerAt, -1);
    const originContextText = originIntegrity.detail.slice(originMarkerAt + originMarker.length);
    const originContext = JSON.parse(originContextText);
    assert.equal(originContext.omitted, undefined, "origin context must not fall back to size omission: " + originContextText);
    assert.equal(originContext.unavailable, undefined, "origin context must not fall back to serialization failure: " + originContextText);
    assert.ok(originContext.focus && typeof originContext.focus === "object", "origin context retains focused stages: " + originContextText);
    const originStages = originContext.focus.stages;
    assert.equal(originContext.focus.build, "source");
    assert.equal(originContext.focus.buffer, "convBuf");
    const createdDigest = originStages.digestCreated;
    const createdFields = createdDigest[1];
    assert.equal(createdDigest[0], "object");
    assert.deepEqual(createdFields.channels, {
      kind: "data", enumerable: true, configurable: false, writable: false, valueType: "number", value: 2,
    });
    assert.deepEqual(createdFields.sha256, ["data", true, false, false, "string"]);
    assert.deepEqual(createdFields.frames, ["data", true, false, false, "number"]);
    assert.deepEqual(createdFields.byteLength, ["data", true, false, false, "number"]);
    assert.equal(createdDigest[2], true);
    assert.equal(createdDigest[3], "Object.prototype");
    assert.deepEqual(createdDigest[4], { kind: "missing" });
    assert.equal(createdDigest[5], true);
    assert.deepEqual(originStages.renderReturn[0], ["data", "object", "missing"]);
    assert.deepEqual(originStages.renderReturn[1], ["data", "number", 2]);
    assert.equal(originStages.renderReturn[2], true);
    assert.equal(originStages.renderReturn[3], true);
    assert.deepEqual(originStages.combine[0], ["data", "object", "accessor"]);
    assert.deepEqual(originStages.combine[1], ["data", "number", 1]);
    assert.equal(originStages.combine[2], true);
    assert.equal(originStages.combine[3], false);
    assert.equal(originStages.beforeSave.mapSlot.objectPrototype.kind, "accessor");
    assert.equal(originStages.beforeSave.value.channels.value, 1);
    assert.equal(originStages.beforeSave.sameAsCreatedDigest, false);
    assert.equal(originStages.comparison.value.channels.value, 1);
    assert.equal(originStages.comparison.sameAsCreatedDigest, false);
    assert.equal(originCaptures.source.bufferCaptureTrace.convBuf.node.channels, 2,
      "the original Node byte measurement remains stereo after the map entry is replaced");
    assert.equal(originContext.runtime.nodeOptionsSet, true);
    assert.equal(originContext.runtime.preloadPresent, true);
    assert.equal(originContext.runtime.execArgvTruncated, true);
    assert.ok(originContext.runtime.execArgvFlags.includes("--require"));
    assert.ok(originContext.runtime.execArgvFlags.includes("--import"));
    assert.ok(originContextText.length <= 4096, "upstream origin context remains useful under the existing serialization bound");
    assert.doesNotMatch(originContextText, /T6_PRIVATE|\/T6_PRIVATE|NODE_OPTIONS_DO_NOT_EMIT/,
      "upstream observations retain only sanitized runtime flags and fixed metadata descriptors");
  } finally {
    restoreSyntheticAccessors();
    if (hadNodeOptions) process.env.NODE_OPTIONS = originalNodeOptions;
    else delete process.env.NODE_OPTIONS;
    if (originalExecArgvDescriptor) Object.defineProperty(process, "execArgv", originalExecArgvDescriptor);
    else delete process.execArgv;
  }
  assert.equal(inheritedChannelsGetterCalls + inheritedChannelsSetterCalls + inheritedConvBufGetterCalls + inheritedConvBufSetterCalls, 0,
    "saving and descriptor diagnostics do not invoke inherited channel or buffer-slot accessors");
  for (const build of ["source", "min"]) {
    assert.equal(Object.hasOwn(captures[build].bufferSha256.convBuf, "channels"), true);
    assert.equal(captures[build].bufferSha256.convBuf.channels, 2, "the validated stereo count is copied unchanged");
    assert.equal(captures[build].bufferSha256.n0.channels, 1, "observed mono data stays mono rather than being normalized");
  }
  const observation = makeObservation(captures);
  assert.deepEqual(renderBufferShaProblems(dimensions, observation, "producer control", { expectedSeed: seed }), [],
    "actual render/decode/hash/combine/save producer output retains both first reverb builds through JSON serialization");
  const goodProducerIntegrity = renderSpec.generatedBufferIntegrityCheck(captures.source.bufferSha256, captures.min.bufferSha256, {
    quality, sampleRate, expectedFrames: Math.floor(sampleRate * 0.5), requireSaved: true,
  });
  assert.equal(goodProducerIntegrity.ok, true, "actual producer consistency check keeps valid stereo and mono measurements passing");
  assert.doesNotMatch(goodProducerIntegrity.detail, /integrity-context=/, "successful producer checks retain their existing detail without diagnostics");
  for (const build of ["source", "min"]) {
    assert.equal(captures[build].bufferSha256.convBuf.channels, 2);
    assert.equal(captures[build].bufferSha256.n0.channels, 1);
  }
  const resultRel = "browser-results-chromium-1/browser-matrix/results.json";
  const producerCase = { id: "render-reverb-q1-44100", dims: dimensions.dims,
    observations: { "generated buffer SHA-256 (first reverb-enabled attempt)": observation } };
  const artifactProblems = [];
  generatedBufferArtifactProblems("chromium", resultRel, resultFile, producerCase, dimensions, artifactProblems);
  assert.deepEqual(artifactProblems, [], "aggregate reopens the producer's retained files from the engine/browser-matrix artifact layout");
  assert.equal(persisted.length, 6);
  for (const [build, rel, bytes] of persisted) {
    const name = path.basename(rel).split("-").at(-1).replace(".f32le", "");
    assert.equal(bytes.length, observation.builds[build][name].byteLength);
    assert.equal(stableSha256(bytes), observation.builds[build][name].sha256);
  }
  const sourceMap = captures.source.bufferSha256;
  const originalConvBufDescriptor = Object.getOwnPropertyDescriptor(sourceMap, "convBuf");
  const minMap = captures.min.bufferSha256;
  const originalN1Descriptor = Object.getOwnPropertyDescriptor(minMap, "n1");
  try {
    sourceMap.convBuf = Object.freeze(Object.assign({}, originalConvBufDescriptor.value, { channels: 1 }));
    minMap.n1 = Object.freeze(Object.assign({}, originalN1Descriptor.value, { channels: 2 }));
    const failedProducerIntegrity = renderSpec.generatedBufferIntegrityCheck(sourceMap, minMap, {
      quality, sampleRate, expectedFrames: Math.floor(sampleRate * 0.5), requireSaved: true,
    });
    assert.equal(failedProducerIntegrity.ok, false, "the actual first-attempt consistency check keeps a malformed final channel count failing");
    assert.match(failedProducerIntegrity.detail, /source convBuf channels=1 expected=2/,
      "failure context preserves the original human-readable integrity reason");
    const marker = " | integrity-context=";
    const markerAt = failedProducerIntegrity.detail.lastIndexOf(marker);
    assert.notEqual(markerAt, -1, "the existing integrity failure receives appended diagnostic context");
    const diagnosticText = failedProducerIntegrity.detail.slice(markerAt + marker.length);
    const diagnostic = JSON.parse(diagnosticText);
    const stages = diagnostic.focus.stages;
    assert.equal(diagnostic.focus.build, "source");
    assert.equal(diagnostic.focus.buffer, "convBuf", "focus is the first failing build/buffer in fixed traversal order");
    assert.equal(diagnostic.counterpart.build, "min");
    assert.equal(diagnostic.counterpart.buffer, "convBuf");
    assert.equal(diagnostic.failure.slotCount, 2);
    assert.deepEqual(diagnostic.failure.slots, ["source/convBuf", "min/n1"],
      "context identifies multiple independently failing generated buffers with a bounded slot list");
    assert.equal(stages.digestCreated[5], true);
    assert.equal(stages.renderReturn[3], true);
    assert.equal(stages.combine[3], true);
    for (const stageName of ["beforeSave", "afterSave"]) {
      assert.deepEqual(stages[stageName].value.channels, {
        kind: "data", enumerable: true, configurable: false, writable: false, valueType: "number", value: 2,
      });
      assert.equal(stages[stageName].value.frozen, true);
      assert.equal(stages[stageName].mapSlot.own.kind, "data");
      assert.equal(stages[stageName].mapSlot.own.valueType, "object");
      assert.equal(stages[stageName].sameAsCreatedDigest, true);
    }
    assert.equal(stages.constructedRow.value.channels.value, 2);
    assert.equal(stages.afterInsert.value.channels.value, 2);
    assert.equal(stages.constructedRow.sameAsCreatedDigest, false);
    assert.equal(stages.afterInsert.sameAsCreatedDigest, false);
    assert.equal(stages.comparison.sameAsCreatedDigest, false);
    assert.equal(stages.beforeSave.value.objectPrototypeChannels.kind, "accessor");
    assert.equal(stages.beforeSave.value.objectPrototypeChannels.get, true);
    assert.equal(stages.beforeSave.value.objectPrototypeChannels.set, true);
    assert.equal(stages.beforeSave.mapSlot.objectPrototype.kind, "accessor");
    assert.equal(stages.beforeSave.mapSlot.objectPrototype.get, true);
    assert.equal(stages.beforeSave.mapSlot.objectPrototype.set, true);
    assert.equal(stages.comparison.value.channels.value, 1);
    assert.equal(stages.comparison.value.frozen, true);
    assert.equal(stages.comparison.mapSlot.own.valueType, "object");
    assert.equal(stages.comparison.mapSlot.objectPrototype.kind, "missing");
    assert.equal(stages.comparison.value.objectPrototypeChannels.kind, "missing");
    assert.equal(diagnostic.counterpart.comparison.value.channels.value, 2);
    assert.equal(diagnostic.counterpart.comparison.mapSlot.objectPrototype.kind, "missing");
    assert.equal(diagnostic.runtime.nodeOptionsSet, true);
    assert.equal(typeof diagnostic.runtime.nodeVersion, "string");
    assert.equal(typeof diagnostic.runtime.platform, "string");
    assert.equal(typeof diagnostic.runtime.arch, "string");
    assert.equal(diagnostic.runtime.preloadPresent, true);
    assert.equal(diagnostic.runtime.execArgvTruncated, true);
    assert.ok(diagnostic.runtime.execArgvFlags.includes("--require"));
    assert.ok(diagnostic.runtime.execArgvFlags.includes("--import"));
    assert.ok(diagnosticText.length <= 4096, "oversized argv input yields a bounded diagnostic context");
    assert.doesNotMatch(diagnosticText, /T6_PRIVATE|\/T6_PRIVATE|NODE_OPTIONS_DO_NOT_EMIT/,
      "runtime diagnostics do not emit supplied environment or argv values");

    const originalStringify = JSON.stringify;
    try {
      JSON.stringify = function (value, ...args) {
        if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "runtime") &&
            Object.prototype.hasOwnProperty.call(value, "failure")) throw new Error("T6_PRIVATE_DIAGNOSTIC_SERIALIZER_FAILURE");
        return originalStringify.call(this, value, ...args);
      };
      const serializationFailure = renderSpec.generatedBufferIntegrityCheck(sourceMap, minMap, {
        quality, sampleRate, expectedFrames: Math.floor(sampleRate * 0.5), requireSaved: true,
      });
      assert.equal(serializationFailure.ok, false, "context serialization failure cannot turn an integrity failure into a pass");
      assert.match(serializationFailure.detail, /source convBuf channels=1 expected=2/);
      assert.match(serializationFailure.detail, /integrity-context=\{"unavailable":true\}$/,
        "context serialization errors use a short bounded fallback");
      assert.doesNotMatch(serializationFailure.detail, /T6_PRIVATE_DIAGNOSTIC_SERIALIZER_FAILURE/);
    } finally {
      JSON.stringify = originalStringify;
    }
  } finally {
    Object.defineProperty(sourceMap, "convBuf", originalConvBufDescriptor);
    Object.defineProperty(minMap, "n1", originalN1Descriptor);
  }
  const pureMismatchOriginal = originalN1Descriptor.value;
  const differentSha = pureMismatchOriginal.sha256[0] === "0" ? "1" + pureMismatchOriginal.sha256.slice(1) : "0" + pureMismatchOriginal.sha256.slice(1);
  const changedNodeTrace = Object.freeze(Object.assign({}, pureMismatchOriginal.captureTrace.node, { sha256: differentSha }));
  const pureMismatchRow = Object.freeze(Object.assign({}, pureMismatchOriginal, {
    sha256: differentSha,
    captureTrace: Object.freeze(Object.assign({}, pureMismatchOriginal.captureTrace, { node: changedNodeTrace })),
  }));
  try {
    minMap.n1 = pureMismatchRow;
    const pureMismatch = renderSpec.generatedBufferIntegrityCheck(sourceMap, minMap, {
      quality, sampleRate, expectedFrames: Math.floor(sampleRate * 0.5), requireSaved: true,
    });
    assert.equal(pureMismatch.ok, false, "source/min metadata equality remains a separate integrity failure when each slot is internally consistent");
    assert.match(pureMismatch.detail, /^source\/min SHA-256 descriptors differ \| integrity-context=/);
    const contextText = pureMismatch.detail.slice(pureMismatch.detail.lastIndexOf(" | integrity-context=") + " | integrity-context=".length);
    const mismatchContext = JSON.parse(contextText);
    assert.equal(mismatchContext.focus.build, "source");
    assert.equal(mismatchContext.focus.buffer, "n1");
    assert.deepEqual(mismatchContext.failure.slots, ["source/n1", "min/n1"]);
    assert.equal(mismatchContext.counterpart.comparison.value.channels.value, 1);
    assert.ok(contextText.length <= 4096);
  } finally {
    Object.defineProperty(minMap, "n1", originalN1Descriptor);
  }
  const changedSidecar = path.join(path.dirname(resultFile), "chromium", persisted.find(([build, rel]) => build === "source" && rel.endsWith("-n1.f32le"))[1]);
  const originalSidecar = fs.readFileSync(changedSidecar);
  const alteredSidecar = Buffer.from(originalSidecar);
  alteredSidecar[0] ^= 1;
  fs.writeFileSync(changedSidecar, alteredSidecar);
  const alteredProblems = [];
  generatedBufferArtifactProblems("chromium", resultRel, resultFile, producerCase, dimensions, alteredProblems);
  assert.ok(alteredProblems.some((problem) => /source n1 raw byte SHA-256 is/.test(problem)),
    "aggregate rejects actual producer sidecar bytes changed after report serialization");
  assert.ok(alteredProblems.some((problem) => /source\/min n1 raw Float32 bytes differ/.test(problem)));
  fs.rmSync(artifactRoot, { recursive: true, force: true });
  const wrongProbe = structuredClone(observation);
  wrongProbe.settings.source.activeProbe.pitch = 70;
  assert.ok(renderBufferShaProblems(dimensions, wrongProbe, "producer control", { expectedSeed: seed }).some((problem) => /active reverb-probe settings/.test(problem)));
  const missingProbe = structuredClone(observation);
  delete missingProbe.settings.min;
  assert.ok(renderBufferShaProblems(dimensions, missingProbe, "producer control", { expectedSeed: seed }).some((problem) => /active reverb-probe settings/.test(problem)));
  const changedBrowserStage = structuredClone(observation);
  changedBrowserStage.builds.source.convBuf.captureTrace.browser.channels = 1;
  assert.ok(renderBufferShaProblems(dimensions, changedBrowserStage, "producer control", { expectedSeed: seed })
    .some((problem) => /browser-declared buffer dimensions\/length differ from Node-validated bytes/.test(problem)),
  "the aggregate reports a browser-stage channel contradiction without normalizing it");
  const changedFinalDescriptor = structuredClone(observation);
  changedFinalDescriptor.builds.source.convBuf.channels = 1;
  assert.ok(renderBufferShaProblems(dimensions, changedFinalDescriptor, "producer control", { expectedSeed: seed })
    .some((problem) => /final descriptor differs from the Node-validated capture-stage snapshot/.test(problem)),
  "the aggregate locates a post-Node descriptor mutation separately from browser-reported metadata");
});

test("gesture pre-input readiness waits for five page reports and remains bounded", async () => {
  const rec = { console: [] };
  for (let i = 0; i < 5; ++i) setTimeout(() => rec.console.push({
    text: "T6STATE " + JSON.stringify({ tag: "tick", index: i }),
  }), i * 20);
  const ready = await gestureSpec.waitForReports(rec, 5, 500);
  assert.equal(ready.timedOut, false);
  assert.equal(ready.reports.length, 5);
  assert.equal(ready.reports[4].index, 4);

  const sparse = await gestureSpec.waitForReports({ console: [] }, 5, 100);
  assert.equal(sparse.timedOut, true);
  assert.equal(sparse.reports.length, 0);
});

function testPcm(fixture, sampleRate) {
  const length = Math.ceil(fixture.renderDurationSec * sampleRate);
  const channels = [new Float32Array(length), new Float32Array(length)];
  function addTone(startSec, durationSec, pitch, amplitude) {
    const from = Math.round(startSec * sampleRate), to = Math.min(length, from + Math.round(durationSec * sampleRate));
    const hz = testAnalysis.midiHz(pitch);
    for (let i = from; i < to; ++i) {
      const value = amplitude * Math.sin(2 * Math.PI * hz * (i - from) / sampleRate);
      channels[0][i] += value;
      channels[1][i] += value;
    }
  }
  const songStart = Math.round(seedFullMixSpec.ORIGIN * sampleRate);
  const songEnd = Math.min(length, Math.round(fixture.songEndSec * sampleRate));
  const songHz = testAnalysis.midiHz(fixture.downbeat.expectedPitch);
  for (let i = songStart; i < songEnd; ++i) {
    const value = 0.1 * Math.sin(2 * Math.PI * songHz * (i - songStart) / sampleRate);
    channels[0][i] += value;
    channels[1][i] += value;
  }
  addTone(fixture.downbeat.onsetSec + fixture.downbeat.startOffsetSec,
    fixture.downbeat.durationSec, fixture.downbeat.expectedPitch, 0.1);
  for (const probe of fixture.probes) addTone(probe.startSec, 0.45, probe.expectedPitch, 0.08);
  return channels;
}

const TEST_TOLERANCES = {
  overallDb: 0.001, peakAbs: 0.01, windowFloor: 1e-8, windowDb: 0.1, noteWindowDb: 0.1,
  independentProbePitchCents: 35, downbeatBandDb: 0.1, probePitchCents: 0.1, transientEnvelopeDb: 0.1,
  balanceDb: 0.001, probeOnsetMs: 0.1, probeLevelDb: 0.1, probeEnvelopeDb: 0.1, relativeProbeDb: 0.001,
};
const syntheticEngines = {};
const testBrowserVersion = (engine) => TEST_TOOLCHAIN.browsers[engine].browserVersion;
function bundleWithRevision(bundle, revision) {
  const value = { ...bundle, revision: String(revision), bundleId: bundle.engine + "-" + revision };
  delete value.identitySha256;
  value.identitySha256 = stableSha256(Buffer.from(stableCanonical(value)));
  return value;
}
function bundleWithId(bundle, bundleId) {
  const value = { ...bundle, bundleId };
  delete value.identitySha256;
  value.identitySha256 = stableSha256(Buffer.from(stableCanonical(value)));
  return value;
}
for (const engine of ["chromium", "firefox", "webkit"]) {
  syntheticEngines[engine] = {};
  for (const fixture of seedFullMixSpec.FIXTURES) {
    syntheticEngines[engine][fixture.id] = {};
    for (const sampleRate of [44100, 48000]) {
      const metrics = seedFullMixSpec.analyzeChannels(testPcm(fixture, sampleRate), sampleRate, fixture);
      const metadata = {
        scope: "fixture", fixtureId: fixture.id, profileKind: fixture.profileKind, quality: 1,
        engine, browserVersion: testBrowserVersion(engine), platform: "linux-x64", sampleRate,
        browserBundle: testBrowserBundle(engine),
        captureToolchain: {
          source: "recorded-in-capture-matrixRun-browserToolchain", schemaVersion: 1,
          playwrightCoreVersion: TEST_TOOLCHAIN.playwrightCoreVersion,
          browsersManifestSha256: TEST_TOOLCHAIN.browsersManifestSha256,
          browserBundle: testBrowserBundle(engine),
        },
        midiSha256: fixture.midiSha256, setupSha256: fixture.setupSha256,
        settingsSha256: fixture.settingsSha256, probePlanSha256: fixture.probePlanSha256,
        seed: MATRIX.seed,
        methodSha256: fixture.methodSha256, toleranceSha256: fixture.toleranceSha256,
        referenceToleranceSha256: stableSha256(Buffer.from(stableCanonical(TEST_TOLERANCES))),
        playbackOriginSec: seedFullMixSpec.ORIGIN,
        captureRun: { runId: "synthetic-test", runAttempt: "1", workflowRef: "synthetic/test@refs/heads/test",
          eventName: "pull_request", testedSha: CONTEXT.testedSha, matrixConfigSha256: "c".repeat(64),
          browserToolchain: TEST_TOOLCHAIN,
          selection: { specs: ["full-mix"], seed: MATRIX.seed }, buildSha256: { source: "a".repeat(64), min: "b".repeat(64) } },
        captureReportSha256: "d".repeat(64), captureMethodSha256: fixture.methodSha256,
        captureToleranceSha256: fixture.toleranceSha256,
      };
      const capture = (build) => ({ path: engine + "/full-mix/" + fixture.id + "-" + sampleRate + "-" + build + "-first.wav",
        sha256: (build === "source" ? "d" : "e").repeat(64), pcmSha256: (build === "source" ? "f" : "0").repeat(64),
        bytes: 44 + Math.ceil(fixture.renderDurationSec * sampleRate) * 8,
        frames: Math.ceil(fixture.renderDurationSec * sampleRate), sampleRate,
        attempt: 1, firstAttempt: true, eligible: true, finite: true, overFullScaleSamples: 0,
        priorCaptureVerdict: "pass", captureMethodSha256: fixture.methodSha256 });
      syntheticEngines[engine][fixture.id][sampleRate] = {
        metadata,
        source: { capture: capture("source"), metrics },
        min: { capture: capture("min"), metrics },
      };
    }
  }
}
const TEST_REFERENCE = {
  schemaVersion: 2, scope: "fixture", status: "complete", analysisVersion: seedFullMixSpec.ANALYSIS_VERSION,
  methodSha256: seedFullMixSpec.FIXTURES[0].methodSha256,
  toleranceSha256: seedFullMixSpec.FIXTURES[0].toleranceSha256,
  referenceToleranceSha256: stableSha256(Buffer.from(stableCanonical(TEST_TOLERANCES))),
  coverage: { expectedCases: seedFullMixSpec.referenceExpectedCases(),
    measuredCases: seedFullMixSpec.referenceExpectedCases(), incompleteCases: [] },
  tolerances: TEST_TOLERANCES, engines: syntheticEngines,
};
fs.writeFileSync(TEST_REFERENCE_FILE, JSON.stringify(TEST_REFERENCE));
const TEST_REFERENCE_BYTES = Buffer.from(JSON.stringify(TEST_REFERENCE));
process.env.TINYSYNTH_BROWSER_MATRIX_REFERENCE = TEST_REFERENCE_FILE;
delete require.cache[require.resolve("../browser/specs/full-mix")];
delete require.cache[require.resolve("../../scripts/browser-matrix")];
const FULL_MIX = require("../browser/specs/full-mix");
const {
  shardLayout, selectedSpecs, parseArgs, expectedResultPaths, caseManifest, reportProvenance, readFloatStereoWav,
  renderBufferShaProblems, generatedBufferArtifactProblems, crossEngine, worker, validateFullMixCase,
} = require("../../scripts/browser-matrix");
const SCRIPT = path.join(H.ROOT, "scripts", "browser-matrix.js");
const SPECS = Object.keys(MATRIX.specs);
const ATTACHMENTS = new Map();
test.after(() => {
  if (previousReference === undefined) delete process.env.TINYSYNTH_BROWSER_MATRIX_REFERENCE;
  else process.env.TINYSYNTH_BROWSER_MATRIX_REFERENCE = previousReference;
  fs.rmSync(TEST_REFERENCE_DIR, { recursive: true, force: true });
});

function node(args, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: H.ROOT, encoding: "utf8", timeout: 60000, killSignal: "SIGKILL",
    env: Object.assign({}, process.env, env),
  });
  assert.equal(r.error, undefined, "child did not finish");
  return { status: r.status, out: r.stdout + r.stderr };
}

test("every spec belongs to exactly one shard, for several shard counts", () => {
  for (const n of [1, 2, 3, 4, 5]) {
    const layout = shardLayout(n);
    assert.equal(layout.length, n);
    const all = layout.flatMap((s) => s.specs);
    assert.deepEqual([...all].sort(), [...SPECS].sort(), "n=" + n);
    for (const s of layout) assert.ok(s.specs.length > 0, "empty shard at n=" + n);
  }
});

test("the layout is balanced and deterministic, and every spec has a measured duration", () => {
  for (const n of [2, 3, 4]) {
    const layout = shardLayout(n);
    const total = SPECS.reduce((a, s) => a + MATRIX.specs[s].seconds, 0);
    const longestSpec = Math.max(...SPECS.map((s) => MATRIX.specs[s].seconds));
    const longest = Math.max(...layout.map((s) => s.seconds));
    assert.ok(longest <= total / n + longestSpec, "n=" + n + ": " + longest + " s vs " + total / n);
  }
  assert.deepEqual(shardLayout(3), shardLayout(3));
  for (const s of SPECS) assert.ok(MATRIX.specs[s].seconds > 0, s);
});

test("--shard selects the spec part of both the assert and observe selection", () => {
  const layout = shardLayout(MATRIX.shards);
  for (let k = 1; k <= MATRIX.shards; ++k) {
    const mine = new Set(layout[k - 1].specs);
    const assertSpecs = selectedSpecs(parseArgs(["--shard=" + k + "/" + MATRIX.shards]));
    assert.ok(assertSpecs.length > 0 && assertSpecs.every((s) => mine.has(s) && MATRIX.specs[s].kind === "assert"));
    const observe = selectedSpecs(parseArgs(["--specs=hang,variation", "--shard=" + k + "/" + MATRIX.shards]));
    assert.deepEqual(observe, ["hang", "variation"].filter((s) => mine.has(s)));
  }
  const union = Array.from({ length: MATRIX.shards }, (_, i) => i + 1)
    .flatMap((k) => selectedSpecs(parseArgs(["--observe", "--shard=" + k + "/" + MATRIX.shards])));
  assert.deepEqual([...union].sort(), SPECS.filter((s) => s !== "full-mix").sort());
  assert.deepEqual(selectedSpecs(parseArgs([])), SPECS.filter((s) => s !== "full-mix" && MATRIX.specs[s].kind === "assert"));
  assert.deepEqual(selectedSpecs(parseArgs(["--mode=full-mix-qualification", "--shard=1/1"])), ["render", "full-mix"]);
});

test("shard result expectations match the producer's actual provenance spec order", () => {
  for (const [rel, expected] of expectedResultPaths()) {
    const args = ["--shard=" + expected.index + "/" + expected.total];
    if (expected.step === "browser-observe") args.unshift("--specs=hang,variation");
    const options = parseArgs(args);
    const produced = reportProvenance(options, [expected.engine], CONTEXT);
    assert.deepEqual(produced.selection.specs, expected.specs, rel);
  }
});

test("bad --shard values and a merge without explicit expected context are refused", () => {
  for (const bad of ["0/3", "4/3", "1/0", "x"]) assert.throws(() => parseArgs(["--shard=" + bad]), undefined, bad);
  assert.throws(() => shardLayout(SPECS.length + 1), /empty/);
  assert.throws(() => parseArgs(["--merge=/tmp/results"]), /--expected-context/);
  assert.throws(() => parseArgs(["--mode=core", "--specs=full-mix"]), /requires --mode=full-mix-qualification/);
  assert.throws(() => parseArgs(["--mode=full-mix-qualification", "--specs=render"]), /selects only the render and full-mix assert specs/);
  assert.throws(() => parseArgs(["--mode=full-mix-qualification", "--observe"]), /selects only the render and full-mix assert specs/);
  assert.throws(() => parseArgs(["--mode=qualification"]), /--mode must be core or full-mix-qualification/);
});

test("--list --shard prints the declared layout without launching a browser", () => {
  const r = node(["--list", "--shard=2/" + MATRIX.shards]);
  assert.equal(r.status, 0, r.out);
  for (let k = 1; k <= MATRIX.shards; ++k) assert.match(r.out, new RegExp("shard " + k + "/" + MATRIX.shards));
});

test("worker guard accepts an observed declared-override version but stays strict for pinned and blank versions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-worker-version-"));
  const packageDir = path.join(root, "node_modules", "playwright-core");
  fs.mkdirSync(packageDir, { recursive: true });
  const entry = path.join(packageDir, "index.js");
  const pathsFile = path.join(packageDir, "paths.json");
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "playwright-core", version: "1.63.0" }));
  fs.writeFileSync(path.join(packageDir, "browsers.json"), JSON.stringify({ browsers: [
    { name: "chromium-headless-shell", revision: "1243", browserVersion: "153.0.8010.12" },
    { name: "firefox", revision: "1543", browserVersion: "155.0" },
    { name: "webkit", revision: "2359", revisionOverrides: { mac14: "2251" }, browserVersion: "26.6" },
  ] }));
  fs.writeFileSync(entry, [
    '"use strict";',
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'module.exports = Object.fromEntries(["chromium", "firefox", "webkit"].map((engine) => [engine, { executablePath: () => JSON.parse(fs.readFileSync(path.join(__dirname, "paths.json"), "utf8"))[engine] }]));',
  ].join("\n"));
  const paths = { chromium: "/cache/chromium-1243/chrome-linux64/chrome", firefox: "/cache/firefox-1543/firefox/firefox" };
  const casesModule = require("../browser/lib/cases");
  const browserServer = require("../../scripts/browser-server");
  const oldSession = casesModule.EngineSession;
  const oldStartServer = browserServer.startServer;
  const oldSpecifier = process.env.PLAYWRIGHT_CORE;
  let runtimeVersion = "";
  let serverStarted = false;
  casesModule.EngineSession = class MockEngineSession {
    constructor() { this.version = runtimeVersion; this.relaunches = 0; this.fatal = null; }
    async launch() {}
    async closeBrowser() { return true; }
  };
  browserServer.startServer = async () => {
    serverStarted = true;
    return { requests: [], close: async () => {} };
  };
  process.env.PLAYWRIGHT_CORE = entry;
  const run = async (webkitPath, version, label) => {
    runtimeVersion = version;
    fs.writeFileSync(pathsFile, JSON.stringify({ ...paths, webkit: webkitPath }));
    serverStarted = false;
    const resultsFile = path.join(root, label + ".json");
    await worker({ engine: "webkit", out: null, results: resultsFile, seed: MATRIX.seed,
      overrides: {}, specs: [], mode: "core", observe: false, shard: null });
    return { results: JSON.parse(fs.readFileSync(resultsFile, "utf8")), serverStarted };
  };
  try {
    const override = await run("/cache/webkit_mac14_special-2251/pw_run.sh", "synthetic-platform-version", "override");
    assert.equal(override.results.browserBundle.browserVersion, null);
    assert.equal(override.results.version, "synthetic-platform-version");
    assert.equal(override.results.launchError, null);
    assert.equal(override.serverStarted, true, "the nonempty observed override version proceeds past the worker launch guard");

    const blank = await run("/cache/webkit_mac14_special-2251/pw_run.sh", "", "blank");
    assert.match(blank.results.launchError, /reported browser version .* differs from pinned/);
    assert.equal(blank.serverStarted, false, "a blank runtime version is rejected before the matrix starts");

    const mismatch = await run("/cache/webkit-2359/pw_run.sh", "26.7", "default-mismatch");
    assert.match(mismatch.results.launchError, /differs from pinned webkit-2359 version 26.6/);
    assert.equal(mismatch.serverStarted, false, "default-version pins remain exact");
  } finally {
    if (oldSpecifier === undefined) delete process.env.PLAYWRIGHT_CORE;
    else process.env.PLAYWRIGHT_CORE = oldSpecifier;
    casesModule.EngineSession = oldSession;
    browserServer.startServer = oldStartServer;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function measurements() {
  return Object.assign({ linearity: { ratio: 0.5, makeup: 1 } }, Object.fromEntries(GROUPS.map((key) => [key, {
    rms: Array(key === "gm-drums" ? 47 : 32).fill(0.1), peaks: Array(key === "gm-drums" ? 47 : 32).fill(0.2),
  }])));
}

function artifactReference(engine, index, step, fixture, sampleRate, build, attempt, channels) {
  const wav = testAnalysis.wav(channels, sampleRate);
  const artifactRoot = path.posix.join("browser-results-" + engine + "-" + index, step, engine);
  const fakeWorker = { save: (rel, data) => {
    ATTACHMENTS.set(path.posix.join(artifactRoot, rel), data);
    return path.posix.join(artifactRoot, rel);
  } };
  return FULL_MIX.caseRecord({ build, rawWav: wav, channels }, attempt === 1 ? "first" : "diagnostic-repeat",
    fakeWorker, fixture, sampleRate);
}

function fakeFullMixCase(def, engine, index, step) {
  const currentFullMix = require("../browser/specs/full-mix");
  const expected = FULL_MIX.expectedCases().find((x) => x.id === def.id);
  const fixture = FULL_MIX.FIXTURE_BY_ID[expected.fixtureId];
  const channels = testPcm(fixture, expected.sampleRate);
  const metrics = JSON.parse(JSON.stringify(syntheticEngines[engine][fixture.id][expected.sampleRate].source.metrics));
  const pcmHashes = channels.map((x) => testAnalysis.sha256(x));
  const sourceMin = FULL_MIX.sameEnginePcm(channels, channels, engine);
  const notes = fixture.notes.map((note) => ({ id: note.id, status: "created", channel: note.channel,
    pitch: note.pitch, velocity: note.velocity, program: note.program, actualProgram: note.program,
    onsetSec: note.onsetSec, sourceCount: note.channel === 9 ? 1 : 2, percussion: note.channel === 9, pruned: false }));
  const noteInstances = { rows: notes, extras: [], expectedCount: notes.length, createdCount: notes.length,
    prunedInstances: [], complete: true };
  const probes = fixture.probes.map((probe) => ({ id: probe.id, status: "created", channel: probe.channel,
    pitch: probe.pitch, velocity: probe.velocity, program: probe.program, actualProgram: probe.program,
    onsetSec: probe.startSec, sourceCount: 2, pruned: false }));
  const probeInstances = { rows: probes, expectedCount: probes.length, createdCount: probes.length,
    prunedInstances: [], complete: true };
  const faultSensitivity = FULL_MIX.faultSensitivity(channels, expected.sampleRate, fixture, metrics, noteInstances);
  const builds = {};
  for (const build of ["source", "min"]) {
    const artifact = artifactReference(engine, index, step, fixture, expected.sampleRate, build, 1, channels);
    const diagnosticArtifact = artifactReference(engine, index, step, fixture, expected.sampleRate, build, 2, channels);
    const sameEngine = FULL_MIX.sameEnginePcm(channels, channels, engine);
    builds[build] = {
      attempt: 1, firstAttempt: true, result: "pass", preBaselineEligible: true, metrics,
      noteInstances, probeInstances, artifact, pcmSha256: pcmHashes,
      midiMessagesSent: fixture.notes.length, parsedEventCount: fixture.notes.length,
      intervalCount: 1, rejections: [], pageErrors: [], aborted: [], sourceMinPcmComparison: sourceMin,
      referenceStatus: "measured", comparisonProblems: [],
      diagnosticRepeat: { attempt: 2, role: "diagnostic-only", result: "captured", firstVerdict: "pass",
        neverPromotesFirstAttempt: true, artifact: diagnosticArtifact, metrics, noteInstances,
        sameEnginePcm: sameEngine },
      faultSensitivity,
    };
  }
  return {
    schemaVersion: 2, scope: "fixture", qualification: "fixture-only-no-production-approval",
    fixtureId: fixture.id, profileKind: fixture.profileKind, label: fixture.label,
    sampleRate: expected.sampleRate, quality: 1, seed: MATRIX.seed, engine,
    browserVersion: testBrowserVersion(engine), platform: "linux-x64", browserBundle: testBrowserBundle(engine),
    midiSha256: fixture.midiSha256, setupSha256: fixture.setupSha256, settingsSha256: fixture.settingsSha256,
    probePlanSha256: fixture.probePlanSha256, methodSha256: fixture.methodSha256, toleranceSha256: fixture.toleranceSha256,
    masterVol: fixture.settings.masterVol, reverbLev: fixture.settings.reverbLev, playbackOriginSec: FULL_MIX.ORIGIN,
    songEndSec: fixture.songEndSec, durationSec: fixture.renderDurationSec,
    input: { midiPath: fixture.id === "tinychip-ws-mid" ? "tests/fixtures/consumer/waves-song.mid" : "ws.mid",
      setupProvenance: fixture.setupProvenance, noteCount: fixture.notes.length },
    noteTiming: { complete: fixture.timingComplete, unmatchedNoteOffs: fixture.unmatchedNoteOffs,
      unpitchedOneShotCount: fixture.unpitchedOneShotCount,
      ambiguousPairings: fixture.notes.filter((n) => n.pairingAmbiguous).length,
      durationUnknown: fixture.notes.filter((n) => n.durationSec === null).length,
      overlapWindowClaims: "mixed-bus features only; not proof each voice sounded" },
    voiceDemand: { noteOnCount: fixture.notes.length, maxKnownSimultaneousNotes: fixture.maxKnownSimultaneous,
      liveBudget: fixture.liveVoices, offlineCeiling: fixture.offlineVoices,
      offlineCeilingDerivation: "all independently parsed fixture note-ons (including drums) + two appended probe note-ons + one spare; not the live/realtime budget" },
    isolatedProbeContract: { channels: seedFullMixSpec.PROBE_CHANNELS, startsAfterSongAndTail: true,
      probes: fixture.probes,
      relativeLevelScope: "isolated fixture-timbre level comparison through the common output graph; not musical-part balance or composer approval",
      quietWindows: metrics.isolation },
    setupProvenance: fixture.setupProvenance, firstAttempt: true, captureEligiblePreBaseline: true, status: "pass",
    referenceProvenance: currentFullMix.referenceProvenance(),
    referenceToleranceSha256: currentFullMix.referenceProvenance().referenceToleranceSha256,
    builds, sourceMinPcmComparison: sourceMin, fullMix: metrics,
    rawArtifacts: Object.fromEntries(["source", "min"].map((build) => [build, builds[build].artifact])),
    faultSensitivity, incompleteCriteria: ["fixture only", "physical devices are not covered", "musical-part balance remains incomplete"],
  };
}

function fakeCase(def, engine, index, step) {
  const c = {
    id: def.id, spec: def.spec, kind: def.kind, dims: def.dims,
    status: def.kind === "observe" ? "observed" : "pass", seconds: 2,
    checks: def.kind === "observe" ? [] : [{ name: "synthetic pass", ok: true, detail: "fixture report" }],
    observations: {},
  };
  if (def.spec === "render") {
    c.observations.measurements = measurements();
    const expected = SEED_EXPECTED.hashes[def.dims.sampleRate][MATRIX.seed];
    const artifactRoot = path.posix.join("browser-results-" + engine + "-" + index, step, engine);
    const buffers = (build) => Object.fromEntries(["convBuf", "n0", "n1"].map((name) => {
      const channels = seedReference[name](MATRIX.seed, def.dims.sampleRate);
      const bytes = Buffer.from(float32Digest.planarFloat32Bytes(channels));
      const rel = "generated-buffers/q" + def.dims.quality + "-" + def.dims.sampleRate + "-reverb-" + build + "-" + name + ".f32le";
      ATTACHMENTS.set(path.posix.join(artifactRoot, rel), bytes);
      const measurement = float32Digest.sha256Base64Planar(bytes.toString("base64"), channels.length, channels[0].length);
      assert.equal(measurement.sha256, expected[name]);
      return [name, { ...measurement,
        captureTrace: {
          browser: { channels: channels.length, frames: channels[0].length, byteLength: bytes.length, base64Chars: bytes.toString("base64").length },
          node: { channels: measurement.channels, frames: measurement.frames, byteLength: measurement.byteLength,
            decodedByteLength: bytes.length, sha256: measurement.sha256 },
        },
        artifact: { path: rel, saved: true } }];
    }));
    const reverb = SCENARIOS.find((scenario) => scenario.name === "reverb");
    const probeSettings = renderSpec.bufferCaptureSettings(renderSpec.renderSpec(reverb,
      { seed: MATRIX.seed, sr: def.dims.sampleRate, quality: def.dims.quality }));
    c.observations["generated buffer SHA-256 (first reverb-enabled attempt)"] = {
      schemaVersion: 1,
      method: "sha256-f32le-planar-channel-order-v1",
      producer: "node-crypto-after-browser-byte-transfer",
      encoding: "IEEE-754 binary32 little-endian; planar channel-index order; sample bytes only",
      scenarioId: "reverb",
      attempt: 1,
      firstAttempt: true,
      settings: { source: probeSettings, min: probeSettings },
      builds: { source: buffers("source"), min: buffers("min") },
    };
  }
  if (def.spec === "full-mix") {
    c.observations.fullMix = fakeFullMixCase(def, engine, index, step);
    for (const build of ["source", "min"]) c.checks.push({
      name: build + " first attempt completed without scheduler, rejection, page error or network request",
      ok: true, detail: "synthetic passing fixture",
    });
  }
  return c;
}

function result(engine, index, step, specs, mode = "core") {
  const total = mode === "full-mix-qualification" ? 1 : MATRIX.shards;
  const opts = { mode, shard: { k: index, n: total }, specs, seed: MATRIX.seed, overrides: {} };
  const cases = caseManifest(engine, specs).map((def) => fakeCase(def, engine, index, step));
  return {
    matrixRun: require("../../scripts/browser-matrix").reportProvenance(opts, [engine], CONTEXT),
    [engine]: { engine, version: testBrowserVersion(engine), platform: "linux-x64", browserBundle: testBrowserBundle(engine), cases },
  };
}

/* Results directory laid out exactly as actions/download-artifact produces it. */
function merged(change, expectedReferenceBytes = TEST_REFERENCE_BYTES, afterWrite = null, reportMode = "core", mergeMode = reportMode, childEnv = {}, acceptKnownFailures = false) {
  ATTACHMENTS.clear();
  fs.writeFileSync(TEST_REFERENCE_FILE, expectedReferenceBytes);
  delete require.cache[require.resolve("../browser/specs/full-mix")];
  delete require.cache[require.resolve("../../scripts/browser-matrix")];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-matrix-merge-"));
  const contextFile = path.join(dir, "expected-context.json");
  fs.writeFileSync(contextFile, JSON.stringify(CONTEXT));
  const files = {};
  for (const [rel, expected] of expectedResultPaths(reportMode))
    files[rel] = result(expected.engine, expected.index, expected.step, expected.specs, reportMode);
  if (reportMode === "full-mix-qualification") {
    const remapped = new Map();
    for (const [rel, data] of ATTACHMENTS) {
      const match = /^browser-results-(chromium|firefox|webkit)-\d+\/browser-matrix\/(.+)$/.exec(rel);
      remapped.set(match ? path.posix.join("full-mix-qualification-" + match[1], "browser-matrix", match[2]) : rel, data);
    }
    ATTACHMENTS.clear();
    for (const [rel, data] of remapped) ATTACHMENTS.set(rel, data);
  }
  if (change) change(files);
  for (const [rel, data] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
  }
  for (const [rel, data] of ATTACHMENTS) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  }
  if (afterWrite) afterWrite(dir);
  const args = ["--mode=" + mergeMode, "--merge=" + dir, "--expected-context=" + contextFile];
  if (acceptKnownFailures) args.unshift("--accept-known-failures");
  const r = node(args, childEnv);
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

function qualificationMerged(change, referenceBytes = TEST_REFERENCE_BYTES, afterWrite = null, mergeMode = "full-mix-qualification", childEnv = {}) {
  return merged(change, referenceBytes, afterWrite, "full-mix-qualification", mergeMode, childEnv);
}

function provenanceWithMissingReference(file, engine, specs) {
  const code = "const m=require(" + JSON.stringify(SCRIPT) + ");" +
    "const opts={mode:'full-mix-qualification',shard:{k:1,n:1},specs:" + JSON.stringify(specs) + ",seed:" + MATRIX.seed + ",overrides:{}};" +
    "process.stdout.write(JSON.stringify(m.reportProvenance(opts,[" + JSON.stringify(engine) + "]," + JSON.stringify(CONTEXT) + ")));";
  const r = spawnSync(process.execPath, ["-e", code], {
    cwd: H.ROOT, encoding: "utf8", timeout: 60000, killSignal: "SIGKILL",
    env: Object.assign({}, process.env, { TINYSYNTH_BROWSER_MATRIX_REFERENCE: file }),
  });
  assert.equal(r.error, undefined, "absent-reference provenance process did not finish");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout);
}

async function withFullMixReference(file, callback) {
  const modulePath = require.resolve("../browser/specs/full-mix");
  const cached = require.cache[modulePath];
  const previous = process.env.TINYSYNTH_BROWSER_MATRIX_REFERENCE;
  process.env.TINYSYNTH_BROWSER_MATRIX_REFERENCE = file;
  delete require.cache[modulePath];
  try { return await callback(require(modulePath)); }
  finally {
    if (previous === undefined) delete process.env.TINYSYNTH_BROWSER_MATRIX_REFERENCE;
    else process.env.TINYSYNTH_BROWSER_MATRIX_REFERENCE = previous;
    delete require.cache[modulePath];
    if (cached) require.cache[modulePath] = cached;
  }
}

const first = (files, engine, spec) => Object.entries(files).find(([, data]) => data[engine] && data[engine].cases.some((c) => c.spec === spec));

function mutateKnownRenderFailure(files, { descriptor = true, caseId = "render q0 44100",
  group = knownFailurePolicy.RENDER_GROUP, item = group + " program 121 source/min", pairIndex = 1 } = {}) {
  const found = Object.entries(files).find(([, report]) => report.webkit &&
    report.webkit.cases.some((c) => c.id === caseId));
  assert.ok(found, "synthetic WebKit q0/44.1 kHz render report exists");
  const [rel, report] = found;
  const c = report.webkit.cases.find((item) => item.id === caseId);
  const tolerance = tolerances("webkit").sameEngineSample;
  const root = rel.split("/")[0];
  const sampleRate = c.dims.sampleRate;
  const frames = Math.floor(1.6 * sampleRate);
  const samples = Float32Array.from({ length: frames }, (_, i) => i % 2 ? 0.125 : -0.125);
  const sourcePlanar = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const minSamples = Float32Array.from(samples);
  minSamples[14112] += 0.001;
  const reason = FIRST_ATTEMPT.compareRenders({ channels: [samples] }, { channels: [minSamples] }, tolerance).reasons[0];
  const minPlanar = Buffer.from(minSamples.buffer, minSamples.byteOffset, minSamples.byteLength);
  const wavs = { a: testAnalysis.wav([samples], sampleRate), b: testAnalysis.wav([minSamples], sampleRate) };
  const pairBase = "first-attempt-pcm/q" + c.dims.quality + "-" + sampleRate + "/pair-" + String(pairIndex).padStart(3, "0");
  const sides = {};
  for (const [key, role, suffix] of [["a", "source", "first-a.wav"], ["b", "min", "first-b.wav"]]) {
    const file = pairBase + "-" + suffix;
    ATTACHMENTS.set(path.posix.join(root, "browser-matrix", "webkit", file), wavs[key]);
    const planar = key === "a" ? sourcePlanar : minPlanar;
    sides[key] = {
      channelFrames: [frames], channels: 1, frames, path: file, pcmBytes: planar.length,
      planarPcmSha256: stableSha256(planar), role, sampleRate, saved: true,
      wavBytes: wavs[key].length, wavSha256: stableSha256(wavs[key]),
    };
  }
  const pcmRetention = {
    schemaVersion: 1, pairIndex, label: item,
    planarPcmEncoding: "IEEE-754 binary32 little-endian; planar channel order",
    roles: { a: "source", b: "min" }, saved: true, status: "saved", a: sides.a, b: sides.b,
  };
  const outcome = {
    item,
    firstAttempt: { reasons: [reason], pcmRetention },
    outcome: FIRST_ATTEMPT.OUTCOMES.INTERMITTENT,
    attempts: 2,
    diagnostics: [{ attempt: 2, ok: true, reasons: [] }],
  };
  const summary = {
    items: 268, firstAttemptFailures: 1, intermittent: 1, reproduced: 0, notRerendered: 0,
    diagnosticRenderAttempts: 1, rendersIncludingFirstAttempts: 269,
    diagnosticBudget: { total: 6, unspent: 5 }, failures: [outcome],
  };
  c.observations[knownFailurePolicy.FAILURE_OBSERVATION] = summary;
  const measurements = c.observations.measurements;
  const row = measurements[group];
  delete measurements[group];
  measurements[group + "/source"] = structuredClone(row);
  measurements[group + "/min"] = structuredClone(row);
  const groupCheck = group + ": min renders the same PCM as source (max |diff| <= " + String(tolerance) + ")";
  c.checks = [
    { name: knownFailurePolicy.BUFFER_CHECK, ok: false, detail: "synthetic final convBuf channel metadata contradiction" },
    { name: knownFailurePolicy.SEED_CHECK, ok: false, detail: "generated-buffer integrity prerequisite failed" },
    { name: groupCheck, ok: false,
      detail: item + ": " + reason + " (first attempt; " + FIRST_ATTEMPT.SHORT[outcome.outcome] + ")" },
  ];
  c.status = "fail";
  if (descriptor) {
    c.observations[knownFailurePolicy.BUFFER_OBSERVATION].builds.source.convBuf.channels = 1;
  } else {
    c.checks = c.checks.filter((check) => check.name !== knownFailurePolicy.BUFFER_CHECK && check.name !== knownFailurePolicy.SEED_CHECK);
  }
  return {
    report: c, resultPath: rel,
    wavPaths: [sides.a.path, sides.b.path].map((file) => path.posix.join(root, "browser-matrix", "webkit", file)),
    attachmentPaths: [sides.a.path, sides.b.path].map((file) => path.posix.join(root, "browser-matrix", "webkit", file)),
  };
}

function mutateKnownDrumFailure(files) {
  const [rel, report] = Object.entries(files).find(([, row]) => row.webkit &&
    row.webkit.cases.some((c) => c.id === "render q1 48000"));
  const c = report.webkit.cases.find((row) => row.id === "render q1 48000");
  const frames = 76800, sampleRate = 48000, group = knownFailurePolicy.DRUM_GROUP;
  const source = Float32Array.from({ length: frames }, (_, i) => i % 2 ? 0.125 : -0.125);
  const min = Float32Array.from(source);
  min[20512] += 0.006789;
  const pairs = [
    { suffix: "source/min", roles: { a: "source", b: "min" }, channels: { a: source, b: min },
      assertion: "min renders the same PCM as source" },
    { suffix: "repeat", roles: { a: "repeat", b: "kept source" }, channels: { a: min, b: source },
      assertion: "a repeat render in a fresh page matches" },
  ];
  c.status = "fail";
  c.checks = [];
  const failures = pairs.map((pair, i) => {
    const item = group + " drum 54 " + pair.suffix, pairIndex = i + 1;
    const pcmRetention = { schemaVersion: 1, pairIndex, label: item,
      planarPcmEncoding: "IEEE-754 binary32 little-endian; planar channel order",
      roles: pair.roles, saved: true, status: "saved" };
    for (const key of ["a", "b"]) {
      const samples = pair.channels[key], bytes = testAnalysis.wav([samples], sampleRate);
      const file = "first-attempt-pcm/q1-48000/pair-" + String(pairIndex).padStart(3, "0") + "-first-" + key + ".wav";
      ATTACHMENTS.set(path.posix.join(rel.split("/")[0], "browser-matrix", "webkit", file), bytes);
      pcmRetention[key] = { channelFrames: [frames], channels: 1, frames, path: file,
        pcmBytes: frames * 4, planarPcmSha256: stableSha256(bytes.subarray(44)), role: pair.roles[key],
        sampleRate, saved: true, wavBytes: bytes.length, wavSha256: stableSha256(bytes) };
    }
    const reasons = FIRST_ATTEMPT.compareRenders({ channels: [pair.channels.a] },
      { channels: [pair.channels.b] }, tolerances("webkit").sameEngineSample).reasons;
    const failure = { item, firstAttempt: { reasons, pcmRetention }, outcome: FIRST_ATTEMPT.OUTCOMES.INTERMITTENT,
      attempts: 2, diagnostics: [{ attempt: 2, ok: true, reasons: [] }] };
    c.checks.push({ name: group + ": " + pair.assertion + " (max |diff| <= 0.000001)", ok: false,
      detail: item + ": " + reasons[0] + " (first attempt; " + FIRST_ATTEMPT.SHORT[failure.outcome] + ")" });
    return failure;
  });
  c.observations[knownFailurePolicy.FAILURE_OBSERVATION] = {
    items: 268, firstAttemptFailures: 2, intermittent: 2, reproduced: 0, notRerendered: 0,
    diagnosticRenderAttempts: 2, rendersIncludingFirstAttempts: 270,
    diagnosticBudget: { total: 6, unspent: 4 }, failures,
  };
  const row = c.observations.measurements[group];
  delete c.observations.measurements[group];
  c.observations.measurements[group + "/source"] = structuredClone(row);
  c.observations.measurements[group + "/min"] = structuredClone(row);
  return { report: c, resultPath: rel };
}

function mutateKnownDrum58Failure(files, { withProgram127 = false } = {}) {
  let gm;
  if (withProgram127) {
    gm = mutateKnownRenderFailure(files, { descriptor: false, caseId: "render q0 48000",
      item: knownFailurePolicy.RENDER_GROUP + " program 127 source/min" });
    gm.checks = structuredClone(gm.report.checks);
    gm.summary = structuredClone(gm.report.observations[knownFailurePolicy.FAILURE_OBSERVATION]);
  }
  const drum = mutateKnownRenderFailure(files, { descriptor: false, caseId: "render q0 48000",
    group: knownFailurePolicy.DRUM_GROUP, item: "gm-drums drum 58 source/min", pairIndex: withProgram127 ? 2 : 1 });
  if (gm) {
    const summary = drum.report.observations[knownFailurePolicy.FAILURE_OBSERVATION];
    summary.failures.unshift(...gm.summary.failures);
    summary.firstAttemptFailures = summary.intermittent = summary.diagnosticRenderAttempts = 2;
    summary.rendersIncludingFirstAttempts = 270;
    summary.diagnosticBudget.unspent = 4;
    drum.report.checks.unshift(...gm.checks);
  }
  return drum;
}

function mutateKnownShortNotesFailure(files, item = "q1 126") {
  const found = Object.entries(files).find(([, report]) => report.webkit &&
    report.webkit.cases.some((c) => c.id === "short-notes completed min"));
  assert.ok(found, "synthetic WebKit completed-min report exists");
  const [rel, report] = found;
  const c = report.webkit.cases.find((row) => row.id === "short-notes completed min");
  const tolerance = tolerances("webkit").sameEngineSample;
  const reason = "max |diff| 0.001 > " + String(tolerance);
  const failure = {
    item,
    firstAttempt: { reasons: [reason] },
    outcome: FIRST_ATTEMPT.OUTCOMES.INTERMITTENT,
    attempts: 2,
    diagnostics: [{ attempt: 2, ok: true, reasons: [] }],
  };
  c.observations[knownFailurePolicy.SHORT_FAILURE_OBSERVATION] = {
    items: 128, firstAttemptFailures: 1, intermittent: 1, reproduced: 0, notRerendered: 0,
    diagnosticRenderAttempts: 1, rendersIncludingFirstAttempts: 129,
    diagnosticBudget: { total: 6, unspent: 5 }, failures: [failure],
  };
  c.status = "fail";
  c.checks = [{ name: knownFailurePolicy.SHORT_CHECK, ok: false,
    detail: item + ": " + reason + " [" + FIRST_ATTEMPT.SHORT[failure.outcome] + "]" }];
  return { report: c, resultPath: rel };
}

test("core merge preserves the existing assert matrix without requiring unfinished full-mix references", () => {
  const partial = JSON.parse(TEST_REFERENCE_BYTES.toString("utf8"));
  delete partial.engines.webkit["ws-mid-default"][48000];
  partial.status = "incomplete";
  partial.coverage.measuredCases = partial.coverage.measuredCases.filter((x) => x !== "webkit/ws-mid-default/48000");
  partial.coverage.incompleteCases = [{ id: "webkit/ws-mid-default/48000", firstAttemptStatus: "fail", reason: "retained first attempt" }];
  const r = merged(undefined, Buffer.from(JSON.stringify(partial)));
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Cross-engine comparison \(merged shards\)/);
  assert.match(r.out, /GM per-slot energy spread/);
  assert.match(r.out, /PASS: browser matrix shards/);
  assert.equal([...ATTACHMENTS.keys()].some((key) => key.includes("chromium/full-mix/")), false);
});

test("opt-in core merge accepts the exact combined descriptor and first-GM failure while keeping raw verdicts", () => {
  const strict = merged((files) => { mutateKnownRenderFailure(files); });
  assert.equal(strict.status, 1, strict.out);

  let rawCase;
  const accepted = merged((files) => { rawCase = mutateKnownRenderFailure(files).report; },
    TEST_REFERENCE_BYTES, null, "core", "core", {}, true);
  assert.equal(accepted.status, 0, accepted.out);
  assert.match(accepted.out, /PASS WITH ACCEPTED KNOWN FAILURES/);
  assert.match(accepted.out, /known failures: documented exceptions enabled for ordinary core mode/);
  assert.match(accepted.out, /raw case failures retained/);
  assert.match(accepted.out, /WARN: accepted known failure; raw checks and case status remain failed: webkit\/render q0 44100/);
  assert.equal(rawCase.status, "fail");
  assert.equal(rawCase.checks.filter((check) => check.ok === false).length, 3);

  const unknown = merged((files) => {
    const fixture = mutateKnownRenderFailure(files);
    fixture.report.checks.push({ name: "unrecognized synthetic failure", ok: false, detail: "must remain blocking" });
  }, TEST_REFERENCE_BYTES, null, "core", "core", {}, true);
  assert.equal(unknown.status, 1, unknown.out);
  assert.match(unknown.out, /unrecognized synthetic failure|remains a blocking raw failure/);
});

test("known render exceptions reject malformed or empty intermittent diagnostics", () => {
  for (const mutateSummary of [
    (summary) => {
      const failure = summary.failures[0];
      failure.attempts = 1;
      failure.diagnostics = [];
      summary.diagnosticRenderAttempts = 0;
      summary.rendersIncludingFirstAttempts = summary.items;
    },
    (summary) => { summary.failures[0].diagnostics[0].reasons = ["contradicts ok=true"]; },
  ]) {
    const rejected = merged((files) => {
      const fixture = mutateKnownRenderFailure(files);
      mutateSummary(fixture.report.observations[knownFailurePolicy.FAILURE_OBSERVATION]);
    }, TEST_REFERENCE_BYTES, null, "core", "core", {}, true);
    assert.equal(rejected.status, 1, rejected.out);
    assert.match(rejected.out, /failed check: .*same PCM as source|remains a blocking raw failure/);
  }
});

test("known render exceptions require present, hash-matching retained first-attempt WAVs", () => {
  for (const corruption of ["missing", "tampered"]) {
    let wavPath;
    const rejected = merged((files) => { wavPath = mutateKnownRenderFailure(files).wavPaths[0]; },
      TEST_REFERENCE_BYTES,
      (dir) => {
        const file = path.join(dir, wavPath);
        if (corruption === "missing") fs.rmSync(file);
        else {
          const bytes = fs.readFileSync(file);
          bytes[44] ^= 1;
          fs.writeFileSync(file, bytes);
        }
      }, "core", "core", {}, true);
    assert.equal(rejected.status, 1, rejected.out);
    assert.match(rejected.out, /known first-attempt PCM WAV is missing or invalid/);
  }
  for (const contradiction of ["identical", "wrong-difference", "wrong-index"]) {
    const rejected = merged((files) => {
      const fixture = mutateKnownRenderFailure(files, { descriptor: false });
      const failure = fixture.report.observations[knownFailurePolicy.FAILURE_OBSERVATION].failures[0];
      if (contradiction === "identical") {
        const bytes = Buffer.from(ATTACHMENTS.get(fixture.attachmentPaths[0]));
        ATTACHMENTS.set(fixture.attachmentPaths[1], bytes);
        failure.firstAttempt.pcmRetention.b.wavSha256 = stableSha256(bytes);
        failure.firstAttempt.pcmRetention.b.planarPcmSha256 = stableSha256(bytes.subarray(44));
      } else {
        const reason = failure.firstAttempt.reasons[0];
        failure.firstAttempt.reasons[0] = contradiction === "wrong-difference"
          ? reason.replace("1.000e-3", "2.000e-3") : reason.replace("sample 14112", "sample 14113");
        assert.notEqual(failure.firstAttempt.reasons[0], reason);
        fixture.report.checks[0].detail = failure.item + ": " + failure.firstAttempt.reasons[0] +
          " (first attempt; " + FIRST_ATTEMPT.SHORT[failure.outcome] + ")";
      }
    }, TEST_REFERENCE_BYTES, null, "core", "core", {}, true);
    assert.equal(rejected.status, 1, rejected.out);
    assert.match(rejected.out, /reported first failure differs from recomputed raw PCM comparison/);
  }
});

test("short-notes q1/program126 is accepted without a nonexistent PCM retention schema", () => {
  let rawCase;
  const accepted = merged((files) => { rawCase = mutateKnownShortNotesFailure(files).report; },
    TEST_REFERENCE_BYTES, null, "core", "core", {}, true);
  assert.equal(accepted.status, 0, accepted.out);
  assert.match(accepted.out, /PASS WITH ACCEPTED KNOWN FAILURES/);
  assert.equal(rawCase.status, "fail");
  assert.equal(rawCase.checks[0].ok, false);

  const unlisted = merged((files) => { mutateKnownShortNotesFailure(files, "q1 127"); },
    TEST_REFERENCE_BYTES, null, "core", "core", {}, true);
  assert.equal(unlisted.status, 1, unlisted.out);
  assert.match(unlisted.out, /failed check: every program with an attack/);
});

test("drum58 q0/48 kHz accepts only source/min with retained raw failures and strict-default rejection", () => {
  const strict = merged((files) => { mutateKnownDrum58Failure(files); });
  assert.equal(strict.status, 1, strict.out);
  let rawCase;
  const accepted = merged((files) => { rawCase = mutateKnownDrum58Failure(files).report; },
    TEST_REFERENCE_BYTES, null, "core", "core", {}, true);
  assert.equal(accepted.status, 0, accepted.out);
  assert.match(accepted.out, /PASS WITH ACCEPTED KNOWN FAILURES/);
  assert.equal(rawCase.status, "fail");
  assert.equal(rawCase.checks[0].ok, false);
  assert.match(accepted.out, /webkit-drum58-q0-48000-first-attempt/);
  for (const mutate of [
    (c) => { c.observations[knownFailurePolicy.FAILURE_OBSERVATION].failures[0].item = "gm-drums drum 59 source/min"; },
    (c) => { c.dims.quality = 1; },
    (c) => { c.dims.sampleRate = 44100; },
    (c) => { c.checks[0].name = "gm-drums: a repeat render in a fresh page matches (max |diff| <= 0.000001)"; },
    (c) => { c.observations.measurements["gm-drums/min"].peaks.pop(); },
  ]) {
    const rejected = merged((files) => { mutate(mutateKnownDrum58Failure(files).report); },
      TEST_REFERENCE_BYTES, null, "core", "core", {}, true);
    assert.equal(rejected.status, 1, rejected.out);
  }
});

test("combined approved GM127 and drum58 failures validate both groups and every retained pair", () => {
  const accepted = merged((files) => { mutateKnownDrum58Failure(files, { withProgram127: true }); },
    TEST_REFERENCE_BYTES, null, "core", "core", {}, true);
  assert.equal(accepted.status, 0, accepted.out);
  assert.match(accepted.out, /PASS WITH ACCEPTED KNOWN FAILURES/);
  let secondPair;
  const missing = merged((files) => {
    secondPair = mutateKnownDrum58Failure(files, { withProgram127: true }).wavPaths[1];
  }, TEST_REFERENCE_BYTES, (dir) => { fs.rmSync(path.join(dir, secondPair)); }, "core", "core", {}, true);
  assert.equal(missing.status, 1, missing.out);
  assert.match(missing.out, /known first-attempt PCM WAV is missing or invalid/);
});

test("short-note q1/program120 keeps raw failure; approved 120/126 combinations cannot hide other programs", () => {
  const strict = merged((files) => { mutateKnownShortNotesFailure(files, "q1 120"); });
  assert.equal(strict.status, 1, strict.out);
  let rawCase;
  const accepted = merged((files) => { rawCase = mutateKnownShortNotesFailure(files, "q1 120").report; },
    TEST_REFERENCE_BYTES, null, "core", "core", {}, true);
  assert.equal(accepted.status, 0, accepted.out);
  assert.equal(rawCase.status, "fail");
  assert.equal(rawCase.checks[0].ok, false);
  const combined = (files, other) => {
    const { report } = mutateKnownShortNotesFailure(files, "q1 120");
    const summary = report.observations[knownFailurePolicy.SHORT_FAILURE_OBSERVATION];
    const second = structuredClone(summary.failures[0]); second.item = other;
    summary.failures.push(second);
    summary.firstAttemptFailures = summary.intermittent = summary.diagnosticRenderAttempts = 2;
    summary.rendersIncludingFirstAttempts = 130;
    summary.diagnosticBudget.unspent = 4;
    report.checks[0].detail = summary.failures.map((f) => f.item + ": " + f.firstAttempt.reasons[0] +
      " [" + FIRST_ATTEMPT.SHORT[f.outcome] + "]").join(", ");
  };
  const both = merged((files) => { combined(files, "q1 126"); }, TEST_REFERENCE_BYTES, null, "core", "core", {}, true);
  assert.equal(both.status, 0, both.out);
  for (const other of ["q1 121", "q0 120", "q1 120"]) {
    const rejected = merged((files) => { combined(files, other); }, TEST_REFERENCE_BYTES, null, "core", "core", {}, true);
    assert.equal(rejected.status, 1, rejected.out);
  }
});

test("known-failure acceptance still blocks corrupt Float32 sidecars, stale provenance and non-finite retained PCM", () => {
  const corruptSidecar = merged((files) => {
    const fixture = mutateKnownRenderFailure(files);
    const row = fixture.report.observations[knownFailurePolicy.BUFFER_OBSERVATION].builds.source.n0;
    const attachment = path.posix.join(fixture.resultPath.split("/")[0], "browser-matrix", "webkit", row.artifact.path);
    const bytes = Buffer.from(ATTACHMENTS.get(attachment));
    bytes[0] ^= 1;
    ATTACHMENTS.set(attachment, bytes);
  }, TEST_REFERENCE_BYTES, null, "core", "core", {}, true);
  assert.equal(corruptSidecar.status, 1, corruptSidecar.out);
  assert.match(corruptSidecar.out, /raw byte SHA-256|raw Float32 bytes differ/);

  const staleProvenance = merged((files) => {
    const fixture = mutateKnownRenderFailure(files);
    files[fixture.resultPath].matrixRun.testedSha = "a".repeat(40);
  }, TEST_REFERENCE_BYTES, null, "core", "core", {}, true);
  assert.equal(staleProvenance.status, 1, staleProvenance.out);
  assert.match(staleProvenance.out, /stale or forged testedSha/);

  const nonFiniteRetainedPcm = merged((files) => {
    const fixture = mutateKnownRenderFailure(files);
    const retention = fixture.report.observations[knownFailurePolicy.FAILURE_OBSERVATION].failures[0].firstAttempt.pcmRetention;
    const attachment = fixture.attachmentPaths[0];
    const bytes = Buffer.from(ATTACHMENTS.get(attachment));
    bytes.writeFloatLE(NaN, 44);
    retention.a.wavSha256 = stableSha256(bytes);
    retention.a.planarPcmSha256 = stableSha256(bytes.subarray(44));
    ATTACHMENTS.set(attachment, bytes);
  }, TEST_REFERENCE_BYTES, null, "core", "core", {}, true);
  assert.equal(nonFiniteRetainedPcm.status, 1, nonFiniteRetainedPcm.out);
  assert.match(nonFiniteRetainedPcm.out, /raw first-attempt PCM contains a non-finite sample/);
});

test("drum-54 exception preserves both first failures and rejects other scopes or contradictory repeat captures", () => {
  const strict = merged((files) => { mutateKnownDrumFailure(files); });
  assert.equal(strict.status, 1, strict.out);
  let rawCase, rawJson;
  const accepted = merged((files) => {
    rawCase = mutateKnownDrumFailure(files).report;
    rawJson = JSON.stringify(rawCase);
  }, TEST_REFERENCE_BYTES, null, "core", "core", {}, true);
  assert.equal(accepted.status, 0, accepted.out);
  assert.match(accepted.out, /PASS WITH ACCEPTED KNOWN FAILURES/);
  assert.equal(JSON.stringify(rawCase), rawJson);
  assert.equal(rawCase.status, "fail");
  assert.equal(rawCase.checks.filter((check) => check.ok === false).length, 2);
  const classify = (engine, c) => knownFailurePolicy.classifyKnownCase(engine, c);
  for (const scope of ["drum", "quality", "rate", "engine", "check", "measurement-count"]) {
    const c = structuredClone(rawCase);
    let engine = "webkit";
    if (scope === "drum") c.observations[knownFailurePolicy.FAILURE_OBSERVATION].failures[0].item = "gm-drums drum 55 source/min";
    if (scope === "quality") { c.dims.quality = 0; c.id = "render q0 48000"; }
    if (scope === "rate") { c.dims.sampleRate = 44100; c.id = "render q1 44100"; }
    if (scope === "engine") engine = "firefox";
    if (scope === "check") c.checks.push({ name: "new drum regression", ok: false });
    if (scope === "measurement-count") c.observations.measurements["gm-drums/min"].rms.pop();
    assert.equal(classify(engine, c), null, scope + " must remain blocking");
  }
  for (const corruption of ["roles", "missing", "kept-source"]) {
    const rejected = merged((files) => {
      const fixture = mutateKnownDrumFailure(files);
      const c = fixture.report, failure = c.observations[knownFailurePolicy.FAILURE_OBSERVATION].failures[1];
      const retention = failure.firstAttempt.pcmRetention;
      const file = path.posix.join(fixture.resultPath.split("/")[0], "browser-matrix", "webkit", retention.b.path);
      if (corruption === "roles") retention.roles.b = "min";
      if (corruption === "missing") ATTACHMENTS.delete(file);
      if (corruption === "kept-source") {
        const bytes = Buffer.from(ATTACHMENTS.get(file));
        bytes.writeFloatLE(bytes.readFloatLE(44 + 20513 * 4) + 0.001, 44 + 20513 * 4);
        ATTACHMENTS.set(file, bytes);
        retention.b.wavSha256 = stableSha256(bytes);
        retention.b.planarPcmSha256 = stableSha256(bytes.subarray(44));
        // The maximum and first-difference index are unchanged: only the independent kept-source identity detects this.
      }
    }, TEST_REFERENCE_BYTES, null, "core", "core", {}, true);
    assert.equal(rejected.status, 1, rejected.out);
    assert.match(rejected.out, /PCM retention record|PCM WAV is missing or invalid|does not compare against the kept first source/);
  }
});

test("known-failure opt-in is core-only and full-mix qualification remains strict", () => {
  assert.equal(parseArgs(["--accept-known-failures"]).acceptKnownFailures, true);
  assert.throws(() => parseArgs(["--mode=full-mix-qualification", "--accept-known-failures"]),
    /available only in ordinary core mode/);
  const cli = node(["--mode=full-mix-qualification", "--accept-known-failures"]);
  assert.equal(cli.status, 2);
  assert.match(cli.out, /available only in ordinary core mode/);
});

test("core and qualification artifacts cannot satisfy each other's independently expected mode", () => {
  const coreAsQualification = merged(null, TEST_REFERENCE_BYTES, null, "core", "full-mix-qualification");
  assert.equal(coreAsQualification.status, 1, coreAsQualification.out);
  assert.match(coreAsQualification.out, /required shard result is missing|unexpected result path/);
  const qualificationAsCore = merged(null, TEST_REFERENCE_BYTES, null, "full-mix-qualification", "core");
  assert.equal(qualificationAsCore.status, 1, qualificationAsCore.out);
  assert.match(qualificationAsCore.out, /required shard result is missing|unexpected result path/);
  const forgedMode = qualificationMerged((files) => {
    const [rel, report] = first(files, "chromium", "render");
    report.matrixRun.selection.mode = "core";
    files[rel] = report;
  });
  assert.equal(forgedMode.status, 1, forgedMode.out);
  assert.match(forgedMode.out, /declared selection does not match the required shard configuration/);
  const forgedReference = qualificationMerged((files) => {
    const [rel, report] = first(files, "webkit", "full-mix");
    report.matrixRun.fullMixReference.sha256 = "0".repeat(64);
    files[rel] = report;
  });
  assert.equal(forgedReference.status, 1, forgedReference.out);
  assert.match(forgedReference.out, /full-mix reference provenance differs from the aggregate checkout/);
});

test("reference selection and coverage reject self-consistent prior capture method identities", () => {
  assert.deepEqual(FULL_MIX.referenceCoverageProblems(TEST_REFERENCE), [],
    "the synthetic current-method reference remains a valid positive fixture");
  const fixture = FULL_MIX.FIXTURE_BY_ID["tinychip-ws-mid"];
  const sampleRate = 44100;
  const caseId = "chromium/" + fixture.id + "/" + sampleRate;
  const mutations = [
    ["historical metadata capture method", (entry) => {
      const priorMethod = "e".repeat(64);
      entry.metadata.captureMethodSha256 = priorMethod;
      entry.source.capture.captureMethodSha256 = priorMethod;
      entry.min.capture.captureMethodSha256 = priorMethod;
    },
      "captureMethodSha256 is not the current fixture method", "input, engine, version, method or historical capture identity"],
    ["historical metadata capture tolerance", (entry) => { entry.metadata.captureToleranceSha256 = "f".repeat(64); },
      "captureToleranceSha256 is not the current fixture tolerance", "input, engine, version, method or historical capture identity"],
    ["historical source capture method", (entry) => { entry.source.capture.captureMethodSha256 = "e".repeat(64); },
      "first-attempt capture eligibility", "source lacks eligible first-attempt raw capture provenance"],
    ["historical min capture method", (entry) => { entry.min.capture.captureMethodSha256 = "e".repeat(64); },
      "first-attempt capture eligibility", "min lacks eligible first-attempt raw capture provenance"],
  ];
  for (const [label, mutate, selectedReason, coverageReason] of mutations) {
    const reference = structuredClone(TEST_REFERENCE);
    const entry = reference.engines.chromium[fixture.id][sampleRate];
    mutate(entry);
    const selection = FULL_MIX.selectReference(reference, { ...entry.metadata }, label.includes(" min ") ? "min" : "source");
    assert.equal(selection.status, "incomplete", label);
    assert.match(selection.problems.join(" "), new RegExp(selectedReason));
    assert.ok(FULL_MIX.referenceCoverageProblems(reference).some((problem) =>
      problem.includes("reference case " + caseId) && problem.includes(coverageReason)), label);
  }
});

test("qualification merge uses the same strict aggregate for render headroom and full-mix evidence", () => {
  const r = qualificationMerged();
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /PASS: browser matrix shards/);
  assert.match(r.out, /render q1 44100/);
  assert.match(r.out, /spec full-mix\s+assert\s+\[build x sampleRate\]\s+run/);
  assert.ok([...ATTACHMENTS.keys()].some((key) => key.includes("chromium/full-mix/")));
  const present = reportProvenance({ mode: "full-mix-qualification", shard: { k: 1, n: 1 },
    specs: ["render", "full-mix"], seed: MATRIX.seed, overrides: {} }, ["chromium"], CONTEXT);
  assert.deepEqual(present.fullMixReference, FULL_MIX.referenceProvenance());
  assert.equal(present.fullMixReference.status, "present");
});

test("qualification eligibility is recomputed from manifest rows and first-attempt cleanliness", () => {
  const mutations = [
    ["missing observation seed", (_row, _fixture, _sampleRate, fullMix) => { delete fullMix.seed; }, /fullMix seed is missing or mismatched/],
    ["alternate observation seed", (_row, _fixture, _sampleRate, fullMix) => { fullMix.seed = MATRIX.seed + 1; }, /fullMix seed is missing or mismatched/],
    ["string observation seed", (_row, _fixture, _sampleRate, fullMix) => { fullMix.seed = String(MATRIX.seed); }, /fullMix seed is missing or mismatched/],
    ["null observation seed", (_row, _fixture, _sampleRate, fullMix) => { fullMix.seed = null; }, /fullMix seed is missing or mismatched/],
    ["native channel", (row) => { row.noteInstances.rows[0].channel = (row.noteInstances.rows[0].channel + 1) % 16; }, /actual native voice\/source creation/],
    ["native pitch", (row) => { row.noteInstances.rows[0].pitch += 1; }, /actual native voice\/source creation/],
    ["native velocity", (row) => { row.noteInstances.rows[0].velocity -= 1; }, /actual native voice\/source creation/],
    ["native expected program", (row) => { row.noteInstances.rows[0].program += 1; }, /actual native voice\/source creation/],
    ["native actual program", (row) => { row.noteInstances.rows[0].actualProgram += 1; }, /actual native voice\/source creation/],
    ["native percussion marker", (row) => { row.noteInstances.rows[0].percussion = !row.noteInstances.rows[0].percussion; }, /actual native voice\/source creation/],
    ["native sample onset", (row, fixture, sampleRate) => {
      const onset = fixture.notes[0].onsetSec;
      row.noteInstances.rows[0].onsetSec = (Math.round(onset * sampleRate) + 2) / sampleRate;
    }, /actual native voice\/source creation/],
    ["native prune marker", (row) => { row.noteInstances.rows[0].pruned = true; }, /actual native voice\/source creation/],
    ["probe channel", (row) => { row.probeInstances.rows[0].channel = (row.probeInstances.rows[0].channel + 1) % 16; }, /actual isolated-probe voice\/source creation/],
    ["probe pitch", (row) => { row.probeInstances.rows[0].pitch += 1; }, /actual isolated-probe voice\/source creation/],
    ["probe velocity", (row) => { row.probeInstances.rows[0].velocity -= 1; }, /actual isolated-probe voice\/source creation/],
    ["probe expected program", (row) => { row.probeInstances.rows[0].program += 1; }, /actual isolated-probe voice\/source creation/],
    ["probe actual program", (row) => { row.probeInstances.rows[0].actualProgram += 1; }, /actual isolated-probe voice\/source creation/],
    ["probe sample onset", (row, fixture, sampleRate) => {
      const onset = fixture.probes[0].startSec;
      row.probeInstances.rows[0].onsetSec = (Math.round(onset * sampleRate) + 2) / sampleRate;
    }, /actual isolated-probe voice\/source creation/],
    ["probe prune marker", (row) => { row.probeInstances.rows[0].pruned = true; }, /actual isolated-probe voice\/source creation/],
    ["scheduler interval", (row) => { row.intervalCount = 2; }, /scheduler, rejection, page-error or network-abort/],
    ["MIDI rejection", (row) => { row.rejections = ["rejected event"]; }, /scheduler, rejection, page-error or network-abort/],
    ["page error", (row) => { row.pageErrors = ["synthetic page error"]; }, /scheduler, rejection, page-error or network-abort/],
    ["network abort", (row) => { row.aborted = ["https://example.invalid/unexpected"]; }, /scheduler, rejection, page-error or network-abort/],
    ["missing page diagnostics", (row) => { delete row.pageErrors; }, /scheduler, rejection, page-error or network-abort/],
    ["fault verdict", (row) => { row.faultSensitivity.checksPass = false; }, /fault-sensitivity schema or verdict/],
    ["fault child result", (row) => { row.faultSensitivity.relativeProbe.relativeRejected = false; }, /fault-sensitivity schema or verdict/],
  ];
  const expected = FULL_MIX.expectedCases().find((item) => item.fixtureId === "tinychip-ws-mid" && item.sampleRate === 44100);
  const caseDef = { id: expected.id, spec: "full-mix", kind: "assert", dims: expected.dims };
  ATTACHMENTS.clear();
  const validCase = fakeCase(caseDef, "chromium", 1, "browser-matrix");
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), "full-mix-eligibility-fixture-"));
  const resultFile = path.join(reportDir, "browser-results-chromium-1", "browser-matrix", "results.json");
  const rel = "browser-results-chromium-1/browser-matrix/results.json";
  try {
    for (const [artifact, bytes] of ATTACHMENTS) {
      const file = path.join(reportDir, ...artifact.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
    }
    const validate = (change) => {
      const item = JSON.parse(JSON.stringify(validCase));
      const row = item.observations.fullMix.builds.source;
      if (change) change(row, FULL_MIX.FIXTURE_BY_ID[expected.fixtureId], expected.sampleRate, item.observations.fullMix);
      const problems = [];
      validateFullMixCase("chromium", testBrowserVersion("chromium"), "linux-x64", testBrowserBundle("chromium"),
        rel, resultFile, item, expected, problems);
      return problems.join("\n");
    };
    assert.equal(validate(null), "", "the unmodified retained fixture must reach the valid aggregate boundary");
    for (const [label, change, failure] of mutations) {
      const problems = validate(change);
      assert.match(problems, failure, label);
    }
  } finally {
    fs.rmSync(reportDir, { recursive: true, force: true });
  }
});

test("missing reference survives a complete mocked full-mix run and fails strict aggregate", async () => {
  const missingReference = path.join(TEST_REFERENCE_DIR, "unavailable-qualification-reference.json");
  await withFullMixReference(missingReference, async (spec) => {
    const fixture = spec.FIXTURE_BY_ID["tinychip-ws-mid"];
    const sampleRate = 44100;
    const channels = testPcm(fixture, sampleRate);
    const songEndFrame = Math.round(fixture.songEndSec * sampleRate);
    for (const channel of channels) for (let i = 0; i < channel.length; ++i)
      channel[i] *= i < songEndFrame ? 5 : 0.25;
    const pcm = channels.map((x) => Buffer.from(x.buffer, x.byteOffset, x.byteLength).toString("base64"));
    const noteCreations = fixture.notes.map((note) => ({ channel: note.channel, pitch: note.pitch,
      velocity: note.velocity, timeSec: note.onsetSec, program: note.program, created: true,
      sourceCount: note.channel === 9 ? 1 : 2, percussion: note.channel === 9 }));
    const probeCreations = fixture.probes.map((probe) => ({ channel: probe.channel, pitch: probe.pitch,
      velocity: probe.velocity, timeSec: probe.startSec, program: probe.program, created: true, sourceCount: 2 }));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "full-mix-no-reference-run-"));
    const observations = [], checks = [], saved = [];
    const shared = { matrix: { sampleRates: [sampleRate], builds: ["source", "min"] },
      options: { seed: MATRIX.seed, overrides: {} }, engine: "chromium", version: testBrowserVersion("chromium"),
      platform: "linux-x64", browserBundle: testBrowserBundle("chromium") };
    const t = {
      ...shared,
      shared,
      newPage: async () => ({ page: { setContent: async () => {}, evaluate: async () => ({ pcm,
        noteCreations: [...noteCreations, ...probeCreations], prunedInstances: [], midiMessagesSent: fixture.notes.length,
        eventCount: fixture.notes.length, intervalCount: 1, rejections: [] }) }, pageErrors: [], aborted: [] }),
      save: (rel, bytes) => {
        const file = path.join(outputDir, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes);
        saved.push({ rel, file });
        return rel;
      },
      check: (name, ok, detail) => checks.push({ name, ok, detail }),
      note: () => {},
      observe: (name, value) => observations.push({ name, value: JSON.parse(JSON.stringify(value)) }),
    };
    try {
      const testCase = spec.cases(shared).find((item) => item.id === "full-mix tinychip-ws-mid q1 44100");
      assert.ok(testCase, "mock selected a declared full-mix case");
      await testCase.run(t);
      assert.equal(observations.length, 1, "the real case runner reaches t.observe(fullMix)");
      assert.equal(observations[0].name, "fullMix");
      const { value } = observations[0];
      assert.deepEqual(value.referenceProvenance, { schemaVersion: 1, source: "external-override", status: "absent",
        sha256: null, referenceToleranceSha256: null });
      assert.equal(value.referenceToleranceSha256, null);
      assert.equal(value.captureEligiblePreBaseline, true,
        "a missing comparison reference does not erase otherwise-valid first-capture eligibility: " +
          JSON.stringify({ checks: checks.filter((check) => !check.ok), faultSensitivity: value.faultSensitivity,
            noteTiming: value.noteTiming, voiceDemand: value.voiceDemand }));
      assert.equal(value.status, "incomplete");
      assert.equal(value.builds.source.referenceStatus, "incomplete");
      assert.equal(value.builds.min.referenceStatus, "incomplete");
      assert.equal(value.builds.source.result, "incomplete");
      assert.equal(value.builds.min.result, "incomplete");
      assert.equal(value.faultSensitivity.relativeProbe.relativeRejected, true);
      assert.equal(value.faultSensitivity.relativeProbe.wholeRenderRmsStillWithinPolicy, true);
      assert.ok(checks.some((check) => /agrees with measured engine\/build/.test(check.name) && !check.ok),
        "missing reference remains a failed comparison check");
      for (const build of ["source", "min"]) {
        const first = saved.find((item) => item.rel.endsWith(build + "-first.wav"));
        assert.ok(first && fs.readFileSync(first.file).toString("ascii", 0, 4) === "RIFF",
          "first-attempt raw WAV was retained for " + build);
      }
      assert.equal(saved.length, 4, "both first attempts and diagnostic-only repeats retain their separate WAVs");
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  const r = qualificationMerged((files) => {
    for (const [rel, report] of Object.entries(files)) {
      const expected = expectedResultPaths("full-mix-qualification").get(rel);
      const meta = provenanceWithMissingReference(missingReference, expected.engine, expected.specs);
      report.matrixRun = meta;
      const c = report[expected.engine].cases.find((item) => item.spec === "full-mix");
      if (!c) continue;
      c.status = "fail";
      c.checks = [{ name: "first attempt agrees with measured engine/build song and probe reference", ok: false,
        detail: "incomplete: measured reference is missing" }];
      const obs = c.observations.fullMix;
      obs.referenceProvenance = meta.fullMixReference;
      obs.referenceToleranceSha256 = null;
      obs.status = "incomplete";
      for (const build of ["source", "min"]) {
        obs.builds[build].referenceStatus = "incomplete";
        obs.builds[build].result = "incomplete";
        obs.builds[build].comparisonProblems = ["measured reference is missing"];
      }
      files[rel] = report;
    }
  }, TEST_REFERENCE_BYTES, null, "full-mix-qualification", {
    TINYSYNTH_BROWSER_MATRIX_REFERENCE: missingReference,
  });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /full-mix reference: measured full-mix reference is missing/);
  assert.match(r.out, /first-attempt result is incomplete/);
  assert.doesNotMatch(r.out, /cannot fingerprint current browser configuration/);
  assert.doesNotMatch(r.out, /full-mix reference provenance differs from the aggregate checkout/);
});

test("qualification merge rejects full-mix WAVs uploaded to the old sibling directory", () => {
  const r = qualificationMerged((files) => {
    const [resultPath, report] = first(files, "firefox", "full-mix");
    const observation = report.firefox.cases.find((c) => c.spec === "full-mix").observations.fullMix;
    const row = observation.builds.source;
    const enginePath = path.posix.join(path.posix.dirname(resultPath), "firefox", row.artifact.path);
    const oldSiblingPath = path.posix.join(path.posix.dirname(resultPath), row.artifact.path);
    ATTACHMENTS.set(oldSiblingPath, ATTACHMENTS.get(enginePath));
    ATTACHMENTS.delete(enginePath);
    files[resultPath] = report;
  });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /raw audio artifact is missing or invalid/);
});

test("qualification merge rejects WAVs reached through a parent symlink", () => {
  let relativeArtifact;
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-wav-symlink-"));
  try {
    const r = qualificationMerged((files) => {
      const [resultPath, report] = first(files, "webkit", "full-mix");
      const row = report.webkit.cases.find((c) => c.spec === "full-mix").observations.fullMix.builds.source;
      relativeArtifact = path.posix.join(path.posix.dirname(resultPath), "webkit", row.artifact.path);
      files[resultPath] = report;
    }, TEST_REFERENCE_BYTES, (dir) => {
      const wavDir = path.join(dir, ...relativeArtifact.split("/").slice(0, -1));
      const relocated = path.join(outside, "full-mix");
      fs.renameSync(wavDir, relocated);
      fs.symlinkSync(relocated, wavDir, "dir");
    });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /raw audio artifact is missing or invalid: artifact path contains a symbolic link/);
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});

test("merge verifies retained generated-buffer bytes, descriptors and source/min payloads", () => {
  const mutate = (kind) => merged((files) => {
    const [resultPath, report] = first(files, "chromium", "render");
    const c = report.chromium.cases.find((row) => row.spec === "render");
    const obs = c.observations["generated buffer SHA-256 (first reverb-enabled attempt)"];
    const row = obs.builds.source.convBuf;
    const attachmentPath = path.posix.join(path.posix.dirname(resultPath), "chromium", row.artifact.path);
    if (kind === "missing") ATTACHMENTS.delete(attachmentPath);
    else if (kind === "altered") {
      const bytes = Buffer.from(ATTACHMENTS.get(attachmentPath));
      bytes[0] ^= 1;
      ATTACHMENTS.set(attachmentPath, bytes);
    } else if (kind === "extra") {
      ATTACHMENTS.set(attachmentPath, Buffer.concat([ATTACHMENTS.get(attachmentPath), Buffer.alloc(4)]));
    } else if (kind === "truncated") {
      ATTACHMENTS.set(attachmentPath, ATTACHMENTS.get(attachmentPath).subarray(0, -4));
    } else if (kind === "unaligned") {
      ATTACHMENTS.set(attachmentPath, ATTACHMENTS.get(attachmentPath).subarray(0, -1));
    } else if (kind === "nonfinite") {
      const bytes = Buffer.from(ATTACHMENTS.get(attachmentPath));
      bytes.writeFloatLE(Infinity, 0);
      ATTACHMENTS.set(attachmentPath, bytes);
      row.sha256 = stableSha256(bytes);
    } else if (kind === "channels") row.channels = 1;
    else if (kind === "dimension") c.dims.sampleRate = 1000000;
    else if (kind === "source-min") {
      const min = obs.builds.min.convBuf;
      const minPath = path.posix.join(path.posix.dirname(resultPath), "chromium", min.artifact.path);
      const bytes = Buffer.from(ATTACHMENTS.get(minPath));
      bytes[0] ^= 1;
      ATTACHMENTS.set(minPath, bytes);
    }
    files[resultPath] = report;
  });
  for (const [kind, expected] of [
    ["missing", /raw Float32 buffer bytes are missing or invalid/],
    ["altered", /raw byte SHA-256 is/],
    ["extra", /raw Float32 buffer bytes are missing or invalid: artifact byte length is .* expected .* artifact was not read/],
    ["truncated", /raw Float32 buffer bytes are missing or invalid: artifact byte length is .* expected .* artifact was not read/],
    ["unaligned", /raw Float32 buffer bytes are missing or invalid: artifact byte length is .* expected .* artifact was not read/],
    ["dimension", /generated-buffer artifacts were not read because downloaded dimensions differ from the independent manifest/],
    ["nonfinite", /raw Float32 bytes contain a non-finite sample/],
    ["channels", /source convBuf channel count is 1, expected 2/],
    ["source-min", /source\/min convBuf raw Float32 bytes differ/],
  ]) {
    const r = mutate(kind);
    assert.equal(r.status, 1, kind + ": " + r.out);
    assert.match(r.out, expected, kind);
  }
});

test("merge refuses generated-buffer artifacts reached through a parent symlink", () => {
  let relativeArtifact;
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-buffer-symlink-"));
  try {
    const r = merged((files) => {
      const [resultPath, report] = first(files, "chromium", "render");
      const c = report.chromium.cases.find((row) => row.spec === "render");
      relativeArtifact = path.posix.join(path.posix.dirname(resultPath), "chromium",
        c.observations["generated buffer SHA-256 (first reverb-enabled attempt)"].builds.source.convBuf.artifact.path);
      files[resultPath] = report;
    }, TEST_REFERENCE_BYTES, (dir) => {
      const generatedDir = path.join(dir, ...relativeArtifact.split("/").slice(0, -1));
      const relocated = path.join(outside, "generated-buffers");
      fs.renameSync(generatedDir, relocated);
      fs.symlinkSync(relocated, generatedDir, "dir");
    });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /raw Float32 buffer bytes are missing or invalid: artifact path contains a symbolic link/);
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});

test("qualification merge rejects an explicit partial reference even when all downloaded shards are complete", () => {
  const partial = JSON.parse(TEST_REFERENCE_BYTES.toString("utf8"));
  const missing = "webkit/ws-mid-default/48000";
  delete partial.engines.webkit["ws-mid-default"][48000];
  partial.status = "incomplete";
  partial.coverage.measuredCases = partial.coverage.measuredCases.filter((x) => x !== missing);
  partial.coverage.incompleteCases = [{ id: missing, firstAttemptStatus: "fail",
    reason: "first attempt has two over-full-scale channel samples at one frame" }];
  const r = qualificationMerged(undefined, Buffer.from(JSON.stringify(partial)));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /measured full-mix reference is incomplete \(11\/12 engine\/fixture\/rate cases\)/);
  assert.match(r.out, /producer reference status differs from the aggregate's exact identity selection/);
});

test("merge fails when an expected engine/shard/step artifact is absent", () => {
  const r = merged((files) => { delete files[Object.keys(files).find((k) => k.startsWith("browser-results-webkit-2/"))]; });
  assert.equal(r.status, 1);
  assert.match(r.out, /required shard result is missing/);
});

test("merge fails when no results exist", () => {
  const r = merged((files) => { for (const k of Object.keys(files)) delete files[k]; });
  assert.equal(r.status, 1);
  assert.match(r.out, /FAIL: browser matrix shards/);
});

test("merge fails on failed status, missing cases, duplicate cases and altered dimensions", () => {
  let r = merged((files) => {
    const [k, v] = first(files, "firefox", "render");
    v.firefox.cases[0].status = "fail";
    files[k] = v;
  });
  assert.equal(r.status, 1);
  assert.match(r.out, /invalid status fail/);
  r = merged((files) => {
    const [k, v] = first(files, "chromium", "render");
    v.chromium.cases.splice(v.chromium.cases.findIndex((c) => c.spec === "render"), 1);
    files[k] = v;
  });
  assert.equal(r.status, 1);
  assert.match(r.out, /is missing case render/);
  r = merged((files) => {
    const [k, v] = first(files, "webkit", "render");
    v.webkit.cases.push({ ...v.webkit.cases[0] });
    files[k] = v;
  });
  assert.equal(r.status, 1);
  assert.match(r.out, /is duplicated/);
  r = merged((files) => {
    const [k, v] = first(files, "firefox", "render");
    v.firefox.cases[0].dims.sampleRate = 12345;
    files[k] = v;
  });
  assert.equal(r.status, 1);
  assert.match(r.out, /dimension mismatch/);
});

test("merge fails when producer status says the shard failed or a worker did not launch", () => {
  let r = merged((files) => {
    const k = Object.keys(files).find((x) => x.startsWith("browser-results-webkit-1/"));
    files[k].webkit.failure = "worker deadline exceeded";
  });
  assert.equal(r.status, 1);
  assert.match(r.out, /worker failed/);
  r = merged((files) => {
    const k = Object.keys(files).find((x) => x.startsWith("browser-results-firefox-1/"));
    files[k].firefox.version = null;
    files[k].firefox.launchError = "no browser";
  });
  assert.equal(r.status, 1);
  assert.match(r.out, /did not launch/);
});

test("merge rejects stale or forged run, config, artifact, and source/min provenance", () => {
  for (const mutate of [
    (v) => { v.matrixRun.testedSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; },
    (v) => { v.matrixRun.runId = "4711223345"; },
    (v) => { v.matrixRun.matrixConfigSha256 = "0".repeat(64); },
    (v) => { v.matrixRun.shard.index = 3; },
    (v) => { v.matrixRun.engine = "firefox"; },
    (v) => { v.matrixRun.buildSha256.source = "0".repeat(64); },
  ]) {
    const r = qualificationMerged((files) => {
      const k = Object.keys(files)[0];
      mutate(files[k]);
    });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /stale or forged|fingerprint|hashes differ|provenance shard|provenance engine/);
  }
});

test("merge rejects a same-version shard reporting a different Playwright browser bundle", () => {
  const r = qualificationMerged((files) => {
    const [rel, report] = first(files, "webkit", "full-mix");
    const toolchain = report.matrixRun.browserToolchain;
    toolchain.browsers.webkit = {
      revision: "2370", bundleId: "webkit-2370", browserVersion: "26.6",
      identitySha256: bundleWithRevision(testBrowserBundle("webkit"), "2370").identitySha256,
    };
    delete toolchain.identitySha256;
    toolchain.identitySha256 = stableSha256(Buffer.from(stableCanonical(toolchain)));
    report.webkit.browserBundle = bundleWithRevision(report.webkit.browserBundle, "2370");
    assert.equal(report.webkit.version, "26.6");
    files[rel] = report;
  });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /Playwright\/browser bundle identity differs from the aggregate checkout|revision bundle differs from the aggregate checkout/);
});

test("merge rejects a same-version measured reference pinned to a different browser bundle", () => {
  const reference = JSON.parse(TEST_REFERENCE_BYTES.toString("utf8"));
  const metadata = reference.engines.webkit["ws-mid-default"][44100].metadata;
  const wrong = bundleWithRevision(metadata.browserBundle, "2370");
  metadata.browserBundle = wrong;
  metadata.captureToolchain.browserBundle = wrong;
  const capturedToolchain = metadata.captureRun.browserToolchain;
  capturedToolchain.browsers.webkit = { revision: wrong.revision, bundleId: wrong.bundleId,
    browserVersion: wrong.browserVersion, identitySha256: wrong.identitySha256 };
  delete capturedToolchain.identitySha256;
  capturedToolchain.identitySha256 = stableSha256(Buffer.from(stableCanonical(capturedToolchain)));
  const r = qualificationMerged(null, Buffer.from(JSON.stringify(reference)));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /producer reference status differs from the aggregate's exact identity selection/);
  assert.match(r.out, /26\.6/);
});

test("merge rejects same-version Chromium full-browser metadata for the headless-shell launch", () => {
  const r = qualificationMerged((files) => {
    const [rel, report] = first(files, "chromium", "full-mix");
    const toolchain = report.matrixRun.browserToolchain;
    const wrong = bundleWithId(testBrowserBundle("chromium"), "chromium-" + TEST_TOOLCHAIN.browsers.chromium.revision);
    toolchain.browsers.chromium.bundleId = wrong.bundleId;
    toolchain.browsers.chromium.identitySha256 = wrong.identitySha256;
    delete toolchain.identitySha256;
    toolchain.identitySha256 = stableSha256(Buffer.from(stableCanonical(toolchain)));
    report.chromium.browserBundle = wrong;
    assert.equal(report.chromium.version, "153.0.8010.12");
    files[rel] = report;
  });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /Playwright\/browser bundle identity differs from the aggregate checkout|revision bundle differs from the aggregate checkout/);
});

test("merge rejects JSON-null metrics, missing or malformed generated-buffer digests and malformed case records", () => {
  let r = merged((files) => {
    const [k, v] = first(files, "chromium", "render");
    v.chromium.cases[0].observations.measurements[GROUPS[0]].rms[0] = NaN;
    files[k] = JSON.stringify(v); // JSON.stringify serializes NaN as null.
  });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /null or malformed gm-programs-0-31 RMS observations/);
  assert.match(r.out, /missing, null or malformed GM measurements: gm-programs-0-31 RMS/);
  r = merged((files) => {
    const [k, v] = first(files, "firefox", "render");
    delete v.firefox.cases[0].observations["generated buffer SHA-256 (first reverb-enabled attempt)"].builds.source.n1;
    files[k] = v;
  });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /source build must contain exactly convBuf, n0 and n1 descriptors/);
  r = merged((files) => {
    const [k, v] = first(files, "firefox", "render");
    v.firefox.cases[0].observations["generated buffer SHA-256 (first reverb-enabled attempt)"].builds.min.n0.sha256 = "b".repeat(16);
    files[k] = v;
  });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /min n0 SHA-256 must be 64 lowercase hexadecimal characters/);
  r = merged((files) => {
    const [k, v] = first(files, "firefox", "render");
    delete v.firefox.cases[0].observations["generated buffer SHA-256 (first reverb-enabled attempt)"].producer;
    files[k] = v;
  });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /malformed generated-buffer SHA-256 method or first-attempt metadata/);
  r = merged((files) => {
    const [k, v] = first(files, "webkit", "render");
    v.webkit.cases[0].observations["generated buffer SHA-256 (first reverb-enabled attempt)"].settings.useReverb = 0;
    files[k] = v;
  });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /missing, stale or mismatched active reverb-probe settings/);
  r = merged((files) => {
    const [k, v] = first(files, "webkit", "render");
    v.webkit.cases[0].observations.measurements["gm-programs-0-31"].peaks[0] = null;
    files[k] = v;
  });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /missing, null or malformed gm-programs-0-31 peak observations/);
  r = merged((files) => {
    const [k, v] = first(files, "webkit", "render");
    v.webkit.cases[0] = null;
    files[k] = v;
  });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /malformed case record/);
  assert.match(r.out, /FAIL: browser matrix shards/);
});

test("only strict qualification enforces the new aggregate GM peak ceiling", () => {
  const change = (files) => {
    const [k, v] = first(files, "webkit", "render");
    const c = v.webkit.cases.find((item) => item.spec === "render" && item.dims.quality === 1 && item.dims.sampleRate === 44100);
    c.observations.measurements["gm-drums"].peaks[14] = 1.259;
    files[k] = v;
  };
  const core = merged(change);
  assert.equal(core.status, 0, core.out);
  const qualification = qualificationMerged(change);
  assert.equal(qualification.status, 1, qualification.out);
  assert.match(qualification.out, /webkit render q1 44100 has over-full-scale peak for gm-drums slot 14 = 1\.259/);
  assert.match(qualification.out, /over-full-scale render peak webkit render q1 44100 gm-drums slot 14 = 1\.259/);
});

test("render producer preserves raw Float32 GM headroom across JSON and strict qualification", () => {
  const peakFromSample = (sample) => {
    const pcm = new Float32Array(8);
    pcm[0] = sample;
    const row = renderSpec.rawGmMeasurements([{ peak: testAnalysis.peak(pcm), rms: testAnalysis.rms(pcm) }]);
    return JSON.parse(JSON.stringify(row));
  };
  const setFirstPeak = (row) => (files) => {
    const [rel, report] = first(files, "webkit", "render");
    const c = report.webkit.cases.find((item) => item.spec === "render" && item.dims.quality === 1 && item.dims.sampleRate === 44100);
    const measurements = c.observations.measurements["gm-programs-0-31"];
    measurements.peaks[0] = row.peaks[0];
    files[rel] = report;
  };

  const exactlyOne = peakFromSample(1);
  assert.equal(exactlyOne.peaks[0], 1);
  const atLimit = qualificationMerged(setFirstPeak(exactlyOne));
  assert.equal(atLimit.status, 0, atLimit.out);

  const nextFloatAboveOne = Math.fround(1 + 2 ** -23);
  assert.equal(nextFloatAboveOne, 1.0000001192092896);
  for (const sample of [nextFloatAboveOne, -nextFloatAboveOne]) {
    const producerRow = peakFromSample(sample);
    assert.equal(producerRow.peaks[0], nextFloatAboveOne,
      "the actual analysis and report producer preserve the first Float32 magnitude above 1");
    const change = setFirstPeak(producerRow);
    const ordinary = merged(change);
    assert.equal(ordinary.status, 0, ordinary.out, "the ordinary browser-matrix lane remains non-enforcing");
    const qualification = qualificationMerged(change);
    assert.equal(qualification.status, 1, qualification.out);
    assert.match(qualification.out,
      /webkit render q1 44100 has over-full-scale peak for gm-programs-0-31 slot 0 = 1\.0000001192092896/);
    assert.match(qualification.out,
      /over-full-scale render peak webkit render q1 44100 gm-programs-0-31 slot 0 = 1\.0000001192092896/);
  }
});

test("merge normalizes malformed case timing and worker diagnostics instead of crashing", () => {
  let r = merged((files) => {
    const [k, v] = first(files, "chromium", "embed");
    v.chromium.cases[0].seconds = "1";
    files[k] = v;
  });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /seconds must be a finite non-negative number/);
  assert.match(r.out, /FAIL: browser matrix shards/);
  r = merged((files) => {
    const [k, v] = first(files, "firefox", "embed");
    v.firefox.version = 1;
    v.firefox.launchError = { code: "no-browser" };
    v.firefox.failure = { message: "worker-failed" };
    v.firefox.fatal = ["deadline"];
    files[k] = v;
  });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /did not launch/);
  assert.match(r.out, /worker failed/);
  assert.match(r.out, /stopped early/);
  assert.match(r.out, /FAIL: browser matrix shards/);
});

test("merge rejects a duplicate result artifact and unreadable or undeclared results", () => {
  let r = merged((files) => {
    const [k, value] = Object.entries(files).find(([rel]) => rel.startsWith("browser-results-chromium-1/"));
    files[path.join("browser-results-chromium-99", "browser-matrix", "results.json")] = value;
    delete files[k];
  });
  assert.equal(r.status, 1);
  assert.match(r.out, /unexpected result path/);
  r = merged((files) => { files[path.join("browser-results-chromium-1", "browser-matrix", "bad", "results.json")] = "{not json"; });
  assert.equal(r.status, 1);
  assert.match(r.out, /unexpected result path/);
  assert.match(r.out, /unreadable/);
  r = merged((files) => { files[path.join("browser-results-chromium-1", "browser-matrix", "results.json")] = { opera: { cases: [] } }; });
  assert.equal(r.status, 1);
  assert.match(r.out, /missing matrixRun provenance/);
});

test("the workflow shard list, MATRIX.shards and job name agree", () => {
  const yml = fs.readFileSync(path.join(H.ROOT, ".github", "workflows", "browser-matrix.yml"), "utf8");
  const list = /^\s+shard: \[([\d, ]+)\]$/m.exec(yml);
  assert.ok(list, "no shard list");
  const shards = list[1].split(",").map((x) => Number(x.trim()));
  const n = shards.length;
  assert.equal(n, MATRIX.shards);
  assert.deepEqual(shards, Array.from({ length: n }, (_, i) => i + 1));
  assert.ok(yml.includes("SHARD: ${{ matrix.shard }}/" + n), "SHARD");
  assert.ok(yml.includes("name: browser (${{ matrix.engine }}, ${{ matrix.shard }}/" + n + ")"), "job name");
  assert.ok(yml.includes("name: browser matrix"), "ordinary required check name");
  assert.ok(yml.includes("name: full-mix qualification aggregate"), "separate strict qualification check name");
  assert.ok(yml.includes("pattern: browser-results-*"), "core artifact selection");
  assert.ok(yml.includes("pattern: full-mix-qualification-*"), "qualification artifact selection");
  const browserJob = yml.split("  browser:\n")[1].split("\n  full-mix-qualification:")[0];
  assert.ok(browserJob.includes("${{ runner.temp }}/browser-matrix/${{ matrix.engine }}/first-attempt-pcm/**/*.wav"),
    "the ordinary shard artifact retains bounded first-attempt PCM evidence");
  const qualificationJob = yml.split("  full-mix-qualification:\n")[1].split("\n  demos:")[0];
  const output = /--out="\$RUNNER_TEMP\/([^"]+)"/.exec(qualificationJob);
  const upload = /\n\x20{10}path: \$\{\{ runner\.temp \}\}\/([^\n]+)\n/.exec(qualificationJob);
  assert.ok(output, "qualification producer output path");
  assert.ok(upload, "qualification artifact upload path");
  const runnerTemp = "/runner-temp";
  const stagedResults = path.posix.join(runnerTemp, output[1], "results.json");
  const uploadedRoot = path.posix.join(runnerTemp, upload[1]);
  const artifactResult = path.posix.relative(uploadedRoot, stagedResults);
  assert.equal(artifactResult, "browser-matrix/results.json",
    "the workflow's real staging/upload paths preserve the browser-matrix directory under the uploaded artifact");
  assert.ok(yml.includes('${{ runner.temp }}/full-mix-qualification/'), "qualification upload root preserves browser-matrix/ in the artifact");
  assert.ok(n <= SPECS.length);
  const corePaths = [...expectedResultPaths().keys()];
  assert.ok(corePaths.every((rel) => rel.startsWith("browser-results-") && !rel.includes("full-mix-qualification")));
  const qualificationPaths = [...expectedResultPaths("full-mix-qualification").keys()];
  assert.equal(qualificationPaths.length, MATRIX.engines.length);
  assert.ok(qualificationPaths.every((rel) => rel.startsWith("full-mix-qualification-") && rel.endsWith("/browser-matrix/results.json")));
  assert.ok(qualificationPaths.every((rel) => path.posix.basename(rel) === "results.json" && path.posix.dirname(rel).endsWith(artifactResult.slice(0, -"/results.json".length))));
});

test("merge keeps a non-finite diagnostic repeat separate from a valid first attempt", () => {
  const r = qualificationMerged((files) => {
    const [rel, report] = first(files, "chromium", "full-mix");
    const observation = report.chromium.cases.find((c) => c.spec === "full-mix").observations.fullMix;
    const row = observation.builds.source, diagnostic = row.diagnosticRepeat;
    const artifactRel = path.posix.join(path.posix.dirname(rel), "chromium", diagnostic.artifact.path);
    const wav = Buffer.from(ATTACHMENTS.get(artifactRel));
    const frames = (wav.length - 44) / 8;
    const firstWav = Buffer.from(ATTACHMENTS.get(path.posix.join(path.posix.dirname(rel), "chromium", row.artifact.path)));
    const firstChannels = [new Float32Array(frames), new Float32Array(frames)];
    const repeatChannels = [new Float32Array(frames), new Float32Array(frames)];
    for (let i = 0; i < frames; ++i) {
      firstChannels[0][i] = firstWav.readFloatLE(44 + i * 8);
      firstChannels[1][i] = firstWav.readFloatLE(48 + i * 8);
      repeatChannels[0][i] = wav.readFloatLE(44 + i * 8);
      repeatChannels[1][i] = wav.readFloatLE(48 + i * 8);
    }
    repeatChannels[0][100] = NaN;
    wav.writeFloatLE(NaN, 44 + 100 * 8);
    const pcm = Buffer.concat(repeatChannels.map((x) => Buffer.from(x.buffer)));
    diagnostic.artifact.sha256 = stableSha256(wav);
    diagnostic.artifact.pcmSha256 = stableSha256(pcm);
    diagnostic.metrics = FULL_MIX.analyzeChannels(repeatChannels, diagnostic.artifact.sampleRate,
      FULL_MIX.FIXTURE_BY_ID[observation.fixtureId]);
    diagnostic.sameEnginePcm = FULL_MIX.sameEnginePcm(firstChannels, repeatChannels, "chromium");
    ATTACHMENTS.set(artifactRel, wav);
    files[rel] = report;
  });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /PASS: browser matrix shards/);
});

test("raw WAV parser requires exact frames and validates RIFF, byte-rate and data headers", () => {
  const sr = 44100, frames = 256;
  const original = testAnalysis.wav([new Float32Array(frames).fill(0.25), new Float32Array(frames).fill(-0.25)], sr);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-wav-header-"));
  const file = path.join(dir, "capture.wav");
  const parse = (bytes, expected = frames) => { fs.writeFileSync(file, bytes); return readFloatStereoWav(file, sr, expected); };
  try {
    assert.equal(parse(original).channels[0].length, frames);
    assert.throws(() => parse(original.subarray(0, original.length - 8)), /exact expected frame count/);
    const extra = Buffer.concat([original, Buffer.alloc(8)]);
    extra.writeUInt32LE(extra.length - 8, 4);
    extra.writeUInt32LE(extra.length - 44, 40);
    assert.throws(() => parse(extra), /exact expected frame count/);
    for (const [offset, value] of [[4, original.length - 9], [28, sr * 2 * 4 + 4], [40, original.length - 52]]) {
      const corrupt = Buffer.from(original);
      corrupt.writeUInt32LE(value, offset);
      assert.throws(() => parse(corrupt), /complete IEEE-float stereo WAV/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("merge fails closed on missing full-mix WAVs, JSON-null metrics and raw nonfinite/over-full-scale PCM", () => {
  const r = qualificationMerged((files) => {
    const [chromiumPath, chromiumReport] = first(files, "chromium", "full-mix");
    const chromiumCase = chromiumReport.chromium.cases.find((c) => c.spec === "full-mix");
    const source = chromiumCase.observations.fullMix.builds.source;
    source.metrics.overall.rawRenderRms = null;
    const sourceRel = path.posix.join(path.posix.dirname(chromiumPath), "chromium", source.artifact.path);
    const wav = Buffer.from(ATTACHMENTS.get(sourceRel));
    const frames = (wav.length - 44) / 8;
    const channels = [new Float32Array(frames), new Float32Array(frames)];
    for (let i = 0; i < frames; ++i) {
      channels[0][i] = wav.readFloatLE(44 + i * 8);
      channels[1][i] = wav.readFloatLE(48 + i * 8);
    }
    wav.writeFloatLE(NaN, 44 + 100 * 8);
    wav.writeFloatLE(1.5, 48 + 101 * 8);
    channels[0][100] = NaN;
    channels[1][101] = 1.5;
    source.artifact.sha256 = stableSha256(wav);
    source.artifact.pcmSha256 = stableSha256(Buffer.concat(channels.map((x) => Buffer.from(x.buffer))));
    source.pcmSha256 = channels.map((x) => testAnalysis.sha256(x));
    ATTACHMENTS.set(sourceRel, wav);
    files[chromiumPath] = chromiumReport;

    const [firefoxPath, firefoxReport] = first(files, "firefox", "full-mix");
    const firefoxSource = firefoxReport.firefox.cases.find((c) => c.spec === "full-mix").observations.fullMix.builds.source;
    const missingRel = path.posix.join(path.posix.dirname(firefoxPath), "firefox", firefoxSource.artifact.path);
    ATTACHMENTS.delete(missingRel);
    files[firefoxPath] = firefoxReport;
  });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /report measurements differ from analysis recomputed from the raw artifact/);
  assert.match(r.out, /raw Float32 PCM contains a non-finite sample/);
  assert.match(r.out, /raw Float32 PCM contains an over-full-scale sample/);
  assert.match(r.out, /raw audio artifact is missing or invalid/);
});
