/*
 * Fixture-bounded quality-1 full-mix evidence. The full song is rendered first
 * at its original cold origin. Isolated fixture-timbre probes run only after
 * the complete song and its measured quiet separation, through the same
 * OfflineAudioContext output graph. Overlapped note windows describe mixed-bus
 * features; native _note source creation, not scheduled sends or those windows,
 * establishes expected voice-instance integrity.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const pages = require("../lib/pages");
const smf = require("../lib/smf");
const A = require("../lib/analysis");
const FA = require("../lib/first-attempt");
const { tolerances } = require("../tolerances");
const { MATRIX } = require("../matrix");
const browserToolchainSpec = require(path.join(pages.ROOT, "scripts/browser-toolchain"));

const ORIGIN = 0.1;
const REVERB_TAIL = 2.5;
const QUIET_GAP = 0.5;
const PROBE_DURATION = 0.45;
const PROBE_CHANNELS = [14, 15];
const WINDOW_SEC = 0.1;
const TRANSIENT_BLOCK_SEC = 0.001;
const ANALYSIS_VERSION = "fullmix-feature-v6";
const PROBE_PITCH_SEARCH_CENTS = 660;
const PROBE_PITCH_LIMIT_CENTS = 35;
const PROBE_TONE_FRACTION_DB_MIN = -12;
const PROBE_GLOBAL_PROMINENCE_DB_MIN = -36;
const SETUP_PATH = path.join(pages.ROOT, "tests/fixtures/consumer/waves-setup.json");
const FIXTURE_SETUP = JSON.parse(fs.readFileSync(SETUP_PATH, "utf8"));
const SETUP_BYTES = fs.readFileSync(SETUP_PATH);
const TINY_MIDI = fs.readFileSync(path.join(pages.ROOT, "tests/fixtures/consumer", FIXTURE_SETUP.song.file));
const WS_MIDI = fs.readFileSync(path.join(pages.ROOT, "ws.mid"));
const WS_SETTINGS = { quality: 1, masterVol: 0.5, reverbLev: 0.3, liveVoices: 64 };
const EXTERNAL_REFERENCE = !!process.env.TINYSYNTH_BROWSER_MATRIX_REFERENCE;
const REFERENCE_FILE = EXTERNAL_REFERENCE
  ? path.resolve(process.env.TINYSYNTH_BROWSER_MATRIX_REFERENCE)
  : path.join(__dirname, "full-mix-reference.json");
let REFERENCE = null;
let REFERENCE_BYTES = null;
try {
  REFERENCE_BYTES = fs.readFileSync(REFERENCE_FILE);
  REFERENCE = JSON.parse(REFERENCE_BYTES.toString("utf8"));
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function referenceProvenance() {
  return {
    schemaVersion: 1,
    source: EXTERNAL_REFERENCE ? "external-override" : "declared-reference",
    status: REFERENCE_BYTES ? "present" : "absent",
    sha256: REFERENCE_BYTES ? sha256(REFERENCE_BYTES) : null,
    referenceToleranceSha256: REFERENCE && typeof REFERENCE.referenceToleranceSha256 === "string"
      ? REFERENCE.referenceToleranceSha256 : null,
  };
}

const METHOD_FILES = [
  __filename,
  path.join(__dirname, "../page/full-mix.js"),
  path.join(__dirname, "../lib/analysis.js"),
  path.join(__dirname, "../lib/first-attempt.js"),
  path.join(__dirname, "../tolerances.js"),
  path.join(pages.ROOT, "scripts/reanalyze-fullmix-v6.js"),
];
const methodSha256 = sha256(Buffer.concat(METHOD_FILES.flatMap((file) => [
  Buffer.from(path.relative(pages.ROOT, file) + "\0"), fs.readFileSync(file), Buffer.from("\0"),
])));
const toleranceSha256 = sha256(fs.readFileSync(path.join(__dirname, "../tolerances.js")));

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  return JSON.stringify(value);
}

function selectReference(reference, identity, build) {
  const problems = [];
  const fixture = identity && FIXTURE_BY_ID[identity.fixtureId];
  if (!fixture) problems.push("fixtureId");
  if (!identity || identity.seed !== MATRIX.seed) problems.push("seed is not the pinned matrix seed");
  if (!reference || typeof reference !== "object" || Array.isArray(reference))
    return { status: "incomplete", reference: null, problems: ["measured reference is missing"] };
  if (reference.analysisVersion !== ANALYSIS_VERSION) problems.push("analysisVersion");
  if (reference.methodSha256 !== identity.methodSha256) problems.push("methodSha256");
  if (reference.toleranceSha256 !== identity.toleranceSha256) problems.push("toleranceSha256");
  if (!reference.tolerances || reference.referenceToleranceSha256 !== sha256(Buffer.from(canonical(reference.tolerances))))
    problems.push("referenceToleranceSha256");
  const entry = reference.engines && reference.engines[identity.engine] &&
    reference.engines[identity.engine][identity.fixtureId] && reference.engines[identity.engine][identity.fixtureId][identity.sampleRate];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) problems.push("case row");
  const metadata = entry && entry.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) problems.push("case metadata");
  else for (const [key, value] of Object.entries(identity)) {
    const same = value && typeof value === "object"
      ? canonical(metadata[key]) === canonical(value)
      : metadata[key] === value;
    if (!same) problems.push(key);
  }
  if (metadata?.captureMethodSha256 !== fixture?.methodSha256) problems.push("captureMethodSha256 is not the current fixture method");
  if (metadata?.captureToleranceSha256 !== fixture?.toleranceSha256) problems.push("captureToleranceSha256 is not the current fixture tolerance");
  if (metadata?.captureRun?.selection?.seed !== MATRIX.seed) problems.push("captureRun.selection.seed");
  const row = entry && entry[build];
  if (!row || typeof row !== "object" || Array.isArray(row) || !row.metrics || typeof row.metrics !== "object" || Array.isArray(row.metrics))
    problems.push(build + " metrics");
  const capture = row && row.capture;
  if (!capture || typeof capture !== "object" || Array.isArray(capture) || capture.attempt !== 1 ||
      capture.firstAttempt !== true || capture.eligible !== true || capture.finite !== true || capture.overFullScaleSamples !== 0 ||
      !["incomplete", "pass"].includes(capture.priorCaptureVerdict) ||
      typeof metadata?.captureMethodSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(metadata.captureMethodSha256) ||
      typeof capture.captureMethodSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(capture.captureMethodSha256) ||
      capture.captureMethodSha256 !== metadata.captureMethodSha256 || capture.captureMethodSha256 !== fixture?.methodSha256)
    problems.push(build + " first-attempt capture eligibility");
  if (problems.length)
    return { status: "incomplete", reference: null, problems: ["measured reference identity or row is incomplete: " + problems.join(", ")] };
  return { status: "measured", reference: row, problems: [] };
}

function deriveFullMixStatus(builds, sourceMinOk) {
  const eligible = !!(sourceMinOk && builds && builds.source && builds.source.preBaselineEligible === true &&
    builds.min && builds.min.preBaselineEligible === true);
  const source = builds && builds.source && builds.source.result;
  const min = builds && builds.min && builds.min.result;
  const hasFailure = source === "fail" || min === "fail";
  const hasIncomplete = source === "incomplete" || min === "incomplete";
  const status = eligible && source === "pass" && min === "pass" ? "pass"
    : eligible && !hasFailure && hasIncomplete ? "incomplete" : "fail";
  return { captureEligiblePreBaseline: eligible, status };
}

function fixtureWaveCalls() {
  return FIXTURE_SETUP.waves.map((w) => {
    if (w.Harmonics) return ["setHarmonicWave", w.name, w.real, w.imag];
    if (w.samples) return ["setSampleWave", w.name, w.samples];
    const { length, tap, high } = w.SamplesGenerator.lfsr;
    const out = [];
    let r = 1;
    for (let i = 0; i < length; ++i) {
      const fb = (r & 1) ^ ((r >> tap) & 1);
      r = (r >> 1) | (fb << 14);
      out.push((r & 1 ? high : -high) / 128);
    }
    return ["setSampleWave", w.name, out];
  });
}

function tempoMap(fileBytes) {
  const file = smf.read(fileBytes);
  const points = file.tempos.slice().sort((a, b) => a.tick - b.tick);
  const mapped = [];
  let tick = 0, seconds = 0, us = 500000;
  for (const p of points) {
    seconds += (p.tick - tick) * us / 1e6 / file.division;
    tick = p.tick;
    us = p.usPerQuarter;
    mapped.push({ tick, seconds, us });
  }
  return {
    file,
    secondsAt(target) {
      let t = 0, at = 0, tempo = 500000;
      for (const p of mapped) {
        if (p.tick >= target) break;
        t += (p.tick - at) * tempo / 1e6 / file.division;
        at = p.tick;
        tempo = p.us;
      }
      return t + (target - at) * tempo / 1e6 / file.division;
    },
  };
}

/*
 * Decode musical intent independently of the synth. A drum one-shot with no
 * note-off remains duration-unknown; no EOT release is invented. Repeated
 * same-key overlap is retained but marked ambiguous because FIFO pairing is
 * not proof of performer intent.
 */
