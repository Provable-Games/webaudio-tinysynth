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
const matrix = require("../../scripts/browser-matrix");
const reanalyzer = require("../../scripts/reanalyze-fullmix-v6");

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

function createBrowserToolchainFixture(webkitPath, revisionOverrides = { mac14: "2251", "mac14-arm64": "2251" }) {
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
  const env = { PLAYWRIGHT_CORE: path.join(packageDir, "index.js") };
  return {
    root,
    packageDir,
    env,
    resolve: () => browserToolchain.resolveBrowserToolchain(env, root),
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function resolveBrowserToolchainFixture(webkitPath, revisionOverrides) {
  const fixture = createBrowserToolchainFixture(webkitPath, revisionOverrides);
  try {
    return fixture.resolve();
  } finally {
    fixture.close();
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function makeReanalysisPcm() {
  const fixture = fullMix.FIXTURE_BY_ID["tinychip-ws-mid"], sampleRate = 44100;
  const frames = Math.ceil(fixture.renderDurationSec * sampleRate);
  const channels = [new Float32Array(frames), new Float32Array(frames)];
  function tone(startSec, durationSec, pitch, amplitude) {
    const from = Math.max(0, Math.round(startSec * sampleRate));
    const to = Math.min(frames, Math.round((startSec + durationSec) * sampleRate));
    const hz = analysis.midiHz(pitch);
    for (let i = from; i < to; ++i) {
      const value = amplitude * Math.sin(2 * Math.PI * hz * (i - from) / sampleRate);
      channels[0][i] += value;
      channels[1][i] += value;
    }
  }
  for (const note of fixture.notes) {
    const duration = note.durationSec === null ? 0.1 : Math.max(0.02, note.durationSec);
    const pitch = note.id === fixture.downbeat.noteId ? fixture.downbeat.expectedPitch : note.pitch;
    const amplitude = note.id === fixture.downbeat.noteId ? 0.15
      : note.id === fixture.notes[0].id ? 0.08 : note.unpitched ? 0.0005 : 0.002;
    tone(note.onsetSec, duration, pitch, amplitude);
  }
  fixture.probes.forEach((probe, i) => tone(probe.startSec, 0.5, probe.expectedPitch, i === 0 ? 0.02 : 0.016));
  return { fixture, sampleRate, channels };
}

function stereoFloatWav(channels, sampleRate) {
  const frames = channels[0].length, dataLength = frames * 8;
  const bytes = Buffer.alloc(44 + dataLength);
  bytes.write("RIFF", 0, "ascii"); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8, "ascii"); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(3, 20); bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 8, 28);
  bytes.writeUInt16LE(8, 32); bytes.writeUInt16LE(32, 34);
  bytes.write("data", 36, "ascii"); bytes.writeUInt32LE(dataLength, 40);
  for (let i = 0; i < frames; ++i) {
    bytes.writeFloatLE(channels[0][i], 44 + i * 8);
    bytes.writeFloatLE(channels[1][i], 48 + i * 8);
  }
  return bytes;
}

function makeReanalysisReport(root, toolchain, engine = "chromium", runtimeVersion) {
  const { fixture, sampleRate, channels } = makeReanalysisPcm();
  const wav = stereoFloatWav(channels, sampleRate);
  const planar = Buffer.concat(channels.map((channel) => {
    const bytes = Buffer.alloc(channel.length * 4);
    for (let i = 0; i < channel.length; ++i) bytes.writeFloatLE(channel[i], i * 4);
    return bytes;
  }));
  const artifactSha = sha256(wav), pcmSha = sha256(planar);
  const metrics = fullMix.analyzeChannels(channels, sampleRate, fixture);
  const noteInstances = {
    complete: true, expectedCount: fixture.notes.length, createdCount: fixture.notes.length, extras: [],
    prunedInstances: [], rows: fixture.notes.map((note) => ({
      id: note.id, status: "created", channel: note.channel, pitch: note.pitch, velocity: note.velocity,
      program: note.program, actualProgram: note.program, onsetSec: note.onsetSec, sourceCount: 1,
      percussion: note.channel === 9, pruned: false,
    })),
  };
  const probeInstances = {
    complete: true, expectedCount: fixture.probes.length, createdCount: fixture.probes.length,
    prunedInstances: [], rows: fixture.probes.map((probe) => ({
      id: probe.id, status: "created", channel: probe.channel, pitch: probe.pitch, velocity: probe.velocity,
      program: probe.program, actualProgram: probe.program, onsetSec: probe.startSec, sourceCount: 1, pruned: false,
    })),
  };
  const sourceMinPcmComparison = fullMix.sameEnginePcm(channels, channels, engine);
  const checks = [];
  const builds = {};
  for (const build of ["source", "min"]) {
    const dir = path.join(root, engine, "full-mix");
    fs.mkdirSync(dir, { recursive: true });
    const base = "tinychip-ws-mid-q1-44100-" + build;
    const firstPath = "full-mix/" + base + "-first.wav";
    const repeatPath = "full-mix/" + base + "-diagnostic-repeat.wav";
    fs.writeFileSync(path.join(root, engine, firstPath), wav);
    fs.writeFileSync(path.join(root, engine, repeatPath), wav);
    const artifact = (relative) => ({ path: relative, saved: true, sha256: artifactSha,
      pcmSha256: pcmSha, bytes: wav.length, sampleRate, channels: 2, encoding: "WAVE_FORMAT_IEEE_FLOAT" });
    const faultSensitivity = fullMix.faultSensitivity(channels, sampleRate, fixture, metrics, noteInstances);
    builds[build] = {
      attempt: 1, firstAttempt: true, result: "incomplete", preBaselineEligible: true,
      artifact: artifact(firstPath), noteInstances: structuredClone(noteInstances),
      probeInstances: structuredClone(probeInstances), metrics: structuredClone(metrics),
      pageErrors: [], aborted: [], intervalCount: 1, rejections: [], faultSensitivity,
      referenceStatus: "incomplete", comparisonProblems: [],
      diagnosticRepeat: { attempt: 2, neverPromotesFirstAttempt: true, artifact: artifact(repeatPath) },
    };
    builds[build].sourceMinPcmComparison = sourceMinPcmComparison;
    checks.push({ name: build + " first attempt completed without scheduler, rejection, page error or network request", ok: true });
    checks.push({ name: build + " first attempt is eligible for native reference capture before comparison", ok: true });
  }
  checks.push({ name: "source and fresh-min first-attempt raw PCM match without alignment", ok: true });
  const toolchainBundle = matrix.browserBundle(toolchain, engine);
  const obs = {
    schemaVersion: 2, scope: "fixture", qualification: "fixture-only-no-production-approval",
    fixtureId: fixture.id, profileKind: fixture.profileKind, quality: 1,
    sampleRate, engine, browserVersion: runtimeVersion || toolchainBundle.browserVersion,
    platform: process.platform + "-" + process.arch, browserBundle: toolchainBundle,
    midiSha256: fixture.midiSha256, setupSha256: fixture.setupSha256,
    settingsSha256: fixture.settingsSha256, probePlanSha256: fixture.probePlanSha256,
    methodSha256: fixture.methodSha256, toleranceSha256: fixture.toleranceSha256,
    referenceProvenance: fullMix.referenceProvenance(),
    referenceToleranceSha256: fullMix.referenceProvenance().referenceToleranceSha256,
    masterVol: fixture.settings.masterVol, reverbLev: fixture.settings.reverbLev,
    playbackOriginSec: fullMix.ORIGIN, songEndSec: fixture.songEndSec, durationSec: fixture.renderDurationSec,
    input: { midiPath: "tests/fixtures/consumer/waves-song.mid", setupProvenance: fixture.setupProvenance,
      noteCount: fixture.notes.length }, setupProvenance: structuredClone(fixture.setupProvenance),
    noteTiming: { complete: fixture.timingComplete, unmatchedNoteOffs: fixture.unmatchedNoteOffs,
      unpitchedOneShotCount: fixture.unpitchedOneShotCount,
      ambiguousPairings: fixture.notes.filter((n) => n.pairingAmbiguous).length,
      durationUnknown: fixture.notes.filter((n) => n.durationSec === null).length },
    firstAttempt: true, captureEligiblePreBaseline: true, status: "incomplete",
    builds, sourceMinPcmComparison,
  };
  const matrixRun = { selection: { specs: ["full-mix"] }, browserToolchain: toolchain };
  const engineReports = Object.fromEntries(["chromium", "firefox", "webkit"].map((name) => [name, {
    version: name === engine ? (runtimeVersion || toolchain.browsers[name].browserVersion) : toolchain.browsers[name].browserVersion,
    platform: obs.platform, cases: [],
  }]));
  engineReports[engine].cases.push({ id: "full-mix tinychip-ws-mid q1 44100", status: "pass", checks,
    observations: { fullMix: obs } });
  const report = { matrixRun, ...engineReports };
  return { fixture, sampleRate, channels, report: JSON.parse(JSON.stringify(report)), matrixRun };
}

test("browser toolchain follows pinned macOS WebKit override bundles and retains exact bundle identities", () => {
  const linux = resolveBrowserToolchainFixture("/cache/webkit-2359/pw_run.sh");
  const mac14 = resolveBrowserToolchainFixture("/cache/webkit_mac14_special-2251/pw_run.sh");
  const mac14Arm64 = resolveBrowserToolchainFixture("/cache/webkit_mac14_arm64_special-2251/pw_run.sh");
  for (const [toolchain, revision, bundleId, browserVersion] of [
    [linux, "2359", "webkit-2359", "26.6"],
    [mac14, "2251", "webkit_mac14_special-2251", null],
    [mac14Arm64, "2251", "webkit_mac14_arm64_special-2251", null],
  ]) {
    const webkit = browserToolchain.engineBundle(toolchain, "webkit");
    assert.equal(webkit.revision, revision);
    assert.equal(webkit.bundleId, bundleId);
    assert.equal(webkit.browserVersion, browserVersion);
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

test("browser version matching stays strict for pinned defaults and requires observed override versions", () => {
  const linux = browserToolchain.engineBundle(resolveBrowserToolchainFixture("/cache/webkit-2359/pw_run.sh"), "webkit");
  const mac14 = browserToolchain.engineBundle(resolveBrowserToolchainFixture("/cache/webkit_mac14_special-2251/pw_run.sh"), "webkit");
  assert.equal(browserToolchain.matchesBrowserVersion(linux, "26.6"), true);
  assert.equal(browserToolchain.matchesBrowserVersion(linux, "26.5"), false);
  assert.equal(browserToolchain.matchesBrowserVersion(linux, ""), false);
  assert.equal(browserToolchain.matchesBrowserVersion(linux, null), false);
  assert.equal(browserToolchain.matchesBrowserVersion(mac14, "reported-platform-version"), true);
  assert.equal(browserToolchain.matchesBrowserVersion(mac14, ""), false);
  assert.equal(browserToolchain.matchesBrowserVersion(mac14, "   "), false);
  assert.equal(browserToolchain.matchesBrowserVersion(mac14, null), false);
  assert.equal(browserToolchain.matchesBrowserVersion({ ...mac14, browserVersion: undefined }, "26.6"), false);
});

test("pinned bundle validation accepts only exact default and declared override identities", () => {
  const linuxFixture = createBrowserToolchainFixture("/cache/webkit-2359/pw_run.sh");
  const macFixture = createBrowserToolchainFixture("/cache/webkit_mac14_special-2251/pw_run.sh");
  try {
    const linux = browserToolchain.engineBundle(linuxFixture.resolve(), "webkit");
    const mac14 = browserToolchain.engineBundle(macFixture.resolve(), "webkit");
    const pinned = (bundle, fixture = macFixture) =>
      browserToolchain.isPinnedBrowserBundle(bundle, fixture.env, fixture.root);
    assert.equal(pinned(linux, linuxFixture), true);
    assert.equal(pinned(mac14), true);
    assert.equal(pinned(mac14) && browserToolchain.matchesBrowserVersion(mac14, "observed-platform-version"), true);

    function altered(bundle, changes) {
      const claim = { ...bundle, ...changes };
      delete claim.identitySha256;
      claim.identitySha256 = sha256(Buffer.from(browserToolchain.canonical(claim)));
      return claim;
    }
    const fabricatedMac = altered(mac14, { bundleId: "webkit_mac15_special-2251" });
    for (const claim of [
      fabricatedMac,
      altered(mac14, { revision: "9999", bundleId: "webkit_mac14_special-9999" }),
      altered(mac14, { browsersManifestSha256: "f".repeat(64) }),
      altered(mac14, { playwrightCoreVersion: "1.62.0" }),
      altered(linux, { browserVersion: null }),
      altered(mac14, { revision: "2252", bundleId: "webkit_mac14_special-2252" }),
      altered(mac14, { browserVersion: "26.6" }),
    ]) assert.equal(pinned(claim), false, JSON.stringify(claim));
    assert.equal(pinned(fabricatedMac) && browserToolchain.matchesBrowserVersion(fabricatedMac, "observed-platform-version"), false);

    const missingVersion = { ...mac14 };
    delete missingVersion.browserVersion;
    assert.equal(pinned(missingVersion), false);
    assert.equal(pinned({ ...mac14, identitySha256: "malformed" }), false);
    assert.equal(pinned({ ...mac14, engine: "unknown" }), false);
  } finally {
    linuxFixture.close();
    macFixture.close();
  }
});

test("full-mix references bind the observed runtime version separately from override bundle identity", () => {
  const fixture = fullMix.FIXTURE_BY_ID["tinychip-ws-mid"];
  const metadata = fullMix.REFERENCE.engines.webkit[fixture.id][44100].metadata;
  const mac14 = browserToolchain.engineBundle(resolveBrowserToolchainFixture("/cache/webkit_mac14_special-2251/pw_run.sh"), "webkit");
  const selection = fullMix.selectReference(fullMix.REFERENCE, {
    ...metadata, browserVersion: "observed-platform-version", browserBundle: mac14,
  }, "source");
  assert.equal(selection.reference, null);
  assert.match(selection.problems.join(" "), /browserVersion/);
  assert.match(selection.problems.join(" "), /browserBundle/);
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

test("offline reference export re-derives first-attempt eligibility and validates declared browser overrides", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tinysynth-v6-reference-export-"));
  const linuxFixture = createBrowserToolchainFixture("/cache/webkit-2359/pw_run.sh");
  const linuxToolchain = linuxFixture.resolve();
  try {
    const baseline = makeReanalysisReport(temp, linuxToolchain);
    const options = { env: linuxFixture.env, root: linuxFixture.root };
    const rows = reanalyzer.pairRows(baseline.report, temp, options);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].preBaselineEligible, true);
    assert.equal(rows[0].referenceExportEligible, true);
    assert.equal(rows[0].captureCheckEvidence.source.nativeFaultSensitivity, true);
    assert.equal(rows[0].captureCheckEvidence.min.nativeFaultSensitivity, true);
    assert.match(rows[0].captureCheckEvidence.source.originalFaultSummarySha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(rows[0].captureCheckEvidence.source.originalFaultSensitivity,
      baseline.report.chromium.cases[0].observations.fullMix.builds.source.faultSensitivity);
    const reference = reanalyzer.makeReference(rows, sha256(Buffer.from("retained-test-report")),
      baseline.matrixRun, linuxToolchain, linuxFixture.env, linuxFixture.root);
    assert.equal(reference.status, "incomplete");
    assert.equal(reference.coverage.measuredCases.length, 1);
    assert.ok(reference.engines.chromium[baseline.fixture.id][baseline.sampleRate]);

    const rejects = [
      ["sample-rounded note onset", (obs) => { obs.builds.source.noteInstances.rows[0].onsetSec += 3 / baseline.sampleRate; },
        "independentNoteSourceMap"],
      ["actual program", (obs) => { obs.builds.source.noteInstances.rows[0].actualProgram++; },
        "independentNoteSourceMap"],
      ["velocity", (obs) => { obs.builds.source.noteInstances.rows[0].velocity--; },
        "independentNoteSourceMap"],
      ["percussion mapping", (obs) => { obs.builds.source.noteInstances.rows.find((row) => row.channel === 9).percussion = false; },
        "independentNoteSourceMap"],
      ["early prune", (obs) => { obs.builds.source.noteInstances.rows[0].pruned = true; },
        "independentNoteSourceMap"],
      ["missing prune telemetry", (obs) => { delete obs.builds.source.noteInstances.prunedInstances; },
        "independentNoteSourceMap"],
      ["sample-rounded probe onset", (obs) => { obs.builds.source.probeInstances.rows[0].onsetSec += 3 / baseline.sampleRate; },
        "independentProbeSourceMap"],
      ["page error", (obs) => { obs.builds.source.pageErrors.push("pageerror: fixture fault"); },
        "noSchedulerPageOrNetworkError"],
      ["aborted request", (obs) => { obs.builds.source.aborted.push("https://invalid.test/"); },
        "noSchedulerPageOrNetworkError"],
      ["rejected page operation", (obs) => { obs.builds.source.rejections.push({ name: "fixture rejection" }); },
        "noSchedulerPageOrNetworkError"],
      ["contradictory fault subresult", (obs) => { obs.builds.source.faultSensitivity.relativeProbe.relativeRejected = false; },
        "nativeFaultSensitivity"],
      ["changed settings identity", (obs) => { obs.settingsSha256 = "f".repeat(64); },
        "currentFixtureIdentity"],
      ["changed MIDI identity", (obs) => { obs.midiSha256 = "d".repeat(64); },
        "currentFixtureIdentity"],
      ["stale method identity", (obs) => { obs.methodSha256 = "e".repeat(64); },
        "currentFixtureIdentity"],
      ["contradictory aggregate status", (obs) => { obs.status = "pass"; },
        "producerAggregateStatus"],
      ["contradictory build pass", (obs) => { obs.builds.source.result = "pass"; },
        "producerStatusShape"],
    ];
    for (const [label, mutate, check] of rejects) {
      const report = structuredClone(baseline.report);
      mutate(report.chromium.cases[0].observations.fullMix);
      const rejected = reanalyzer.pairRows(report, temp, options)[0];
      assert.equal(rejected.captureCheckEvidence.source[check], false, label);
      assert.equal(rejected.referenceExportEligible, false, label);
      assert.equal(reanalyzer.makeReference([rejected], sha256(Buffer.from(label)), baseline.matrixRun,
        linuxToolchain, linuxFixture.env, linuxFixture.root).coverage.measuredCases.length, 0, label);
    }

    const failedComparison = structuredClone(baseline.report);
    const failedObs = failedComparison.chromium.cases[0].observations.fullMix;
    Object.assign(failedObs.builds.source, { result: "fail", referenceStatus: "measured", comparisonProblems: ["RMS drift"] });
    failedObs.status = "fail";
    const failedRow = reanalyzer.pairRows(failedComparison, temp, options)[0];
    assert.equal(failedRow.producerAggregateStatusMatches, true);
    assert.equal(failedRow.preBaselineEligible, false);
    assert.equal(failedRow.referenceExportEligible, false);

    const priorMethod = structuredClone(baseline.report);
    const priorObs = priorMethod.chromium.cases[0].observations.fullMix;
    priorObs.methodSha256 = "b".repeat(64);
    priorObs.toleranceSha256 = "c".repeat(64);
    for (const build of ["source", "min"]) {
      delete priorObs.builds[build].pageErrors;
      delete priorObs.builds[build].aborted;
    }
    const priorRow = reanalyzer.pairRows(priorMethod, temp, options)[0];
    assert.equal(priorRow.firstAttemptStatus, "incomplete");
    assert.equal(priorRow.preBaselineEligible, false);
    assert.equal(priorRow.referenceExportEligible, false);
    assert.equal(priorRow.captureCheckEvidence.source.priorMethodEvidence, true);
    assert.equal(priorRow.captureCheckEvidence.source.nativeFaultSensitivity, false);
    assert.equal(priorRow.captureCheckEvidence.source.recomputedFault.checksPass, true);
    assert.match(priorRow.captureCheckEvidence.source.originalFaultSummarySha256, /^[a-f0-9]{64}$/);
    assert.equal(reanalyzer.makeReference([priorRow], sha256(Buffer.from("prior-method")), baseline.matrixRun,
      linuxToolchain, linuxFixture.env, linuxFixture.root).coverage.measuredCases.length, 0);

    const macFixture = createBrowserToolchainFixture("/cache/webkit_mac14_arm64_special-2251/pw_run.sh");
    try {
      const macToolchain = macFixture.resolve();
      assert.equal(macToolchain.browsers.webkit.browserVersion, null);
      const override = makeReanalysisReport(temp, macToolchain, "webkit", "observed-webkit-override-version");
      const macOptions = { env: macFixture.env, root: macFixture.root };
      const macRows = reanalyzer.pairRows(override.report, temp, macOptions);
      assert.equal(macRows.length, 1);
      assert.equal(macRows[0].referenceExportEligible, true);
      const macReference = reanalyzer.makeReference(macRows, sha256(Buffer.from("override-report")),
        override.matrixRun, macToolchain, macFixture.env, macFixture.root);
      const macMetadata = macReference.engines.webkit[override.fixture.id][override.sampleRate].metadata;
      assert.equal(macMetadata.browserVersion, "observed-webkit-override-version");
      assert.equal(macMetadata.browserBundle.browserVersion, null);

      const noObservedVersion = { ...macRows[0], browserVersion: "" };
      assert.throws(() => reanalyzer.makeReference([noObservedVersion], sha256(Buffer.from("blank-version")),
        override.matrixRun, macToolchain, macFixture.env, macFixture.root), /version differs/);
    } finally {
      macFixture.close();
    }
  } finally {
    linuxFixture.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
