"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fullMix = require("../browser/specs/full-mix");
const analysis = require("../browser/lib/analysis");
const H = require("../harness");
const browserToolchain = require("../../scripts/browser-toolchain");

function fixtureAndPcm(sampleRate = 8000) {
  const fixture = {
    id: "pitch-fault-fixture", songEndSec: 1.3, liveVoices: 8, offlineVoices: 4,
    notes: [{ id: "downbeat", channel: 0, pitch: 60, velocity: 100, program: 0, onsetSec: 0.1,
      durationSec: 0.8, offSec: 0.9, termination: "matched-note-off", unpitched: false, pairingAmbiguous: false }],
    downbeat: { noteId: "downbeat", expectedPitch: 60, startOffsetSec: 0.02, durationSec: 0.22 },
    probes: [
      { id: "probe-a", channel: 14, program: 0, pitch: 69, expectedPitch: 69, velocity: 100, startSec: 1.7 },
      { id: "probe-b", channel: 15, program: 20, pitch: 69, expectedPitch: 57, velocity: 100, startSec: 2.9 },
    ],
    maxKnownSimultaneous: 1, unmatchedNoteOffs: 0, timingComplete: true, unpitchedOneShotCount: 0,
  };
  const samples = Math.ceil(4 * sampleRate), left = new Float32Array(samples), right = new Float32Array(samples);
  function addTone(start, duration, midi, amp) {
    const from = Math.round(start * sampleRate), to = Math.min(samples, from + Math.round(duration * sampleRate));
    const hz = analysis.midiHz(midi);
    for (let i = from; i < to; ++i) {
      const value = amp * Math.sin(2 * Math.PI * hz * (i - from) / sampleRate);
      left[i] += value;
      right[i] += value;
    }
  }
  addTone(0.1, 0.8, 60, 0.5);
  // Keep the probe contribution local so its 20 dB relative loss is detectable
  // while total-render RMS and stereo balance remain inside the 0.001 dB policy.
  addTone(1.7, 0.45, 69, 0.02);
  addTone(2.9, 0.45, 57, 0.016);
  return { fixture, sampleRate, channels: [left, right] };
}

function probeSignal(freq, { noise = false, duration = 1, sampleRate = 48000 } = {}) {
  const probe = { id: "probe", channel: 14, program: 0, pitch: 69, expectedPitch: 69, velocity: 100, startSec: 0.05 };
  const channels = [new Float32Array(Math.round(duration * sampleRate)), new Float32Array(Math.round(duration * sampleRate))];
  let seed = 7;
  for (let i = 0; i < channels[0].length; ++i) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const value = i / sampleRate < probe.startSec ? 0 : noise
      ? ((seed / 4294967296) - 0.5) * 0.2
      : 0.2 * Math.sin(2 * Math.PI * freq * i / sampleRate);
    channels[0][i] = value;
    channels[1][i] = value;
  }
  return { channels, probe, sampleRate };
}