function noteManifest(bytes) {
  const timing = tempoMap(bytes), events = [];
  timing.file.tracks.forEach((track, trackIndex) => track.events.forEach((event, eventIndex) => {
    if (event.status < 0xf0) events.push({ ...event, trackIndex, eventIndex });
  }));
  events.sort((a, b) => a.tick - b.tick || a.trackIndex - b.trackIndex || a.eventIndex - b.eventIndex);
  const program = Array(16).fill(0), queues = new Map(), counts = Array(timing.file.tracks.length).fill(0), notes = [];
  const key = (ch, pitch) => ch + ":" + pitch;
  let unmatchedNoteOffs = 0;
  for (const event of events) {
    const channel = event.status & 15, command = event.status & 0xf0;
    const at = timing.secondsAt(event.tick);
    if (command === 0xc0) program[channel] = event.data[0];
    if (command === 0x90 && event.data[1] > 0) {
      const ordinal = counts[event.trackIndex]++;
      const note = {
        id: "t" + event.trackIndex + "-n" + String(ordinal).padStart(3, "0"),
        track: event.trackIndex, channel, pitch: event.data[0], velocity: event.data[1],
        program: program[channel], tick: event.tick, onsetSec: +(at + ORIGIN).toFixed(9),
        durationSec: null, offSec: null, unpitched: channel === 9, pairingAmbiguous: false,
      };
      notes.push(note);
      const k = key(channel, note.pitch), q = queues.get(k) || [];
      if (q.length) {
        note.pairingAmbiguous = true;
        q.forEach((earlier) => { earlier.pairingAmbiguous = true; });
      }
      q.push(note);
      queues.set(k, q);
    } else if (command === 0x80 || (command === 0x90 && event.data[1] === 0)) {
      const q = queues.get(key(channel, event.data[0]));
      const note = q && q.shift();
      if (note) {
        note.offSec = +(at + ORIGIN).toFixed(9);
        note.durationSec = +Math.max(0, at - timing.secondsAt(note.tick)).toFixed(9);
        note.termination = "matched-note-off";
      } else {
        ++unmatchedNoteOffs;
      }
    }
  }
  for (const note of notes) {
    if (note.offSec === null)
      note.termination = note.unpitched ? "unpitched-one-shot-no-note-off" : "unpaired-pitched-note-on";
  }
  const times = [];
  for (const note of notes) {
    if (note.unpitched || note.offSec === null || note.pairingAmbiguous) continue;
    times.push([note.onsetSec, 1]);
    times.push([note.offSec, -1]);
  }
  times.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let active = 0, maxKnownSimultaneous = 0;
  for (const [, delta] of times) {
    active += delta;
    if (active > maxKnownSimultaneous) maxKnownSimultaneous = active;
  }
  const timingComplete = notes.every((n) => n.unpitched || (n.durationSec !== null && !n.pairingAmbiguous));
  const songSec = timing.secondsAt(timing.file.endTick);
  const songEndSec = +(ORIGIN + songSec + REVERB_TAIL).toFixed(9);
  return {
    file: timing.file, notes, maxKnownSimultaneous, unmatchedNoteOffs, timingComplete,
    unpitchedOneShotCount: notes.filter((n) => n.unpitched && n.offSec === null).length,
    songSec, songEndSec,
    /* Every future note-on is scheduled at currentTime=0; probes add two more melodic voices. */
    offlineVoices: notes.length + 2 + 1,
  };
}

function downbeatTarget(id, notes) {
  const noteId = id === "tinychip-ws-mid" ? "t0-n001" : "t1-n000";
  const note = notes.find((x) => x.id === noteId);
  if (!note) throw new Error("fixture is missing the pinned downbeat note " + noteId);
  const patch = id === "tinychip-ws-mid"
    ? FIXTURE_SETUP.timbres.find((x) => !x.drum && x.slot === note.program)
    : note.program === 37 ? { operators: [{ t: 2 }] } : null;
  const primary = patch && patch.operators && patch.operators[0];
  const carrierRatio = primary && primary.t;
  if (!Number.isFinite(carrierRatio) || carrierRatio <= 0)
    throw new Error("fixture downbeat lacks its independently pinned primary carrier ratio");
  const expectedPitch = Math.round(note.pitch + 12 * Math.log2(carrierRatio));
  const expectedProgram = id === "tinychip-ws-mid" ? 20 : 37;
  if (note.program !== expectedProgram || note.pitch !== (id === "tinychip-ws-mid" ? 45 : 30) ||
      expectedPitch !== (id === "tinychip-ws-mid" ? 33 : 42))
    throw new Error("fixture downbeat MIDI identity or pinned patch carrier mapping changed");
  return {
    noteId, midiProgram: note.program, midiPitch: note.pitch, carrierRatio, expectedPitch,
    targetHz: A.midiHz(expectedPitch), startOffsetSec: 0.02, durationSec: 0.22,
    patchNote: id === "tinychip-ws-mid"
      ? "TinyChip program 20's primary nTRI output ratio t=0.5 shifts MIDI 45 to MIDI 33"
      : "pinned q1 program 37's primary triangle uses t=2, so its independently decoded MIDI 30 key maps to carrier MIDI 42",
  };
}

/*
 * These are documented fixture timbres that the song itself uses. TinyChip
 * program 20's primary output has t=0.5, so its pitch target is one octave
 * below the MIDI key; program 0 has an intentional 6 Hz FM modulator and a
 * 0.2 s attack. ws.mid uses built-in q1 programs 37 and 81, each with a
 * fundamental oscillator at the key pitch. Probes are isolated, appended only
 * after the musical render/tail, and make no claim about composer-approved mix.
 */
function baseProbes(id, songEndSec) {
  const startA = +(songEndSec + QUIET_GAP).toFixed(9);
  const startB = +(startA + PROBE_DURATION + REVERB_TAIL).toFixed(9);
  if (id === "tinychip-ws-mid") return [
    { id: "lead-program-0-a4", channel: PROBE_CHANNELS[0], program: 0, pitch: 69, expectedPitch: 69, velocity: 100, startSec: startA,
      attackSec: 0.2, patchNote: "TinyChip Triangle Lead; 6 Hz FM operator, level 0.0174797; target is the nTRI carrier at MIDI A4" },
    { id: "bass-program-20-a4-key", channel: PROBE_CHANNELS[1], program: 20, pitch: 69, expectedPitch: 57, velocity: 100, startSec: startB,
      attackSec: 0.002, patchNote: "TinyChip Triangle Bass; primary output ratio t=0.5, target MIDI A3" },
  ];
  return [
    { id: "lead-program-81-a4", channel: PROBE_CHANNELS[0], program: 81, pitch: 69, expectedPitch: 69, velocity: 99, startSec: startA,
      attackSec: 0, patchNote: "ws.mid q1 program 81 sawtooth carrier at key frequency with square FM operator; A4 probe" },
    { id: "lead-program-81-c4", channel: PROBE_CHANNELS[1], program: 81, pitch: 60, expectedPitch: 60, velocity: 99, startSec: startB,
      attackSec: 0, patchNote: "ws.mid q1 program 81 sawtooth carrier at key frequency with square FM operator; C4 probe" },
  ];
}

function createProfile({ id, label, midi, setupBytes, settings, waves, timbres, ...manifest }, profileKind) {
  const probes = baseProbes(id, manifest.songEndSec);
  const fixtureChannels = manifest.file.tracks.flatMap((track) => track.events)
    .filter((event) => event.status < 0xf0).map((event) => event.status & 15);
  const conflictingProbeChannels = PROBE_CHANNELS.filter((channel) => fixtureChannels.includes(channel));
  if (conflictingProbeChannels.length)
    throw new Error("fixture uses reserved isolated-probe channels " + conflictingProbeChannels.join(", "));
  const downbeat = downbeatTarget(id, manifest.notes);
  const setupSha256 = sha256(setupBytes);
  const midiSha256 = sha256(midi);
  const probePlanSha256 = sha256(Buffer.from(canonical(probes)));
  const setupProvenance = id === "tinychip-ws-mid" ? {
    consumerRepo: FIXTURE_SETUP.provenance.consumer.repo, consumerCommit: FIXTURE_SETUP.provenance.consumer.commit,
    ...(typeof FIXTURE_SETUP.schemaNote === "string" ? { schemaNote: FIXTURE_SETUP.schemaNote } : {}),
    conversion: FIXTURE_SETUP.conversion,
    installConversion: "fixture wave/timbre JSON is converted by tests/browser/specs/waves.js call preparation; not current on-chain/player wire bytes",
  } : { profile: "synthetic ws.mid default q1 profile; not application settings" };
  const settingsForHash = {
    settings, matrixSeed: MATRIX.seed, probeChannels: PROBE_CHANNELS,
    probeTuning: "standard master tuning and independent reserved channels; no channel-wide cleanup messages",
    probes: probes.map(({ id: probeId, channel, program, pitch, expectedPitch, velocity, attackSec }) =>
      ({ id: probeId, channel, program, pitch, expectedPitch, velocity, attackSec })),
    offlineVoices: manifest.offlineVoices, playbackOriginSec: ORIGIN, tailSec: REVERB_TAIL,
    downbeat, setupProvenance, analysisVersion: ANALYSIS_VERSION, methodSha256, toleranceSha256,
    isolatedPitchPolicy: {
      searchCents: PROBE_PITCH_SEARCH_CENTS, intendedPitchBoundCents: PROBE_PITCH_LIMIT_CENTS,
      spectralPeakToGlobalMinimumDb: PROBE_GLOBAL_PROMINENCE_DB_MIN,
      fittedToneToTotalRmsMinimumDb: PROBE_TONE_FRACTION_DB_MIN,
      analysisWindowSec: 0.18, minimumWindowSec: 0.14,
    },
  };
  const settingsSha256 = sha256(Buffer.from(canonical(settingsForHash)));
  const renderDurationSec = +(probes[1].startSec + PROBE_DURATION + REVERB_TAIL).toFixed(9);
  return Object.assign({}, manifest, {
    id, label, profileKind, midi, setupBytes, settings, waves, timbres, probes,
    setupSha256, midiSha256, probePlanSha256, settingsSha256, settingsForHash, setupProvenance, downbeat,
    methodSha256, toleranceSha256, liveVoices: settings.liveVoices, renderDurationSec,
  });
}

function fixtures() {
  const tinyManifest = noteManifest(TINY_MIDI);
  const tinySettings = {
    quality: FIXTURE_SETUP.settings.engine.quality,
    masterVol: FIXTURE_SETUP.settings.engine.masterVol,
    reverbLev: FIXTURE_SETUP.settings.engine.reverbLev,
    liveVoices: FIXTURE_SETUP.settings.engine.voices,
  };
  const tiny = createProfile({
    id: "tinychip-ws-mid", label: "TinyChip consumer setup/song", midi: TINY_MIDI, setupBytes: SETUP_BYTES,
    settings: tinySettings, waves: fixtureWaveCalls(),
    timbres: FIXTURE_SETUP.timbres.map((tb) => [tb.drum ? 1 : 0, tb.slot, tb.operators]), ...tinyManifest,
  }, "pinned-consumer-settings");
  const wsManifest = noteManifest(WS_MIDI);
  const ws = createProfile({
    id: "ws-mid-default", label: "ws.mid at documented synthetic q1 defaults", midi: WS_MIDI,
    setupBytes: Buffer.from(canonical({ profile: "synthetic ws.mid default q1", settings: WS_SETTINGS })),
    settings: WS_SETTINGS, waves: [], timbres: [], ...wsManifest,
  }, "synthetic-default-profile");
  return [tiny, ws];
}

const FIXTURES = fixtures();
const FIXTURE_BY_ID = Object.fromEntries(FIXTURES.map((f) => [f.id, f]));
const decode = (b64) => {
  const data = Buffer.from(b64, "base64"), copy = new ArrayBuffer(data.byteLength);
  new Uint8Array(copy).set(data);
  return new Float32Array(copy);
};
const rmsWindow = (x, sr, startSec, durationSec) => {
  const from = Math.max(0, Math.round(startSec * sr));
  const to = Math.min(x.length, Math.round((startSec + durationSec) * sr));
  return A.rms(x, from, to);
};
const stereoRms = (channels, sr, startSec, durationSec) => {
  const l = rmsWindow(channels[0], sr, startSec, durationSec);
  const r = rmsWindow(channels[1], sr, startSec, durationSec);
  return Math.sqrt((l * l + r * r) / 2);
};
function transientEnvelope(channels, sr, note) {
  const lengthSec = Math.min(0.35, Math.max(0, note.durationSec || 0.35));
  const blocks = Math.max(1, Math.floor(lengthSec / TRANSIENT_BLOCK_SEC));
  const from = Math.round(note.onsetSec * sr), block = Math.max(1, Math.round(TRANSIENT_BLOCK_SEC * sr));
  return {
    noteId: note.id, onsetSec: note.onsetSec, durationSec: lengthSec, blockSec: TRANSIENT_BLOCK_SEC,
    left: Array.from({ length: blocks }, (_, i) => A.rms(channels[0], from + i * block, Math.min(channels[0].length, from + (i + 1) * block))),
    right: Array.from({ length: blocks }, (_, i) => A.rms(channels[1], from + i * block, Math.min(channels[1].length, from + (i + 1) * block))),
  };
}

function analyzeProbe(channels, sampleRate, probe) {
  const onsetWindow = Math.min(0.4, PROBE_DURATION);
  const peakRange = channels.map((x) => A.peak(x, Math.round(probe.startSec * sampleRate),
    Math.round((probe.startSec + onsetWindow) * sampleRate)));
  const peak = Math.max(...peakRange);
  let onsetIndex = -1, selected = peakRange[0] >= peakRange[1] ? 0 : 1;
  const threshold = peak * 0.02;
  const from = Math.round(probe.startSec * sampleRate), to = Math.min(channels[selected].length, from + Math.round(onsetWindow * sampleRate));
  for (let i = from; i < to; ++i) if (Math.abs(channels[selected][i]) >= threshold && threshold > 0) { onsetIndex = i; break; }
  const onsetMs = onsetIndex < 0 ? null : 1000 * (onsetIndex / sampleRate - probe.startSec);
  const measureStart = probe.startSec + 0.25, measureSec = 0.15;
  const levelRms = stereoRms(channels, sampleRate, measureStart, measureSec);
  const pitchStart = probe.startSec + 0.25, pitchDuration = 0.18;
  const pitchFrom = Math.max(0, Math.round(pitchStart * sampleRate));
  const pitchTo = Math.min(channels[selected].length, pitchFrom + Math.round(pitchDuration * sampleRate));
  const pitchSamples = pitchTo - pitchFrom;
  const expectedHz = A.midiHz(probe.expectedPitch);
  let estimate = null, toneFractionDb = null;
  if (pitchSamples >= Math.round(0.14 * sampleRate)) {
    estimate = A.peakFrequency(channels[selected], sampleRate, {
      start: pitchStart, duration: pitchDuration,
      /* Search broadly enough to find wrong semitones; intended pitch is checked separately. */
      fmin: expectedHz * Math.pow(2, -PROBE_PITCH_SEARCH_CENTS / 1200),
      fmax: expectedHz * Math.pow(2, PROBE_PITCH_SEARCH_CENTS / 1200),
    });
    if (estimate) {
      const x = channels[selected];
      let mean = 0, real = 0, imag = 0;
      for (let i = pitchFrom; i < pitchTo; ++i) mean += x[i];
      mean /= pitchSamples;
      for (let i = pitchFrom; i < pitchTo; ++i) {
        const phase = 2 * Math.PI * estimate.freq * (i - pitchFrom) / sampleRate;
        const value = x[i] - mean;
        real += value * Math.cos(phase);
        imag += value * Math.sin(phase);
      }
      const fittedToneRms = Math.SQRT2 * Math.hypot(real, imag) / pitchSamples;
      const signalRms = A.rms(x, pitchFrom, pitchTo);
      toneFractionDb = signalRms > 0 ? 20 * Math.log10(fittedToneRms / signalRms) : null;
    }
  }
  const pitchCents = estimate ? A.cents(estimate.freq, A.midiHz(probe.expectedPitch)) : null;
  const envelope = [];
  for (let i = 0; i < 40; ++i) {
    const start = probe.startSec + i * 0.01;
    envelope.push(stereoRms(channels, sampleRate, start, 0.01));
  }
  const spectralPeakToGlobalDb = estimate ? estimate.level : null;
  const complete = pitchSamples >= Math.round(0.14 * sampleRate) && levelRms > 1e-7 && estimate &&
    Number.isFinite(pitchCents) && Math.abs(pitchCents) <= PROBE_PITCH_LIMIT_CENTS &&
    Number.isFinite(onsetMs) && Number.isFinite(spectralPeakToGlobalDb) && spectralPeakToGlobalDb >= PROBE_GLOBAL_PROMINENCE_DB_MIN &&
    Number.isFinite(toneFractionDb) && toneFractionDb >= PROBE_TONE_FRACTION_DB_MIN;
  return {
    id: probe.id, channel: probe.channel, program: probe.program, pitch: probe.pitch, expectedPitch: probe.expectedPitch,
    velocity: probe.velocity, startSec: probe.startSec, durationSec: PROBE_DURATION, patchNote: probe.patchNote,
    status: complete ? "measured" : "incomplete", onsetMs, onsetThresholdFraction: 0.02,
    levelRms, levelStartSec: measureStart, levelDurationSec: measureSec,
    pitchStartSec: pitchStart, pitchDurationSec: pitchDuration, pitchSearchCents: PROBE_PITCH_SEARCH_CENTS,
    pitchCents, spectralPeakToGlobalDb, toneFractionDb,
    envelopeStepSec: 0.01, envelope,
  };
}

function toneBandFeature(channels, sampleRate, note, expectedPitch, startOffsetSec, durationSec) {
  const startSec = note.onsetSec + startOffsetSec;
  const maxDuration = note.durationSec === null ? durationSec : Math.max(0.001, note.durationSec - startOffsetSec);
  const measuredDurationSec = Math.min(durationSec, maxDuration);
  const expectedHz = A.midiHz(expectedPitch);
  const segmentFrom = Math.max(0, Math.round(startSec * sampleRate));
  const segmentTo = Math.min(channels[0].length, segmentFrom + Math.round(measuredDurationSec * sampleRate));
  const project = (x) => {
    if (segmentTo - segmentFrom < 64) return 0;
    const count = segmentTo - segmentFrom;
    let real = 0, imag = 0, weight = 0;
    for (let i = 0; i < count; ++i) {
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / Math.max(1, count - 1));
      const phase = 2 * Math.PI * expectedHz * i / sampleRate;
      real += x[segmentFrom + i] * w * Math.cos(phase);
      imag += x[segmentFrom + i] * w * Math.sin(phase);
      weight += w;
    }
    return Math.hypot(real, imag) * Math.SQRT2 / Math.max(weight, 1);
  };
  const leftBandRms = project(channels[0]), rightBandRms = project(channels[1]);
  const bandRms = Math.sqrt((leftBandRms * leftBandRms + rightBandRms * rightBandRms) / 2);
  const totalRms = stereoRms(channels, sampleRate, startSec, measuredDurationSec);
  return {
    noteId: note.id, expectedPitch, targetHz: expectedHz, startSec, durationSec: measuredDurationSec,
    leftBandRms, rightBandRms,
    bandRms, totalRms,
    bandToMixDb: bandRms > 0 && totalRms > 0 ? 20 * Math.log10(bandRms / totalRms) : null,
    channel: "stereo",
    status: bandRms > 1e-7 && Number.isFinite(bandRms) ? "measured" : "incomplete",
    measurement: "fixed expected-frequency projection of actual summed stereo bus; reference band feature only, not isolated pitch proof",
  };
}