function resolveBrowserToolchainFixture(webkitPath, revisionOverrides = { mac14: "2251", "mac14-arm64": "2251" }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tinysynth-browser-toolchain-"));
  const packageDir = path.join(root, "node_modules", "playwright-core");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "playwright-core", version: "1.63.0" }));
  fs.writeFileSync(path.join(packageDir, "browsers.json"), JSON.stringify({ browsers: [
    { name: "chromium-headless-shell", revision: "1243", browserVersion: "153.0.8010.12" },
    { name: "firefox", revision: "1543", browserVersion: "155.0" },
    { name: "webkit", revision: "2359", revisionOverrides, browserVersion: "26.6" },
  ] }));
  fs.writeFileSync(path.join(packageDir, "paths.json"), JSON.stringify({
    chromium: "/cache/chromium-1243/chrome-linux64/chrome",
    firefox: "/cache/firefox-1543/firefox/firefox",
    webkit: webkitPath,
  }));
  fs.writeFileSync(path.join(packageDir, "index.js"), [
    '"use strict";',
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'function executablePath(engine) { return JSON.parse(fs.readFileSync(path.join(__dirname, "paths.json"), "utf8"))[engine]; }',
    'module.exports = Object.fromEntries(["chromium", "firefox", "webkit"].map((engine) => [engine, { executablePath: () => executablePath(engine) }]));',
  ].join("\n"));
  try {
    return browserToolchain.resolveBrowserToolchain({ PLAYWRIGHT_CORE: path.join(packageDir, "index.js") }, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

test("browser toolchain follows pinned macOS WebKit override bundles and retains exact bundle identities", () => {
  const linux = resolveBrowserToolchainFixture("/cache/webkit-2359/pw_run.sh");
  const mac14 = resolveBrowserToolchainFixture("/cache/webkit_mac14_special-2251/pw_run.sh");
  const mac14Arm64 = resolveBrowserToolchainFixture("/cache/webkit_mac14_arm64_special-2251/pw_run.sh");
  for (const [toolchain, revision, bundleId] of [
    [linux, "2359", "webkit-2359"],
    [mac14, "2251", "webkit_mac14_special-2251"],
    [mac14Arm64, "2251", "webkit_mac14_arm64_special-2251"],
  ]) {
    const webkit = browserToolchain.engineBundle(toolchain, "webkit");
    assert.equal(webkit.revision, revision);
    assert.equal(webkit.bundleId, bundleId);
    assert.equal(webkit.browserVersion, "26.6");
    const expectedIdentity = { ...webkit };
    delete expectedIdentity.identitySha256;
    assert.equal(webkit.identitySha256, sha256(Buffer.from(browserToolchain.canonical(expectedIdentity))));
    assert.equal(toolchain.browsers.chromium.revision, "1243");
    assert.equal(toolchain.browsers.chromium.bundleId, "chromium_headless_shell-1243");
    assert.equal(toolchain.browsers.chromium.browserVersion, "153.0.8010.12");
  }
  for (const toolchain of [linux, mac14, mac14Arm64]) {
    const expectedIdentity = { ...toolchain };
    delete expectedIdentity.identitySha256;
    assert.equal(toolchain.identitySha256, sha256(Buffer.from(browserToolchain.canonical(expectedIdentity))));
  }
  assert.notEqual(linux.browsers.webkit.identitySha256, mac14.browsers.webkit.identitySha256);
  assert.notEqual(mac14.browsers.webkit.identitySha256, mac14Arm64.browsers.webkit.identitySha256);
});

test("browser toolchain rejects WebKit executable paths that do not match a manifest bundle", () => {
  for (const executable of [
    "/cache/webkit-2251/pw_run.sh",
    "/cache/webkit_mac15_arm64_special-2251/pw_run.sh",
    "/cache/webkit_mac14_arm64_special-2359/pw_run.sh",
    "/cache/webkit-2359/webkit_mac14_arm64_special-2251/pw_run.sh",
  ]) {
    assert.throws(() => resolveBrowserToolchainFixture(executable), /does not identify exactly one manifest bundle/);
  }
  assert.throws(() => resolveBrowserToolchainFixture("/cache/webkit-2359/pw_run.sh", { mac14: "invalid" }),
    /invalid webkit revision override for mac14/);
  assert.throws(() => resolveBrowserToolchainFixture("/cache/webkit-2359/pw_run.sh", { mac14: 0 }),
    /invalid webkit revision override for mac14/);
});

test("isolated pitch probe accepts the expected pitch and rejects semitone/octave faults", () => {
  const sr = 48000, expected = analysis.midiHz(69);
  const correct = probeSignal(expected);
  const measured = fullMix.analyzeProbe(correct.channels, sr, correct.probe);
  assert.equal(measured.status, "measured");
  assert.ok(Math.abs(measured.pitchCents) < fullMix.PROBE_PITCH_LIMIT_CENTS);
  assert.ok(measured.toneFractionDb >= -12);
  assert.equal(measured.pitchSearchCents, 660);

  const semitone = probeSignal(analysis.midiHz(70));
  const semitoneResult = fullMix.analyzeProbe(semitone.channels, sr, semitone.probe);
  assert.equal(semitoneResult.status, "incomplete");
  assert.ok(Math.abs(semitoneResult.pitchCents) > 90);

  const octave = probeSignal(expected * 2);
  const octaveResult = fullMix.analyzeProbe(octave.channels, sr, octave.probe);
  assert.equal(octaveResult.status, "incomplete");
  assert.ok(Math.abs(octaveResult.pitchCents) > fullMix.PROBE_PITCH_LIMIT_CENTS);
});

test("isolated pitch probe leaves silence, broadband noise and short captures incomplete", () => {
  const silent = probeSignal(analysis.midiHz(69));
  silent.channels.forEach((x) => x.fill(0));
  assert.equal(fullMix.analyzeProbe(silent.channels, silent.sampleRate, silent.probe).status, "incomplete");

  const noise = probeSignal(0, { noise: true });
  const noisy = fullMix.analyzeProbe(noise.channels, noise.sampleRate, noise.probe);
  assert.equal(noisy.status, "incomplete");
  assert.ok(noisy.toneFractionDb < -12);

  const short = probeSignal(analysis.midiHz(69), { duration: 0.25 });
  assert.doesNotThrow(() => fullMix.analyzeProbe(short.channels, short.sampleRate, short.probe));
  assert.equal(fullMix.analyzeProbe(short.channels, short.sampleRate, short.probe).status, "incomplete");
});

test("each fixture reserves two distinct post-song probe channels unused by any MIDI channel event", () => {
  for (const fixture of fullMix.FIXTURES) {
    const channelsInMidi = new Set(fixture.file.tracks.flatMap((track) => track.events)
      .filter((event) => event.status < 0xf0).map((event) => event.status & 15));
    const probeChannels = fixture.probes.map((probe) => probe.channel);
    assert.deepEqual(probeChannels, fullMix.PROBE_CHANNELS, fixture.id);
    assert.equal(new Set(probeChannels).size, probeChannels.length, fixture.id);
    assert.ok(probeChannels.every((channel) => !channelsInMidi.has(channel)), fixture.id + " channel message collision");
    const observations = fixture.probes.map((probe) => ({ channel: probe.channel, pitch: probe.pitch,
      velocity: probe.velocity, program: probe.program, timeSec: probe.startSec, created: true, sourceCount: 1 }));
    assert.equal(fullMix.matchProbeCreations(fixture, observations, [], 48000).complete, true, fixture.id);
  }
});

test("native event mapping rejects an omitted, program-mismatched or pruned fixture/probe source", () => {
  const fixture = {
    songEndSec: 3, probes: [{ id: "p", channel: 14, program: 8, pitch: 69, velocity: 100, startSec: 1 }],
    notes: [{ id: "n", channel: 0, pitch: 60, velocity: 90, program: 4, onsetSec: 0.1 }],
  };
  const song = [{ channel: 0, pitch: 60, velocity: 90, program: 4, timeSec: 0.1, created: true, sourceCount: 2 }];
  const probe = [{ channel: 14, pitch: 69, velocity: 100, program: 8, timeSec: 1, created: true, sourceCount: 2 }];
  assert.equal(fullMix.matchVoiceCreations(fixture, song, [], 48000).complete, true);
  assert.equal(fullMix.matchProbeCreations(fixture, probe, [], 48000).complete, true);
  assert.equal(fullMix.matchVoiceCreations(fixture, [], [], 48000).complete, false);
  assert.equal(fullMix.matchProbeCreations(fixture, [], [], 48000).complete, false);
  assert.equal(fullMix.matchProbeCreations(fixture, [{ ...probe[0], program: 7 }], [], 48000).complete, false);
  assert.equal(fullMix.matchProbeCreations(fixture, probe, [{ channel: 14, pitch: 69, timeSec: 1 }], 48000).complete, false);
});

test("full-mix local fault sensitivity catches a missing downbeat and relative probe loss", () => {
  const { fixture, sampleRate, channels } = fixtureAndPcm();
  const metrics = fullMix.analyzeChannels(channels, sampleRate, fixture);
  const voices = { rows: [{ id: "downbeat", status: "created", sourceCount: 1 }] };
  const result = fullMix.faultSensitivity(channels, sampleRate, fixture, metrics, voices);
  assert.equal(result.checksPass, true, JSON.stringify(result));
  assert.equal(result.missingDownbeat.voiceCreationOmissionRejected, true);
  assert.ok(result.missingDownbeat.mutedMixedBusBandDropDb > 10);
  assert.equal(result.relativeProbe.factor, 0.99);
  assert.ok(result.relativeProbe.relativeDeltaDb > fullMix.REFERENCE.tolerances.relativeProbeDb);
  assert.equal(result.relativeProbe.wholeRenderRmsStillWithinPolicy, true);
  assert.equal(result.relativeProbe.wholeRenderBalanceStillWithinPolicy, true);
});

test("renderOne compares measured reference metrics, and rejects missing reference metrics", async () => {
  const fixture = fullMix.FIXTURE_BY_ID["tinychip-ws-mid"];
  const sampleRate = 44100;
  const frames = Math.ceil(fixture.renderDurationSec * sampleRate);
  const channels = [new Float32Array(frames), new Float32Array(frames)];
  for (let i = 0; i < frames; ++i) {
    const time = i / sampleRate;
    const value = 0.1 * Math.sin(2 * Math.PI * 55 * time) +
      0.2 * Math.sin(2 * Math.PI * 220 * time) + 0.2 * Math.sin(2 * Math.PI * 440 * time);
    channels[0][i] = channels[1][i] = value;
  }
  const metrics = fullMix.analyzeChannels(channels, sampleRate, fixture);
  const row = fullMix.REFERENCE.engines.chromium[fixture.id][sampleRate];
  const originalMetrics = row.source.metrics;
  const originalCapture = structuredClone(row.source.capture);
  const originalMetadata = structuredClone(row.metadata);
  const originalReferencePins = {
    methodSha256: fullMix.REFERENCE.methodSha256,
    toleranceSha256: fullMix.REFERENCE.toleranceSha256,
  };
  const toolchain = browserToolchain.resolveBrowserToolchain(process.env, H.ROOT);
  const bundle = browserToolchain.engineBundle(toolchain, "chromium");
  const platform = process.platform + "-" + process.arch;
  Object.assign(row.metadata, {
    scope: "fixture", fixtureId: fixture.id, profileKind: fixture.profileKind, quality: 1,
    engine: "chromium", browserVersion: "153.0.8010.12", platform, sampleRate, browserBundle: bundle,
    midiSha256: fixture.midiSha256, setupSha256: fixture.setupSha256,
    settingsSha256: fixture.settingsSha256, probePlanSha256: fixture.probePlanSha256,
    methodSha256: fixture.methodSha256, toleranceSha256: fixture.toleranceSha256,
    playbackOriginSec: fullMix.ORIGIN,
  });
  fullMix.REFERENCE.methodSha256 = fixture.methodSha256;
  fullMix.REFERENCE.toleranceSha256 = fixture.toleranceSha256;
  const pcm = channels.map((channel) => Buffer.from(channel.buffer, channel.byteOffset, channel.byteLength).toString("base64"));
  const t = {
    engine: "chromium", version: "153.0.8010.12", shared: { platform, browserBundle: bundle },
    async newPage() {
      return { page: {
        async setContent() {},
        async evaluate() { return { pcm, noteCreations: [], prunedInstances: [] }; },
      } };
    },
  };
  try {
    row.source.metrics = metrics;
    const positive = await fullMix.renderOne(t, "source", { seed: 1592590337, overrides: {} }, fixture, sampleRate, {});
    assert.deepEqual(positive.comparisonProblems, []);
    assert.equal(positive.referenceStatus, "measured");

    const wrongPlatform = platform === "linux-arm64" ? "linux-x64" : "linux-arm64";
    for (const [key, value] of [["platform", wrongPlatform], ["methodSha256", "f".repeat(64)], ["settingsSha256", "e".repeat(64)]]) {
      const expected = row.metadata[key];
      row.metadata[key] = value;
      const rejected = await fullMix.renderOne(t, "source", { seed: 1592590337, overrides: {} }, fixture, sampleRate, {});
      assert.equal(rejected.referenceStatus, "incomplete", key);
      assert.equal(rejected.reference, null, key);
      assert.match(rejected.comparisonProblems.join(" "), new RegExp(key));
      row.metadata[key] = expected;
    }

    row.source.capture.eligible = false;
    const ineligibleReference = await fullMix.renderOne(t, "source", { seed: 1592590337, overrides: {} }, fixture, sampleRate, {});
    assert.equal(ineligibleReference.referenceStatus, "incomplete");
    assert.equal(ineligibleReference.reference, null);
    assert.match(ineligibleReference.comparisonProblems.join(" "), /first-attempt capture eligibility/);
    row.source.capture = originalCapture;

    row.source.metrics = null;
    const missing = await fullMix.renderOne(t, "source", { seed: 1592590337, overrides: {} }, fixture, sampleRate, {});
    assert.equal(missing.referenceStatus, "incomplete");
    assert.match(missing.comparisonProblems.join(" "), /source metrics/);
  } finally {
    row.source.metrics = originalMetrics;
    row.source.capture = originalCapture;
    row.metadata = originalMetadata;
    fullMix.REFERENCE.methodSha256 = originalReferencePins.methodSha256;
    fullMix.REFERENCE.toleranceSha256 = originalReferencePins.toleranceSha256;
  }
});

test("aggregate full-mix status is order-independent for partially missing source/min references", () => {
  const sourceIncomplete = {
    source: { preBaselineEligible: true, result: "incomplete" },
    min: { preBaselineEligible: true, result: "pass" },
  };
  const minIncomplete = {
    source: { preBaselineEligible: true, result: "pass" },
    min: { preBaselineEligible: true, result: "incomplete" },
  };
  assert.deepEqual(fullMix.deriveFullMixStatus(sourceIncomplete, true),
    { captureEligiblePreBaseline: true, status: "incomplete" });
  assert.deepEqual(fullMix.deriveFullMixStatus(minIncomplete, true),
    { captureEligiblePreBaseline: true, status: "incomplete" });
  assert.equal(fullMix.deriveFullMixStatus(minIncomplete, false).status, "fail");
  assert.equal(fullMix.deriveFullMixStatus({ source: { preBaselineEligible: true, result: "fail" }, min: minIncomplete.min }, true).status, "fail");
});

test("mixed-bus downbeat is a fixed independently targeted band feature, not an estimated pitch", () => {
  const { fixture, sampleRate, channels } = fixtureAndPcm();
  const expected = fullMix.analyzeChannels(channels, sampleRate, fixture).downbeat;
  assert.equal(expected.status, "measured");
  assert.equal(expected.targetHz, analysis.midiHz(fixture.downbeat.expectedPitch));
  assert.equal(expected.channel, "stereo");
  assert.equal(Object.hasOwn(expected, "pitchCents"), false);

  const shifted = channels.map((ch) => new Float32Array(ch.length));
  const from = Math.round(fixture.notes[0].onsetSec * sampleRate);
  const to = from + Math.round(0.8 * sampleRate);
  for (let i = from; i < to; ++i) {
    const value = 0.5 * Math.sin(2 * Math.PI * analysis.midiHz(62) * (i - from) / sampleRate);
    shifted[0][i] = shifted[1][i] = value;
  }
  const wrong = fullMix.analyzeChannels(shifted, sampleRate, fixture).downbeat;
  assert.ok(20 * Math.log10(expected.bandRms / Math.max(wrong.bandRms, 1e-12)) > 10,
    JSON.stringify({ expected: expected.bandRms, wrong: wrong.bandRms }));
});

test("reference comparison refuses absent, null or non-finite tolerance/observation data", () => {
  const { fixture, sampleRate, channels } = fixtureAndPcm();
  const metrics = fullMix.analyzeChannels(channels, sampleRate, fixture);
  const tolerances = {
    overallDb: 1, peakAbs: 1, windowFloor: 1e-8, windowDb: 2, noteWindowDb: 2,
    independentProbePitchCents: 35, downbeatBandDb: 2, probePitchCents: 2, transientEnvelopeDb: 2,
    balanceDb: 1, probeOnsetMs: 1, probeLevelDb: 2, probeEnvelopeDb: 2, relativeProbeDb: 2,
  };
  assert.deepEqual(fullMix.compareBuildToReference(metrics, metrics, tolerances), []);
  assert.match(fullMix.compareBuildToReference(metrics, metrics, { ...tolerances, overallDb: null }).join(" "), /finite non-negative/);
  const invalid = JSON.parse(JSON.stringify(metrics));
  invalid.channels.left.windowLevels[0].rms = null;
  assert.match(fullMix.compareBuildToReference(metrics, invalid, tolerances).join(" "), /window 0 is malformed/);
  assert.match(fullMix.compareBuildToReference(metrics, null, tolerances).join(" "), /reference metrics are missing/);
});