function analyzeChannels(channels, sampleRate, fixture) {
  const songLength = Math.min(channels[0].length, Math.ceil(fixture.songEndSec * sampleRate));
  const songChannels = channels.map((x) => x.subarray(0, songLength));
  const channelStats = {};
  for (const [i, name] of ["left", "right"].entries()) {
    const x = songChannels[i], all = channels[i], nf = A.nonFinite(all);
    const windowLevels = [];
    for (let start = 0; start < songLength / sampleRate; start += WINDOW_SEC) {
      const len = Math.min(WINDOW_SEC, songLength / sampleRate - start);
      if (len <= 0) break;
      const value = rmsWindow(x, sampleRate, start, len);
      windowLevels.push({ startSec: +start.toFixed(3), durationSec: +len.toFixed(3), rms: value,
        levelDb: 20 * Math.log10(Math.max(value, 1e-12)) });
    }
    channelStats[name] = {
      finite: nf.nan === 0 && nf.inf === 0, nan: nf.nan, inf: nf.inf,
      fullRenderPeak: A.peak(all), fullRenderRms: A.rms(all),
      songPeak: A.peak(x), songRms: A.rms(x), windowLevels,
    };
  }
  const notes = fixture.notes.map((note) => {
    const windowStartSec = note.onsetSec + 0.012;
    const requested = note.durationSec === null ? 0.1 : Math.min(0.1, Math.max(0.001, note.durationSec - 0.012));
    const windowDurationSec = Math.max(0.001, Math.min(requested, fixture.songEndSec - windowStartSec));
    const windowRms = stereoRms(songChannels, sampleRate, windowStartSec, windowDurationSec);
    const start = Math.round(windowStartSec * sampleRate), end = Math.round((windowStartSec + windowDurationSec) * sampleRate);
    const localPeak = Math.max(A.peak(songChannels[0], start, end), A.peak(songChannels[1], start, end));
    return {
      id: note.id, channel: note.channel, pitch: note.pitch, velocity: note.velocity, program: note.program,
      onsetSec: note.onsetSec, durationSec: note.durationSec, termination: note.termination,
      timingStatus: note.unpitched ? "one-shot-or-duration-unknown" : note.durationSec === null || note.pairingAmbiguous ? "incomplete" : "matched",
      windowStartSec, windowDurationSec, windowRms, localPeak,
      overlapFeatureOnly: true, unpitched: note.unpitched, pitchCents: null,
    };
  });
  const first = fixture.notes[0] || null;
  const transient = first ? transientEnvelope(songChannels, sampleRate, first) : null;
  const probes = fixture.probes.map((probe) => analyzeProbe(channels, sampleRate, probe));
  const left = channelStats.left, right = channelStats.right;
  let overFullScaleSamples = 0;
  for (const x of channels) for (let i = 0; i < x.length; ++i) if (Math.abs(x[i]) > 1) ++overFullScaleSamples;
  const songRms = Math.sqrt((left.songRms ** 2 + right.songRms ** 2) / 2);
  const overall = {
    rms: songRms, peak: Math.max(A.peak(channels[0]), A.peak(channels[1])),
    overFullScaleSamples, channelBalanceDb: 20 * Math.log10(Math.max(left.songRms, 1e-20) / Math.max(right.songRms, 1e-20)),
    measuredDurationSec: songLength / sampleRate, rawDurationSec: channels[0].length / sampleRate,
  };
  const relativeProbeLevelDb = 20 * Math.log10(Math.max(probes[0].levelRms, 1e-20) / Math.max(probes[1].levelRms, 1e-20));
  const downbeatNote = fixture.notes.find((x) => x.id === fixture.downbeat.noteId);
  const downbeat = downbeatNote
    ? toneBandFeature(songChannels, sampleRate, downbeatNote, fixture.downbeat.expectedPitch,
      fixture.downbeat.startOffsetSec, fixture.downbeat.durationSec)
    : null;
  const rawLeftRms = A.rms(channels[0]), rawRightRms = A.rms(channels[1]);
  overall.rawRenderRms = Math.sqrt((rawLeftRms ** 2 + rawRightRms ** 2) / 2);
  overall.rawRenderBalanceDb = 20 * Math.log10(Math.max(rawLeftRms, 1e-20) / Math.max(rawRightRms, 1e-20));
  const isolation = fixture.probes.map((probe) => ({
    id: probe.id, startSec: probe.startSec,
    preProbeRms: stereoRms(channels, sampleRate, Math.max(0, probe.startSec - 0.2), 0.19),
  }));
  return {
    channels: channelStats, notes, transient, downbeat, probes,
    relativeProbeLevelDb, isolation,
    voiceDemand: {
      noteOnCount: fixture.notes.length, knownMaxSimultaneous: fixture.maxKnownSimultaneous,
      timingComplete: fixture.timingComplete, unmatchedNoteOffs: fixture.unmatchedNoteOffs,
      liveBudget: fixture.liveVoices, offlineCeiling: fixture.offlineVoices,
      offlineCeilingDerivation: "all independently parsed fixture note-ons (including drum events) + two post-song probe voices + one spare; drum-source event demand is also recorded and this is not the live/realtime budget",
      unpitchedOneShotCount: fixture.unpitchedOneShotCount,
    },
    overall, windowSec: WINDOW_SEC,
  };
}

function matchVoiceCreations(fixture, observations, prunedInstances, sampleRate) {
  const used = new Set(), rows = [];
  const songEnd = fixture.songEndSec - REVERB_TAIL;
  const songObservations = observations.filter((x) => x.timeSec + 0.000001 >= ORIGIN && x.timeSec < songEnd);
  for (const expected of fixture.notes) {
    const targetSample = Math.round(expected.onsetSec * sampleRate);
    let found = -1;
    for (let i = 0; i < songObservations.length; ++i) {
      const actual = songObservations[i];
      if (used.has(i)) continue;
      if (actual.channel === expected.channel && actual.pitch === expected.pitch && actual.velocity === expected.velocity &&
        Math.round(actual.timeSec * sampleRate) === targetSample) { found = i; break; }
    }
    if (found < 0) {
      rows.push({ id: expected.id, status: "missing-native-note-call", channel: expected.channel, pitch: expected.pitch,
        velocity: expected.velocity, program: expected.program, onsetSec: expected.onsetSec, sourceCount: 0 });
      continue;
    }
    used.add(found);
    const actual = songObservations[found];
    const pruned = prunedInstances.some((x) => x.channel === actual.channel && x.pitch === actual.pitch &&
      Math.round(x.timeSec * sampleRate) === Math.round(actual.timeSec * sampleRate));
    const status = !actual.created || actual.sourceCount <= 0 ? "dropped" : pruned ? "pruned-before-render-end" :
      actual.program !== expected.program ? "program-state-mismatch" : "created";
    rows.push({ id: expected.id, status, channel: actual.channel, pitch: actual.pitch, velocity: actual.velocity,
      program: expected.program, actualProgram: actual.program, onsetSec: actual.timeSec,
      sourceCount: actual.sourceCount, percussion: actual.percussion, pruned });
  }
  const extras = songObservations.filter((_, i) => !used.has(i));
  return {
    rows, extras, expectedCount: fixture.notes.length,
    createdCount: rows.filter((x) => x.status === "created").length,
    prunedInstances: prunedInstances.filter((x) => x.timeSec >= ORIGIN && x.timeSec < songEnd),
    complete: rows.length === fixture.notes.length && rows.every((x) => x.status === "created" && x.sourceCount > 0) && extras.length === 0,
  };
}

function matchProbeCreations(fixture, observations, prunedInstances, sampleRate) {
  const rows = fixture.probes.map((probe) => {
    const at = Math.round(probe.startSec * sampleRate);
    const actual = observations.find((x) => x.channel === probe.channel && x.pitch === probe.pitch &&
      x.velocity === probe.velocity && Math.round(x.timeSec * sampleRate) === at);
    if (!actual) return { id: probe.id, status: "missing-native-probe-call", channel: probe.channel, sourceCount: 0 };
    const pruned = prunedInstances.some((x) => x.channel === probe.channel && x.pitch === probe.pitch &&
      Math.round(x.timeSec * sampleRate) === at);
    const status = !actual.created || actual.sourceCount <= 0 ? "dropped" : pruned ? "pruned-before-render-end" :
      actual.program !== probe.program ? "program-state-mismatch" : "created";
    return { id: probe.id, status, channel: probe.channel, pitch: actual.pitch, velocity: actual.velocity,
      program: probe.program, actualProgram: actual.program, onsetSec: actual.timeSec,
      sourceCount: actual.sourceCount, pruned };
  });
  return {
    rows, expectedCount: fixture.probes.length,
    createdCount: rows.filter((x) => x.status === "created").length,
    prunedInstances: prunedInstances.filter((x) => PROBE_CHANNELS.includes(x.channel)),
    complete: rows.length === fixture.probes.length && rows.every((x) => x.status === "created" && x.sourceCount > 0),
  };
}

function sameEnginePcm(a, b, engine) {
  const tolerance = tolerances(engine).sameEngineSample;
  const result = FA.compareRenders({ channels: a }, { channels: b }, tolerance);
  return {
    ok: result.ok, tolerance, maxDiff: result.maxDiff, firstDifferingSample: result.firstDifferingSample,
    category: result.category, reasons: result.reasons,
  };
}

function relativeProbeFault(channels, sampleRate, fixture, probeIndex = 1, factor = 0.99) {
  const clone = channels.map((x) => Float32Array.from(x));
  const probe = fixture.probes[probeIndex];
  const from = Math.round((probe.startSec + 0.25) * sampleRate);
  const to = Math.min(clone[0].length, from + Math.round(0.15 * sampleRate));
  for (const channel of clone) for (let i = from; i < to; ++i) channel[i] *= factor;
  return clone;
}

function zeroDownbeatWindow(channels, sampleRate, fixture) {
  const clone = channels.map((x) => Float32Array.from(x));
  const note = fixture.notes.find((x) => x.id === fixture.downbeat.noteId);
  const from = Math.round((note.onsetSec + fixture.downbeat.startOffsetSec) * sampleRate);
  const to = Math.min(clone[0].length, from + Math.round(fixture.downbeat.durationSec * sampleRate));
  for (const channel of clone) channel.fill(0, from, to);
  return clone;
}

function faultSensitivity(channels, sampleRate, fixture, metrics, voiceEvidence) {
  const missingRows = voiceEvidence.rows.map((row) => row.id === fixture.downbeat.noteId
    ? Object.assign({}, row, { status: "missing-native-note-call", sourceCount: 0 }) : row);
  const missingRejected = !missingRows.every((row) => row.status === "created" && row.sourceCount > 0);
  const downbeatMuted = analyzeChannels(zeroDownbeatWindow(channels, sampleRate, fixture), sampleRate, fixture);
  const downbeatDropDb = 20 * Math.log10(Math.max(metrics.downbeat.bandRms, 1e-20) / Math.max(downbeatMuted.downbeat.bandRms, 1e-20));
  const probeMuted = analyzeChannels(relativeProbeFault(channels, sampleRate, fixture), sampleRate, fixture);
  const relativeDeltaDb = Math.abs(probeMuted.relativeProbeLevelDb - metrics.relativeProbeLevelDb);
  const rawRmsDriftDb = Math.abs(20 * Math.log10(Math.max(probeMuted.overall.rawRenderRms, 1e-20) / Math.max(metrics.overall.rawRenderRms, 1e-20)));
  const rawBalanceDeltaDb = Math.abs(probeMuted.overall.rawRenderBalanceDb - metrics.overall.rawRenderBalanceDb);
  const baseline = REFERENCE && REFERENCE.tolerances;
  /* Fixed fault limits use the reviewed reference policy, with the same frozen
   * 0.001 dB whole-render checks while an initial reference is absent. */
  const downbeatLimit = baseline ? baseline.downbeatBandDb : 10;
  const relativeLimit = baseline ? baseline.relativeProbeDb : 0.001;
  const rawLimit = baseline ? baseline.overallDb : 0.001;
  const balanceLimit = baseline ? baseline.balanceDb : 0.001;
  const downbeatRejected = downbeatDropDb > downbeatLimit;
  const relativeRejected = relativeDeltaDb > relativeLimit;
  return {
    type: "diagnostic-only mutations of first-attempt native Float32 PCM and native voice observations; no rerender",
    missingDownbeat: {
      noteId: fixture.downbeat.noteId, voiceCreationOmissionRejected: missingRejected,
      mutedMixedBusBandDropDb: downbeatDropDb, mutedMixedBusBandRejected: downbeatRejected,
    },
    relativeProbe: {
      mutedProbeId: fixture.probes[1].id, factor: 0.99, relativeDeltaDb,
      wholeRenderRmsDriftDb: rawRmsDriftDb, wholeRenderBalanceDeltaDb: rawBalanceDeltaDb,
      relativeRejected, wholeRenderRmsStillWithinPolicy: rawRmsDriftDb <= rawLimit,
      wholeRenderBalanceStillWithinPolicy: rawBalanceDeltaDb <= balanceLimit,
    },
    checksPass: missingRejected && downbeatRejected && relativeRejected && rawRmsDriftDb <= rawLimit && rawBalanceDeltaDb <= balanceLimit,
  };
}

function compareEnvelope(got, want, toleranceDb, name) {
  const problems = [];
  for (const side of ["left", "right"]) {
    const a = got && got[side], b = want && want[side];
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      problems.push(name + " " + side + " envelope shape differs");
      continue;
    }
    for (let i = 0; i < a.length; ++i) {
      const db = Math.abs(20 * Math.log10(Math.max(a[i], 1e-12) / Math.max(b[i], 1e-12)));
      if (!Number.isFinite(db) || db > toleranceDb) {
        problems.push(name + " " + side + " envelope block " + i + " differs " + (Number.isFinite(db) ? db.toFixed(2) : "nonfinite") + " dB");
        break;
      }
    }
  }
  return problems;
}

const REFERENCE_TOLERANCE_KEYS = [
  "overallDb", "peakAbs", "windowFloor", "windowDb", "noteWindowDb", "independentProbePitchCents",
  "downbeatBandDb", "probePitchCents", "transientEnvelopeDb", "balanceDb", "probeOnsetMs",
  "probeLevelDb", "probeEnvelopeDb", "relativeProbeDb",
];

const finiteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const nonNegativeNumber = (value) => finiteNumber(value) && value >= 0;
const positiveNumber = (value) => finiteNumber(value) && value > 0;

function referenceShapeProblems(actual, reference, tolerancesForRef) {
  const problems = [];
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) return ["reference metrics are missing"];
  if (!tolerancesForRef || typeof tolerancesForRef !== "object" || Array.isArray(tolerancesForRef))
    return ["reference tolerance policy is missing"];
  for (const key of REFERENCE_TOLERANCE_KEYS)
    if (!nonNegativeNumber(tolerancesForRef[key])) problems.push("tolerance " + key + " must be a finite non-negative number");
  for (const [label, metrics] of [["actual", actual], ["reference", reference]]) {
    if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
      problems.push(label + " metrics are malformed");
      continue;
    }
    if (!metrics.channels || !metrics.overall || !Array.isArray(metrics.notes) ||
        !Array.isArray(metrics.probes) || !metrics.transient || typeof metrics.transient !== "object" || !metrics.downbeat ||
        !finiteNumber(metrics.relativeProbeLevelDb))
      problems.push(label + " metrics are missing required feature groups");
    for (const side of ["left", "right"]) {
      const channel = metrics.channels && metrics.channels[side];
      if (!channel || !positiveNumber(channel.songRms) || !nonNegativeNumber(channel.fullRenderPeak) ||
          !Array.isArray(channel.windowLevels)) {
        problems.push(label + " " + side + " channel metrics are malformed");
        continue;
      }
      for (const [i, window] of channel.windowLevels.entries())
        if (!window || !nonNegativeNumber(window.rms) || !finiteNumber(window.levelDb) ||
            !nonNegativeNumber(window.startSec) || !positiveNumber(window.durationSec))
          problems.push(label + " " + side + " window " + i + " is malformed");
    }
    const overall = metrics.overall;
    if (!overall || !positiveNumber(overall.rms) || !positiveNumber(overall.rawRenderRms) ||
        !finiteNumber(overall.channelBalanceDb) || !finiteNumber(overall.rawRenderBalanceDb))
      problems.push(label + " overall metrics are malformed");
    const noteIds = new Set();
    for (const note of metrics.notes || []) {
      if (!note || typeof note.id !== "string" || noteIds.has(note.id) || !positiveNumber(note.windowRms))
        problems.push(label + " note-window metrics contain missing, duplicate or invalid rows");
      else noteIds.add(note.id);
    }
    const downbeat = metrics.downbeat;
    if (!downbeat || downbeat.status !== "measured" || !positiveNumber(downbeat.targetHz) ||
        !finiteNumber(downbeat.expectedPitch) || !positiveNumber(downbeat.bandRms) ||
        !positiveNumber(downbeat.leftBandRms) || !positiveNumber(downbeat.rightBandRms))
      problems.push(label + " mixed-bus downbeat frequency-projection metrics are malformed");
    const probeIds = new Set();
    for (const probe of metrics.probes || []) {
      if (!probe || typeof probe.id !== "string" || probeIds.has(probe.id) || probe.status !== "measured" ||
          !finiteNumber(probe.pitchCents) || !finiteNumber(probe.toneFractionDb) ||
          !finiteNumber(probe.spectralPeakToGlobalDb) || !positiveNumber(probe.levelRms) ||
          !nonNegativeNumber(probe.onsetMs) || !Array.isArray(probe.envelope) ||
          probe.envelope.some((value) => !nonNegativeNumber(value)))
        problems.push(label + " isolated-probe metrics contain missing, duplicate or invalid rows");
      else probeIds.add(probe.id);
    }
    const transient = metrics.transient;
    if (!transient || typeof transient.noteId !== "string" || !Array.isArray(transient.left) || !Array.isArray(transient.right) ||
        transient.left.length === 0 || transient.left.length !== transient.right.length ||
        transient.left.some((value) => !nonNegativeNumber(value)) || transient.right.some((value) => !nonNegativeNumber(value)))
      problems.push(label + " transient envelope is malformed");
  }
  return problems;
}

function compareBuildToReference(actual, reference, tolerancesForRef) {
  const problems = referenceShapeProblems(actual, reference, tolerancesForRef);
  if (problems.length) return problems;
  for (const side of ["left", "right"]) {
    const got = actual.channels[side], want = reference.channels[side];
    if (Math.abs(20 * Math.log10(got.songRms / want.songRms)) > tolerancesForRef.overallDb) problems.push(side + " whole-song RMS drift");
    if (Math.abs(got.fullRenderPeak - want.fullRenderPeak) > tolerancesForRef.peakAbs) problems.push(side + " full-render peak drift");
    if (got.windowLevels.length !== want.windowLevels.length) problems.push(side + " 100ms window count differs");
    for (let i = 0; i < Math.min(got.windowLevels.length, want.windowLevels.length); ++i) {
      if (want.windowLevels[i].rms < tolerancesForRef.windowFloor) continue;
      const db = Math.abs(20 * Math.log10(Math.max(got.windowLevels[i].rms, 1e-12) / want.windowLevels[i].rms));
      if (!Number.isFinite(db) || db > tolerancesForRef.windowDb) problems.push(side + " 100ms window " + i + " level drift " + db.toFixed(2) + " dB");
    }
  }
  const wantNotes = new Map(reference.notes.map((n) => [n.id, n]));
  if (actual.notes.length !== reference.notes.length) problems.push("overlapped note-window feature count differs");
  for (const note of actual.notes) {
    const want = wantNotes.get(note.id);
    if (!want) { problems.push("unexpected mixed-bus note-window feature " + note.id); continue; }
    if (Math.abs(20 * Math.log10(Math.max(note.windowRms, 1e-12) / Math.max(want.windowRms, 1e-12))) > tolerancesForRef.noteWindowDb)
      problems.push("overlapped note-window feature " + note.id + " level drift");
  }
  if (!actual.transient || !reference.transient) problems.push("first-downbeat transient feature is incomplete");
  else {
    if (actual.transient.noteId !== reference.transient.noteId) problems.push("first-downbeat note identity differs");
    problems.push(...compareEnvelope(actual.transient, reference.transient, tolerancesForRef.transientEnvelopeDb, "first-downbeat"));
  }
  if (Math.abs(actual.overall.channelBalanceDb - reference.overall.channelBalanceDb) > tolerancesForRef.balanceDb)
    problems.push("stereo song output balance drift (not a musical-part mix claim)");
  if (Math.abs(20 * Math.log10(actual.overall.rawRenderRms / reference.overall.rawRenderRms)) > tolerancesForRef.overallDb)
    problems.push("whole raw-render RMS drift");
  if (Math.abs(actual.overall.rawRenderBalanceDb - reference.overall.rawRenderBalanceDb) > tolerancesForRef.balanceDb)
    problems.push("whole raw-render stereo output balance drift");
  if (!actual.downbeat || !reference.downbeat || actual.downbeat.status !== "measured" || reference.downbeat.status !== "measured")
    problems.push("selected mixed-bus downbeat frequency-projection feature is incomplete");
  else {
    if (actual.downbeat.expectedPitch !== reference.downbeat.expectedPitch ||
        Math.abs(actual.downbeat.targetHz - reference.downbeat.targetHz) > 1e-8)
      problems.push("selected mixed-bus downbeat independent target differs");
    if (Math.abs(20 * Math.log10(Math.max(actual.downbeat.bandRms, 1e-12) / Math.max(reference.downbeat.bandRms, 1e-12))) > tolerancesForRef.downbeatBandDb)
      problems.push("selected mixed-bus downbeat band level drift");
  }
  if (actual.probes.length !== reference.probes.length) problems.push("isolated probe count differs");
  const wantProbes = new Map(reference.probes.map((x) => [x.id, x]));
  for (const probe of actual.probes) {
    const want = wantProbes.get(probe.id);
    if (!want || probe.status !== "measured" || want.status !== "measured") {
      problems.push("isolated pitch/envelope probe " + probe.id + " is incomplete");
      continue;
    }
    if (Math.abs(probe.pitchCents) > tolerancesForRef.independentProbePitchCents || Math.abs(probe.pitchCents) > PROBE_PITCH_LIMIT_CENTS)
      problems.push("isolated probe " + probe.id + " violates independent intended-pitch bound");
    if (Math.abs(probe.pitchCents - want.pitchCents) > tolerancesForRef.probePitchCents)
      problems.push("isolated probe " + probe.id + " pitch drift");
    if (Math.abs(probe.onsetMs - want.onsetMs) > tolerancesForRef.probeOnsetMs)
      problems.push("isolated probe " + probe.id + " onset drift");
    if (Math.abs(20 * Math.log10(probe.levelRms / want.levelRms)) > tolerancesForRef.probeLevelDb)
      problems.push("isolated probe " + probe.id + " level drift");
    problems.push(...compareEnvelope(
      { left: probe.envelope, right: probe.envelope }, { left: want.envelope, right: want.envelope },
      tolerancesForRef.probeEnvelopeDb, "isolated probe " + probe.id,
    ));
  }
  if (Math.abs(actual.relativeProbeLevelDb - reference.relativeProbeLevelDb) > tolerancesForRef.relativeProbeDb)
    problems.push("isolated fixture-timbre relative level drift (not composer mix approval)");
  return problems;
}

function referenceExpectedCases() {
  return ["chromium", "firefox", "webkit"].flatMap((engine) => FIXTURES.flatMap((fixture) => [44100, 48000]
    .map((sampleRate) => engine + "/" + fixture.id + "/" + sampleRate)));
}

function referenceCoverageProblems(reference = REFERENCE) {
  if (!reference || typeof reference !== "object" || Array.isArray(reference))
    return ["measured full-mix reference is missing"];
  const problems = [];
  const expected = referenceExpectedCases();
  const expectedSorted = expected.slice().sort();
  if (reference.schemaVersion !== 2 || reference.scope !== "fixture" ||
      reference.analysisVersion !== ANALYSIS_VERSION || !["complete", "incomplete"].includes(reference.status))
    problems.push("reference schema, scope, analysis version, or status is missing/mismatched");
  if (reference.methodSha256 !== FIXTURES[0].methodSha256 || reference.toleranceSha256 !== FIXTURES[0].toleranceSha256)
    problems.push("reference method/tolerance hashes are missing or stale");
  if (!reference.tolerances || reference.referenceToleranceSha256 !== sha256(Buffer.from(canonical(reference.tolerances))))
    problems.push("reference tolerance policy hash does not bind its threshold values");
  const coverage = reference.coverage;
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage) ||
      !Array.isArray(coverage.expectedCases) || !Array.isArray(coverage.measuredCases) || !Array.isArray(coverage.incompleteCases)) {
    problems.push("reference exact coverage manifest is missing");
    return problems;
  }
  const recordedExpected = coverage.expectedCases.slice().sort();
  if (JSON.stringify(recordedExpected) !== JSON.stringify(expectedSorted))
    problems.push("reference expected case manifest differs from the required engine/fixture/rate Cartesian set");
  const measured = new Set(), incomplete = new Map();
  for (const key of coverage.measuredCases) {
    if (typeof key !== "string" || measured.has(key)) problems.push("reference measured case IDs contain malformed or duplicate values");
    else measured.add(key);
  }
  for (const row of coverage.incompleteCases) {
    if (!row || typeof row.id !== "string" || typeof row.reason !== "string" || !row.reason ||
        !["fail", "incomplete"].includes(row.firstAttemptStatus) || incomplete.has(row.id))
      problems.push("reference incomplete case rows need unique IDs, first-attempt status, and explicit reasons");
    else incomplete.set(row.id, row.reason);
  }
  const actual = new Set();
  for (const engine of ["chromium", "firefox", "webkit"]) for (const fixture of FIXTURES) for (const rate of [44100, 48000]) {
    const key = engine + "/" + fixture.id + "/" + rate;
    const entry = reference.engines && reference.engines[engine] && reference.engines[engine][fixture.id] &&
      reference.engines[engine][fixture.id][rate];
    if (entry !== undefined) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || !entry.metadata ||
          typeof entry.metadata !== "object" || Array.isArray(entry.metadata) ||
          !entry.source || typeof entry.source !== "object" || !entry.source.metrics || !entry.source.capture ||
          !entry.min || typeof entry.min !== "object" || !entry.min.metrics || !entry.min.capture) {
        problems.push("reference case " + key + " must bind metadata and both source/min first-attempt features");
        continue;
      }
      const meta = entry.metadata;
      const bundle = meta.browserBundle;
      const captureToolchain = meta.captureToolchain;
      const captureBundle = captureToolchain && captureToolchain.browserBundle;
      const validBundle = bundle && bundle.engine === engine && browserToolchainSpec.isPinnedBrowserBundle(bundle);
      const captureToolchainMatchesBundle = captureToolchain && captureToolchain.schemaVersion === 1 &&
        captureToolchain.playwrightCoreVersion === bundle?.playwrightCoreVersion &&
        captureToolchain.browsersManifestSha256 === bundle?.browsersManifestSha256 &&
        canonical(captureBundle) === canonical(bundle);
      const directToolchain = captureToolchain && captureToolchain.source === "recorded-in-capture-matrixRun-browserToolchain" &&
        meta.captureRun && meta.captureRun.browserToolchain &&
        meta.captureRun.browserToolchain.playwrightCoreVersion === captureToolchain.playwrightCoreVersion &&
        meta.captureRun.browserToolchain.browsersManifestSha256 === captureToolchain.browsersManifestSha256 &&
        meta.captureRun.browserToolchain.browsers && meta.captureRun.browserToolchain.browsers[engine] &&
        meta.captureRun.browserToolchain.browsers[engine].identitySha256 === bundle?.identitySha256 &&
        typeof meta.captureRun.browserToolchain.identitySha256 === "string" &&
        sha256(Buffer.from(canonical(Object.fromEntries(Object.entries(meta.captureRun.browserToolchain)
          .filter(([key]) => key !== "identitySha256"))))) === meta.captureRun.browserToolchain.identitySha256;
      const historicalToolchain = captureToolchain &&
        captureToolchain.source === "reconstructed-from-retained-v5-pinned-runner-toolchain" &&
        typeof captureToolchain.limitation === "string" && !meta.captureRun?.browserToolchain;
      const validCaptureToolchain = captureToolchainMatchesBundle && (directToolchain || historicalToolchain);
      if (meta.scope !== "fixture" || meta.fixtureId !== fixture.id || meta.profileKind !== fixture.profileKind ||
          meta.engine !== engine || !meta.browserVersion || !meta.platform || meta.sampleRate !== rate || meta.quality !== 1 ||
          meta.seed !== MATRIX.seed || meta.captureRun?.selection?.seed !== MATRIX.seed ||
          !validBundle || !browserToolchainSpec.matchesBrowserVersion(bundle, meta.browserVersion) || !validCaptureToolchain ||
          meta.midiSha256 !== fixture.midiSha256 || meta.setupSha256 !== fixture.setupSha256 ||
          meta.settingsSha256 !== fixture.settingsSha256 || meta.probePlanSha256 !== fixture.probePlanSha256 ||
          meta.methodSha256 !== fixture.methodSha256 || meta.toleranceSha256 !== fixture.toleranceSha256 ||
          meta.playbackOriginSec !== ORIGIN || !meta.captureRun || typeof meta.captureRun !== "object" ||
          typeof meta.captureRun.runId !== "string" || !meta.captureRun.runId ||
          typeof meta.captureRun.runAttempt !== "string" || !meta.captureRun.runAttempt ||
          typeof meta.captureRun.workflowRef !== "string" || !meta.captureRun.workflowRef ||
          typeof meta.captureRun.eventName !== "string" || !meta.captureRun.eventName ||
          typeof meta.captureRun.testedSha !== "string" || !/^[a-f0-9]{40}$/i.test(meta.captureRun.testedSha) ||
          typeof meta.captureRun.matrixConfigSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(meta.captureRun.matrixConfigSha256) ||
          !meta.captureRun.selection || !Array.isArray(meta.captureRun.selection.specs) ||
          !meta.captureRun.selection.specs.includes("full-mix") ||
          !meta.captureRun.buildSha256 || typeof meta.captureRun.buildSha256.source !== "string" ||
          !/^[a-f0-9]{64}$/i.test(meta.captureRun.buildSha256.source) ||
          typeof meta.captureRun.buildSha256.min !== "string" || !/^[a-f0-9]{64}$/i.test(meta.captureRun.buildSha256.min) ||
          typeof meta.captureReportSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(meta.captureReportSha256) ||
          typeof meta.captureMethodSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(meta.captureMethodSha256) ||
          typeof meta.captureToleranceSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(meta.captureToleranceSha256) ||
          meta.captureMethodSha256 !== fixture.methodSha256 || meta.captureToleranceSha256 !== fixture.toleranceSha256)
        problems.push("reference case " + key + " input, engine, version, method or historical capture identity is malformed");
      for (const build of ["source", "min"]) {
        const capture = entry[build].capture;
        if (!capture || typeof capture.path !== "string" || !capture.path ||
            capture.path.includes("..") || !capture.path.startsWith(engine + "/full-mix/") ||
            typeof capture.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(capture.sha256) ||
            typeof capture.pcmSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(capture.pcmSha256) ||
            !Number.isSafeInteger(capture.bytes) || capture.bytes < 52 || capture.sampleRate !== rate ||
            !Number.isSafeInteger(capture.frames) || capture.frames !== Math.ceil(FIXTURE_BY_ID[fixture.id].renderDurationSec * rate) ||
            capture.bytes !== 44 + capture.frames * 8 || capture.attempt !== 1 ||
            capture.firstAttempt !== true || capture.eligible !== true || capture.finite !== true ||
            capture.overFullScaleSamples !== 0 || typeof capture.priorCaptureVerdict !== "string" ||
            !["incomplete", "pass"].includes(capture.priorCaptureVerdict) ||
            capture.captureMethodSha256 !== meta.captureMethodSha256 || capture.captureMethodSha256 !== fixture.methodSha256)
          problems.push("reference case " + key + " " + build + " lacks eligible first-attempt raw capture provenance");
      }
      actual.add(key);
    }
  }
  for (const engine of Object.keys(reference.engines || {})) {
    if (!["chromium", "firefox", "webkit"].includes(engine)) problems.push("reference contains undeclared engine " + engine);
    const byFixture = reference.engines[engine];
    for (const fixtureId of Object.keys(byFixture || {})) {
      if (!FIXTURE_BY_ID[fixtureId]) problems.push("reference contains undeclared fixture " + fixtureId);
      const byRate = byFixture[fixtureId];
      for (const rate of Object.keys(byRate || {})) if (!["44100", "48000"].includes(rate))
        problems.push("reference contains undeclared sample rate " + rate);
    }
  }
  const allListed = [...measured, ...incomplete.keys()].sort();
  if (JSON.stringify([...measured].sort()) !== JSON.stringify([...actual].sort()))
    problems.push("reference measured-case manifest differs from available source/min feature rows");
  if (JSON.stringify(allListed) !== JSON.stringify(expectedSorted))
    problems.push("reference must classify every required case exactly once as measured or incomplete");
  for (const key of expectedSorted) {
    if (measured.has(key) === incomplete.has(key))
      problems.push("reference case " + key + " is missing or classified as both measured and incomplete");
  }
  if (reference.status !== "complete" || incomplete.size !== 0 || actual.size !== expected.length)
    problems.push("measured full-mix reference is incomplete (" + actual.size + "/" + expected.length + " engine/fixture/rate cases)");
  return problems;
}

function profileForCase(fixture, sampleRate) {
  return {
    fixtureId: fixture.id, profileKind: fixture.profileKind, sampleRate, quality: 1,
    seed: MATRIX.seed,
    masterVol: fixture.settings.masterVol, reverbLev: fixture.settings.reverbLev,
    liveVoices: fixture.liveVoices, offlineVoices: fixture.offlineVoices,
    playbackOriginSec: ORIGIN, songEndSec: fixture.songEndSec, renderDurationSec: fixture.renderDurationSec,
    setupSha256: fixture.setupSha256, midiSha256: fixture.midiSha256,
    downbeat: fixture.downbeat, methodSha256: fixture.methodSha256, toleranceSha256: fixture.toleranceSha256,
    probePlanSha256: fixture.probePlanSha256, settingsSha256: fixture.settingsSha256,
  };
}

async function renderOne(t, build, options, fixture, sampleRate, matrix) {
  const page = await t.newPage({ offline: true });
  await page.page.setContent(pages.inlinePage({
    library: pages.readLibrary(build, options.overrides), seed: options.seed,
    after: [pages.pageScript("full-mix.js")],
  }));
  const input = {
    seed: options.seed, midiBase64: fixture.midi.toString("base64"), sampleRate, quality: 1,
    masterVol: fixture.settings.masterVol, reverbLev: fixture.settings.reverbLev,
    offlineVoices: fixture.offlineVoices, renderDurationSec: fixture.renderDurationSec,
    playbackOriginSec: ORIGIN, probes: fixture.probes.map((p) => ({
      id: p.id, channel: p.channel, program: p.program, pitch: p.pitch, velocity: p.velocity,
      startSec: p.startSec, durationSec: PROBE_DURATION,
    })),
    waves: fixture.waves, timbres: fixture.timbres,
  };
  const firstAttempt = await page.page.evaluate((o) => window.__t6FullMix(o), input); // eslint-disable-line no-undef -- page callback
  const channels = firstAttempt.pcm.map(decode);
  const metrics = analyzeChannels(channels, sampleRate, fixture);
  const voices = matchVoiceCreations(fixture, firstAttempt.noteCreations, firstAttempt.prunedInstances, sampleRate);
  const probeVoices = matchProbeCreations(fixture, firstAttempt.noteCreations, firstAttempt.prunedInstances, sampleRate);
  const nonFinite = channels.map(A.nonFinite);
  const pcmHashes = channels.map((x) => A.sha256(x));
  const rawWav = A.wav(channels, sampleRate);
  const identity = {
    scope: "fixture", fixtureId: fixture.id, profileKind: fixture.profileKind, quality: 1,
    engine: t.engine, browserVersion: t.version, platform: t.shared && t.shared.platform,
    sampleRate, seed: options.seed, browserBundle: t.shared && t.shared.browserBundle,
    midiSha256: fixture.midiSha256, setupSha256: fixture.setupSha256,
    settingsSha256: fixture.settingsSha256, probePlanSha256: fixture.probePlanSha256,
    methodSha256: fixture.methodSha256, toleranceSha256: fixture.toleranceSha256,
    playbackOriginSec: ORIGIN,
  };
  const selected = selectReference(REFERENCE, identity, build);
  const reference = selected.reference;
  const comparisonProblems = selected.status === "measured"
    ? compareBuildToReference(metrics, reference.metrics, REFERENCE.tolerances)
    : selected.problems;
  return {
    page, firstAttempt, channels, metrics, voices, probeVoices, nonFinite, pcmHashes, rawWav, reference,
    referenceStatus: selected.status, comparisonProblems, sampleRate, engine: t.engine, version: t.version, build, matrix,
  };
}

function caseRecord(result, attempt, t, fixture, sampleRate) {
  const rel = "full-mix/" + fixture.id + "-q1-" + sampleRate + "-" + result.build + "-" + attempt + ".wav";
  const saved = t.save(rel, result.rawWav);
  return {
    path: rel, saved: !!saved, sha256: sha256(result.rawWav), pcmSha256: sha256(Buffer.concat(result.channels.map((x) => Buffer.from(x.buffer, x.byteOffset, x.byteLength)))),
    bytes: result.rawWav.byteLength, sampleRate, channels: 2, encoding: "WAVE_FORMAT_IEEE_FLOAT",
  };
}

function cases(shared) {
  const { matrix, options, engine, version, platform, browserBundle } = shared;
  const out = [];
  for (const fixture of FIXTURES) for (const sampleRate of matrix.sampleRates) {
    const profile = profileForCase(fixture, sampleRate);
    out.push({
      id: "full-mix " + fixture.id + " q1 " + sampleRate,
      dims: { fixtureId: fixture.id, profileKind: fixture.profileKind, quality: 1, sampleRate,
        masterVol: profile.masterVol, reverbLev: profile.reverbLev },
      deadline: 1200,
      run: async (t) => {
        const builds = {}, pcm = {};
        for (const build of matrix.builds) {
          const first = await renderOne(t, build, options, fixture, sampleRate, matrix);
          pcm[build] = first.channels;
          const firstArtifact = caseRecord(first, "first", t, fixture, sampleRate);
          const finiteBoth = first.nonFinite.every((x) => x.nan === 0 && x.inf === 0) &&
            Object.values(first.metrics.channels).every((x) => x.finite);
          const fullScale = first.metrics.overall.overFullScaleSamples === 0 && first.metrics.overall.peak <= 1 &&
            Object.values(first.metrics.channels).every((x) => x.fullRenderPeak <= 1);
          const exactVoices = first.voices.complete;
          const exactProbeVoices = first.probeVoices.complete;
          const probeComplete = first.metrics.probes.every((x) => x.status === "measured");
          const separation = first.metrics.isolation.length === fixture.probes.length &&
            first.metrics.isolation.every((x) => Number.isFinite(x.preProbeRms) && x.preProbeRms <= 1e-5);
          const pageClean = first.firstAttempt.intervalCount === 1 && first.firstAttempt.rejections.length === 0 &&
            first.page.pageErrors.length === 0 && first.page.aborted.length === 0;
          const timingComplete = fixture.timingComplete;
          const fault = faultSensitivity(first.channels, sampleRate, fixture, first.metrics, first.voices);
          const pinnedSeed = options.seed === MATRIX.seed;
          const preBaselineEligible = finiteBoth && fullScale && exactVoices && exactProbeVoices && probeComplete && separation && pageClean &&
            timingComplete && fault.checksPass && firstArtifact.saved && pinnedSeed;
          const comparison = first.comparisonProblems.length === 0;
          const firstResult = !preBaselineEligible ? "fail"
            : first.referenceStatus !== "measured" ? "incomplete"
              : comparison ? "pass" : "fail";
          const detail = JSON.stringify({
            finite: first.nonFinite, fullRenderPeak: first.metrics.overall.peak,
            voices: { expected: first.voices.expectedCount, created: first.voices.createdCount,
              pruned: first.voices.prunedInstances.length, extras: first.voices.extras.length },
            downbeat: first.metrics.downbeat,
            probes: first.metrics.probes.map((p) => ({ id: p.id, status: p.status, pitchCents: p.pitchCents,
              spectralPeakToGlobalDb: p.spectralPeakToGlobalDb, toneFractionDb: p.toneFractionDb, levelRms: p.levelRms })),
            firstAttemptComparisons: first.comparisonProblems.slice(0, 6), faults: fault,
          });
          t.check(build + " first attempt captured finite Float32 samples in both raw channels", finiteBoth, detail);
          t.check(build + " first attempt stayed within full scale before WAV encoding", fullScale, detail);
          t.check(build + " every independent MIDI note-on created native sources without early pruning", exactVoices,
            JSON.stringify({ missing: first.voices.rows.filter((x) => x.status !== "created").slice(0, 5), pruned: first.voices.prunedInstances.slice(0, 5) }));
          t.check(build + " both post-song probe notes created native sources without pruning", exactProbeVoices,
            JSON.stringify(first.probeVoices.rows));
          t.check(build + " selected pitched durations/pairings are complete", timingComplete,
            "unknown pitched durations or ambiguous repeated-key note-offs are incomplete");
          t.check(build + " post-song isolated fixture pitch/envelope probes are confident and quiet-separated", probeComplete && separation, detail);
          t.check(build + " actual mixed-bus downbeat and isolated relative-level fault sensitivities reject injected faults", fault.checksPass, detail);
          t.check(build + " first attempt completed without scheduler, rejection, page error or network request", pageClean,
            "intervals=" + first.firstAttempt.intervalCount + ", rejections=" + JSON.stringify(first.firstAttempt.rejections) +
              ", pageErrors=" + JSON.stringify(first.page.pageErrors.slice(0, 2)) + ", aborted=" + JSON.stringify(first.page.aborted.slice(0, 2)));
          t.check(build + " first attempt is eligible for native reference capture before comparison", preBaselineEligible,
            "a diagnostic repeat cannot replace this first capture");
          t.check(build + " first attempt used the pinned matrix seed", pinnedSeed,
            JSON.stringify({ actualSeed: options.seed, expectedSeed: MATRIX.seed }));
          t.check(build + " first attempt agrees with measured engine/build song and probe reference", comparison,
            JSON.stringify({ status: first.reference ? "compared" : "incomplete-no-reference", problems: first.comparisonProblems.slice(0, 8) }));

          /* One fresh-page repeat is evidence for variability only; it never promotes/fails attempt 1. */
          let diagnosticRepeat = {
            attempt: 2, role: "diagnostic-only", result: "incomplete", firstVerdict: firstResult,
            neverPromotesFirstAttempt: true,
          };
          try {
            const repeat = await renderOne(t, build, options, fixture, sampleRate, matrix);
            const repeatArtifact = caseRecord(repeat, "diagnostic-repeat", t, fixture, sampleRate);
            const repeatDiff = sameEnginePcm(first.channels, repeat.channels, engine);
            diagnosticRepeat = {
              attempt: 2, role: "diagnostic-only", result: "captured", artifact: repeatArtifact,
              metrics: repeat.metrics, noteInstances: repeat.voices, sameEnginePcm: repeatDiff,
              firstVerdict: firstResult, neverPromotesFirstAttempt: true,
            };
            t.note(build + " diagnostic repeat max |diff|=" + repeatDiff.maxDiff.toExponential(3) +
              " (tolerance " + repeatDiff.tolerance + "; first verdict remains " + diagnosticRepeat.firstVerdict + ")");
          } catch (e) {
            diagnosticRepeat.error = String(e && e.message || e).split("\n")[0];
            diagnosticRepeat.firstVerdict = firstResult;
            t.note(build + " diagnostic repeat incomplete: " + diagnosticRepeat.error + "; first verdict remains " + diagnosticRepeat.firstVerdict);
          }
          builds[build] = {
            attempt: 1, firstAttempt: true, result: firstResult,
            preBaselineEligible, metrics: first.metrics, noteInstances: first.voices, probeInstances: first.probeVoices,
            artifact: firstArtifact,
            pageErrors: first.page.pageErrors, aborted: first.page.aborted,
            midiMessagesSent: first.firstAttempt.midiMessagesSent, parsedEventCount: first.firstAttempt.eventCount,
            intervalCount: first.firstAttempt.intervalCount, rejections: first.firstAttempt.rejections,
            pcmSha256: first.pcmHashes, diagnosticRepeat, faultSensitivity: fault,
            referenceStatus: first.referenceStatus, comparisonProblems: first.comparisonProblems,
          };
        }
        const sourceMin = sameEnginePcm(pcm.source, pcm.min, engine);
        builds.source.sourceMinPcmComparison = sourceMin;
        builds.min.sourceMinPcmComparison = sourceMin;
        if (!sourceMin.ok) {
          builds.source.result = "fail";
          builds.min.result = "fail";
          builds.source.preBaselineEligible = false;
          builds.min.preBaselineEligible = false;
          for (const row of [builds.source, builds.min])
            if (row.diagnosticRepeat) row.diagnosticRepeat.firstVerdict = "fail";
        }
        t.check("source and fresh-min first-attempt raw PCM match without alignment", sourceMin.ok,
          "max |diff|=" + sourceMin.maxDiff.toExponential(3) + " at sample " + sourceMin.firstDifferingSample +
            " (<= " + sourceMin.tolerance + "; first attempt only)");
        const derivedStatus = deriveFullMixStatus(builds, sourceMin.ok);
        const referenceState = referenceProvenance();
        const observation = {
          schemaVersion: 2, scope: "fixture", qualification: "fixture-only-no-production-approval",
          fixtureId: fixture.id, profileKind: fixture.profileKind, label: fixture.label,
          sampleRate, quality: 1, seed: options.seed, engine, browserVersion: version, platform, browserBundle,
          midiSha256: fixture.midiSha256, setupSha256: fixture.setupSha256,
          settingsSha256: fixture.settingsSha256, probePlanSha256: fixture.probePlanSha256,
          methodSha256: fixture.methodSha256, toleranceSha256: fixture.toleranceSha256,
          referenceProvenance: referenceState,
          referenceToleranceSha256: referenceState.referenceToleranceSha256,
          masterVol: profile.masterVol, reverbLev: profile.reverbLev, playbackOriginSec: ORIGIN,
          songEndSec: fixture.songEndSec, durationSec: fixture.renderDurationSec,
          input: { midiPath: fixture.id === "tinychip-ws-mid" ? "tests/fixtures/consumer/waves-song.mid" : "ws.mid",
            setupProvenance: fixture.setupProvenance, noteCount: fixture.notes.length },
          noteTiming: { complete: fixture.timingComplete, unmatchedNoteOffs: fixture.unmatchedNoteOffs,
            unpitchedOneShotCount: fixture.unpitchedOneShotCount,
            ambiguousPairings: fixture.notes.filter((n) => n.pairingAmbiguous).length,
            durationUnknown: fixture.notes.filter((n) => n.durationSec === null).length,
            overlapWindowClaims: "mixed-bus features only; not proof each voice sounded" },
          voiceDemand: {
            noteOnCount: fixture.notes.length, maxKnownSimultaneousNotes: fixture.maxKnownSimultaneous,
            liveBudget: fixture.liveVoices, offlineCeiling: fixture.offlineVoices,
            offlineCeilingDerivation: "all independently parsed fixture note-ons (including drums) + two appended probe note-ons + one spare; not the live/realtime budget",
          },
          isolatedProbeContract: {
            channels: PROBE_CHANNELS, startsAfterSongAndTail: true,
            probes: fixture.probes.map(({ id, program, pitch, expectedPitch, velocity, startSec, attackSec, patchNote }) =>
              ({ id, program, pitch, expectedPitch, velocity, startSec, attackSec, patchNote })),
            relativeLevelScope: "isolated fixture-timbre level comparison through the common output graph; not musical-part balance or composer approval",
            quietWindows: builds.source.metrics.isolation,
          },
          setupProvenance: fixture.setupProvenance,
          firstAttempt: true, captureEligiblePreBaseline: derivedStatus.captureEligiblePreBaseline,
          status: derivedStatus.status,
          builds, sourceMinPcmComparison: sourceMin,
          fullMix: builds.source.metrics,
          rawArtifacts: Object.fromEntries(matrix.builds.map((b) => [b, builds[b].artifact])),
          faultSensitivity: builds.source.faultSensitivity,
          incompleteCriteria: [
            ...(!fixture.timingComplete ? ["some pitched note durations/pairings are unknown or ambiguous"] : []),
            "no production song identity or composer approval is represented by these regression fixtures",
            "native Linux browser evidence does not cover physical devices",
            "musical-part balance remains incomplete; relative probes compare isolated fixture timbres only",
          ],
        };
        t.observe("fullMix", observation);
      },
    });
  }
  return out;
}

function expectedCases() {
  return FIXTURES.flatMap((fixture) => [44100, 48000].map((sampleRate) => ({
    id: "full-mix " + fixture.id + " q1 " + sampleRate,
    dims: { fixtureId: fixture.id, profileKind: fixture.profileKind, quality: 1, sampleRate,
      masterVol: fixture.settings.masterVol, reverbLev: fixture.settings.reverbLev },
    fixtureId: fixture.id, sampleRate, profileKind: fixture.profileKind,
    expectedNoteIds: fixture.notes.map((n) => n.id),
    expectedPitchProbeIds: fixture.probes.map((p) => p.id),
    midiSha256: fixture.midiSha256, setupSha256: fixture.setupSha256,
    settingsSha256: fixture.settingsSha256, probePlanSha256: fixture.probePlanSha256,
    methodSha256: fixture.methodSha256, toleranceSha256: fixture.toleranceSha256,
    downbeatNoteId: fixture.downbeat.noteId, downbeatExpectedPitch: fixture.downbeat.expectedPitch,
    setupProvenance: fixture.setupProvenance,
  })));
}

module.exports = {
  cases, expectedCases, FIXTURES, FIXTURE_BY_ID, noteManifest, analyzeChannels, renderOne, caseRecord,
  selectReference, deriveFullMixStatus, referenceProvenance,
  compareBuildToReference, referenceShapeProblems, referenceExpectedCases, referenceCoverageProblems,
  matchVoiceCreations, matchProbeCreations,
  sameEnginePcm, relativeProbeFault, zeroDownbeatWindow, faultSensitivity,
  WINDOW_SEC, ORIGIN, REVERB_TAIL, ANALYSIS_VERSION, REFERENCE, REFERENCE_FILE,
  analyzeProbe, PROBE_PITCH_LIMIT_CENTS, PROBE_CHANNELS,
};
