#!/usr/bin/env node
/*
 * Bounded first-attempt reducer for #91. Each trial uses a fresh, terminating
 * OfflineAudioContext. It never retries a render; the first result is the
 * comparison reference and every later result is retained as a hash, with PCM
 * included for the first result and each discrepant result.
 *
 * Example (run inside the pinned browser environment):
 *   node scripts/run-with-deadline.js 180 node scripts/noise-path-reducer.js \
 *     --engine=webkit --library=source --graph=library --scenario=gm-noise --sr=44100 \
 *     --n=128 --variant=baseline --evidence-root=/path/to/evidence \
 *     --out=/path/to/evidence/source-q0-126-44100.jsonl
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const analysis = require("./noise-path-analysis");
const testBuild = require("./test-build");

const ROOT = path.resolve(__dirname, "..");
const FIXTURE = path.join(ROOT, "tests/fixtures/consumer/waves-setup.json");
const SONG = path.join(ROOT, "tests/fixtures/consumer/waves-song.mid");
const VARIANTS = new Set([
  "baseline", "no-scheduler", "no-warmup", "no-lfo", "no-detune",
  "no-panner", "no-compressor", "copy-fill",
]);
const ENGINES = new Set(["webkit", "chromium", "firefox"]);
const GRAPHS = new Set([
  "library", "manual-chain", "manual-no-compressor", "manual-no-compressor-no-detune-connection",
  "manual-no-panner", "manual-direct",
]);

function fail(message) {
  console.error("FAIL: " + message);
  process.exit(2);
}

function argsOf(argv) {
  const args = {};
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (!match) fail("expected --name=value, got " + arg);
    if (Object.prototype.hasOwnProperty.call(args, match[1])) fail("duplicate option --" + match[1]);
    args[match[1]] = match[2];
  }
  return args;
}

function int(value, name, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) fail(name + " must be an integer from " + min + " to " + max);
  return n;
}

function finite(value, name, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) fail(name + " must be a finite number from " + min + " to " + max);
  return n;
}

function boolean(value, name, defaultValue) {
  if (value === undefined) return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  fail(name + " must be true or false");
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function fingerprint(bytes) {
  return sha256(bytes);
}

function parseOptions() {
  const raw = argsOf(process.argv.slice(2));
  const allowed = new Set([
    "engine", "library", "graph", "scenario", "sr", "quality", "program", "note",
    "n", "batch-size", "duration", "start", "hold", "loop", "variant", "instrument-scheduler", "out", "evidence-root",
  ]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) fail("unknown option --" + key);

  const sampleRate = int(raw.sr || "44100", "sr", 44100, 48000);
  if (sampleRate !== 44100 && sampleRate !== 48000) fail("sr must be exactly 44100 or 48000");
  const config = {
    engine: raw.engine || "webkit",
    library: raw.library || "source",
    graph: raw.graph || "library",
    scenario: raw.scenario || "gm-noise",
    sr: sampleRate,
    quality: int(raw.quality || (raw.scenario === "tinychip-bass" ? "1" : "0"), "quality", 0, 1),
    program: int(raw.program || (raw.scenario === "tinychip-bass" ? "20" : "126"), "program", 0, 127),
    note: int(raw.note || (raw.scenario === "tinychip-bass" ? "45" : "60"), "note", 0, 127),
    n: int(raw.n || "128", "n", 1, 6000),
    batchSize: int(raw["batch-size"] || "32", "batch-size", 1, 32),
    duration: finite(raw.duration || (raw.scenario === "tinychip-bass" ? "2.6" : "0.5"), "duration", 0.1, 10),
    start: finite(raw.start || "0.05", "start", 0, 1),
    hold: finite(raw.hold || (raw.scenario === "tinychip-bass" ? "2.25" : "0.07"), "hold", 0, 8),
    loop: boolean(raw.loop, "loop", true),
    variant: raw.variant || "baseline",
    instrumentScheduler: raw["instrument-scheduler"] === "true",
    out: raw.out,
  };
  if (!ENGINES.has(config.engine)) fail("engine must be webkit, chromium, or firefox");
  if (config.library !== "source" && config.library !== "min") fail("library must be source or min");
  if (!GRAPHS.has(config.graph)) fail("graph must be " + [...GRAPHS].join(", "));
  if (raw.loop !== undefined && config.graph === "library") fail("loop is supported only by manual graphs");
  if (config.scenario !== "gm-noise" && config.scenario !== "tinychip-bass") fail("scenario must be gm-noise or tinychip-bass");
  if (!VARIANTS.has(config.variant)) fail("unknown variant " + config.variant);
  if (config.graph !== "library" && config.scenario !== "gm-noise") fail("manual graph currently supports gm-noise only");
  if (config.graph !== "library" && config.variant !== "baseline") fail("graph reductions and library variants are run separately");
  if (config.variant === "copy-fill" && config.library !== "source") fail("copy-fill requires --library=source; it applies an in-memory source transform");
  if (raw["instrument-scheduler"] !== undefined && raw["instrument-scheduler"] !== "true" && raw["instrument-scheduler"] !== "false")
    fail("instrument-scheduler must be true or false");
  if (config.instrumentScheduler && (config.graph !== "library" || config.scenario !== "gm-noise" || config.variant !== "baseline"))
    fail("scheduler instrumentation requires the baseline library gm-noise graph");
  if (!config.out || !path.isAbsolute(config.out)) fail("--out must be an absolute path to a .jsonl file");
  const out = path.resolve(config.out);
  if (path.extname(out) !== ".jsonl") fail("--out must have a .jsonl extension");
  if (raw["evidence-root"]) {
    const evidenceRoot = path.resolve(raw["evidence-root"]);
    if (!path.isAbsolute(raw["evidence-root"]) || !out.startsWith(evidenceRoot + path.sep))
      fail("--out must be inside the supplied --evidence-root");
  }
  if (config.start + config.hold > config.duration) fail("start + hold must not exceed duration");
  return Object.assign(config, { out });
}

function copyFillVariant(source) {
  const from = [
    "      const dn=this.noiseBuf.n0.getChannelData(0),g=rnd(1);",
    "      for(let i=0;i<blen;++i)",
    "        dn[i]=g()*2-1;",
  ].join("\n");
  const to = [
    "      const dn=new Float32Array(blen),g=rnd(1);",
    "      for(let i=0;i<blen;++i)",
    "        dn[i]=g()*2-1;",
    "      this.noiseBuf.n0.copyToChannel(dn,0);",
  ].join("\n");
  if (source.split(from).length !== 2) fail("copy-fill transform did not match exactly once");
  return source.replace(from, to);
}

function makeTinyChipScenario(source) {
  const fixtureBytes = fs.readFileSync(FIXTURE);
  const fixture = JSON.parse(fixtureBytes.toString("utf8"));
  const timbre = fixture.timbres.find((item) => !item.drum && item.slot === 20);
  if (!timbre) fail("TinyChip fixture has no bass program 20");
  const sampleOperator = timbre.operators.find((operator) => typeof operator.w === "string" && operator.w.startsWith("n"));
  if (!sampleOperator) fail("TinyChip bass program 20 has no looped sample operator");
  const wave = fixture.waves.find((item) => item.name === sampleOperator.w && Array.isArray(item.samples));
  if (!wave) fail("TinyChip fixture has no inline samples for " + sampleOperator.w);

  const harness = require("../tests/harness");
  const parser = harness.createSynth(source, "noise-path-score-probe").synth;
  parser.loadMIDI(harness.toArrayBuffer(fs.readFileSync(SONG)));
  const noteOn = parser.song.ev.find((event) => event.m && event.m[0] === 0x91 && event.m[2] > 0);
  if (!noteOn) fail("TinyChip score has no first bass-channel note-on");
  const noteOff = parser.song.ev.find((event) => event.m && event.m[0] === 0x81 && event.m[1] === noteOn.m[1] && event.t > noteOn.t);
  if (!noteOff) fail("TinyChip score has no matching bass-channel note-off");
  const hold = (noteOff.t - noteOn.t) * 60 / (fixture.song.bpm * fixture.song.ppq);
  const waveBytes = Buffer.from(new Float32Array(wave.samples).buffer);
  return {
    fixtureSha256: sha256(fixtureBytes),
    songSha256: sha256(fs.readFileSync(SONG)),
    fixtureCommit: fixture.provenance.tinychip.commit,
    consumerCommit: fixture.provenance.consumer.commit,
    programName: timbre.name,
    program: timbre.slot,
    operators: timbre.operators,
    wave: { name: wave.name, samples: wave.samples },
    waveSha256: sha256(waveBytes),
    channel: 0,
    note: noteOn.m[1],
    velocity: noteOn.m[2],
    startTick: noteOn.t,
    noteOffTick: noteOff.t,
    hold,
    duration: hold + 0.35,
  };
}

function makeManualNoiseScenario(source, quality, program) {
  if (quality !== 0) fail("manual graph currently supports quality 0 built-in noise timbres only");
  const harness = require("../tests/harness");
  const synth = harness.createSynth(source, "noise-path-manual-timbre").synth;
  synth.setQuality(quality);
  const operators = synth.program[program].p.map((operator) => Object.assign({}, operator));
  const noise = operators.filter((operator) => typeof operator.w === "string" && operator.w.startsWith("n"));
  if (operators.length !== 1 || noise.length !== 1 || noise[0].w !== "n0" || noise[0].g !== 0)
    fail("manual graph requires one output n0 operator; program " + program + " does not match");
  const graphDefaults = {
    masterGain: synth.out.gain.value,
    channelVolume: synth.vol[0],
    expression: synth.ex[0],
    channelGain: synth.chvol[0].gain.value,
    pan: synth.chpan[0] ? synth.chpan[0].pan.value : 0,
    modulationGain: synth.chmod[0].gain.value,
    bend: synth.bend[0],
    lfoFrequency: synth.lfo.frequency.value,
  };
  const noiseSeed = synth.seed;
  const noiseBufferVersion = synth.bufferVersion;
  synth.dispose();
  return { operators, graphDefaults, noiseSeed, noiseBufferVersion };
}

function worker() {
  const browserWindow = globalThis;
  browserWindow.__runNoisePathBatch = async function (config) {
    const records = [];
    const counts = {};
    let lifecycleEvents = [];
    const summarizeVoice = (note) => ({
      channel: note.ch,
      note: note.n,
      start: note.t,
      scheduledStart: note.s,
      releaseEnd: note.e,
      released: note.f,
      releaseTimes: Array.isArray(note.r) ? note.r.slice() : note.r,
      operators: note.o && note.o.length,
    });
    const currentTime = (synth) => synth && synth.actx ? synth.actx.currentTime : null;
    const wrapLifecycleMethod = (synth, name, snapshots) => {
      const original = synth[name];
      if (typeof original !== "function") return;
      synth[name] = function (...args) {
        const performanceStartMs = performance.now();
        const contextTimeStart = currentTime(this);
        const before = snapshots.before(this, args);
        try {
          return original.apply(this, args);
        } finally {
          lifecycleEvents.push(Object.assign({
            kind: name,
            performanceStartMs,
            performanceEndMs: performance.now(),
            contextTimeStart,
            contextTimeEnd: currentTime(this),
          }, before, snapshots.after(this, args)));
        }
      };
    };
    const instrumentLifecycle = (synth) => {
      wrapLifecycleMethod(synth, "_releaseNote", {
        before: (instance, args) => ({ requestedReleaseTime: args[1], voiceBefore: args[0] ? summarizeVoice(args[0]) : null }),
        after: (instance, args) => ({ voiceAfter: args[0] ? summarizeVoice(args[0]) : null }),
      });
      wrapLifecycleMethod(synth, "_pruneNote", {
        before: (instance, args) => ({ voiceBefore: args[0] ? summarizeVoice(args[0]) : null }),
        after: (instance, args) => ({ voiceAfter: args[0] ? summarizeVoice(args[0]) : null }),
      });
      wrapLifecycleMethod(synth, "_limitVoices", {
        before: (instance, args) => ({
          requestedChannel: args[0],
          requestedNote: args[1],
          voicesBefore: instance.notetab.map(summarizeVoice),
        }),
        after: (instance) => ({ voicesAfter: instance.notetab.map(summarizeVoice) }),
      });
    };
    const instrumentIntervals = () => {
      const originalSetInterval = browserWindow.setInterval;
      const intervalIds = [];
      let activeSynth = null;
      browserWindow.setInterval = function (callback, ...args) {
        const wrapped = function (...callbackArgs) {
          const performanceStartMs = performance.now();
          const contextTimeStart = currentTime(activeSynth);
          const voicesBefore = activeSynth ? activeSynth.notetab.map(summarizeVoice) : [];
          const relcntBefore = activeSynth && activeSynth.relcnt;
          try {
            return callback.apply(this, callbackArgs);
          } finally {
            lifecycleEvents.push({
              kind: "interval-callback",
              delayMs: args[0],
              performanceStartMs,
              performanceEndMs: performance.now(),
              contextTimeStart,
              contextTimeEnd: currentTime(activeSynth),
              offlineFlag: activeSynth && !!activeSynth._off,
              relcntBefore,
              relcntAfter: activeSynth && activeSynth.relcnt,
              voicesBefore,
              voicesAfter: activeSynth ? activeSynth.notetab.map(summarizeVoice) : [],
            });
          }
        };
        const id = originalSetInterval.call(this, wrapped, ...args);
        intervalIds.push(id);
        return id;
      };
      return {
        activate(synth) { activeSynth = synth; },
        restore() { browserWindow.setInterval = originalSetInterval; },
        cleanup() {
          browserWindow.setInterval = originalSetInterval;
          for (const id of intervalIds) clearInterval(id);
        },
      };
    };
    const wrap = (context) => {
      const names = ["createBuffer", "createBufferSource", "createGain", "createOscillator", "createStereoPanner", "createDynamicsCompressor", "createConvolver"];
      for (const name of names) {
        if (typeof context[name] !== "function") continue;
        counts[name] = 0;
        const original = context[name].bind(context);
        try {
          context[name] = (...args) => { ++counts[name]; return original(...args); };
        } catch (error) {
          counts[name + "InstrumentError"] = String(error && error.message || error);
        }
      }
    };
    const hash32 = (bytes) => {
      let a = 0x811c9dc5, b = 0x9e3779b9;
      for (let i = 0; i < bytes.length; ++i) {
        a = Math.imul(a ^ bytes[i], 0x01000193);
        b = Math.imul(b ^ bytes[i], 0x85ebca6b);
      }
      return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
    };
    const b64 = (bytes) => {
      let str = "";
      for (let i = 0; i < bytes.length; i += 0x8000)
        str += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(str);
    };
    const bytesOf = (values) => new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
    const captureBuffer = (buffer) => {
      const samples = buffer.getChannelData(0);
      const bytes = bytesOf(samples);
      return {
        sampleRate: buffer.sampleRate,
        length: buffer.length,
        hash32: hash32(bytes),
        pcm: b64(bytes),
      };
    };
    const captureParamValues = (node, names) => {
      const values = {};
      for (const name of names) values[name] = node && node[name] && Number.isFinite(node[name].value) ? node[name].value : null;
      return values;
    };
    const captureGraphSettings = (synth, channel, manual, extras) => {
      if (manual) return Object.assign({}, config.manualGraphDefaults, extras);
      const pan = synth.chpan[channel];
      return {
        masterGain: synth.out.gain.value,
        channelVolume: synth.vol[channel],
        expression: synth.ex[channel],
        channelGain: synth.chvol[channel].gain.value,
        pan: pan ? pan.pan.value : 0,
        pannerPresent: !!pan,
        modulationGain: synth.chmod[channel].gain.value,
        bend: synth.bend[channel],
        lfoFrequency: synth.lfo.frequency.value,
        compressorPresent: !!synth.comp,
        compressorParameters: captureParamValues(synth.comp, ["threshold", "knee", "ratio", "attack", "release"]),
      };
    };
    const mulberry32 = (state) => () => {
      state = state + 0x6d2b79f5 | 0;
      let value = Math.imul(state ^ state >>> 15, 1 | state);
      value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
      return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
    const makeManualNoiseSource = (context) => {
      const operator = config.manualOperators[0];
      const frames = Math.floor(config.sr * 0.5);
      const buffer = context.createBuffer(1, frames, config.sr);
      const data = buffer.getChannelData(0);
      let seed = config.noiseSeed >>> 0;
      seed = Math.imul(seed ^ seed >>> 16, 0x85ebca6b);
      seed = Math.imul(seed ^ seed >>> 13, 0xc2b2ae35);
      seed ^= seed >>> 16;
      const random = mulberry32(seed + 0x40000000);
      for (let i = 0; i < frames; ++i) data[i] = random() * 2 - 1;

      const frequency = 440 * Math.pow(2, (config.note - 69) / 12);
      const effectiveFrequency = frequency * operator.t + operator.f;
      const playbackRate = effectiveFrequency / 440;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = config.loop;
      source.playbackRate.value = playbackRate;
      if (operator.p !== 1) {
        if (operator.q !== 0) source.playbackRate.setTargetAtTime(playbackRate * operator.p, config.start, operator.q);
        else source.playbackRate.setValueAtTime(playbackRate * operator.p, config.start);
      }
      const operatorGain = context.createGain();
      source.connect(operatorGain);
      const cleanup = [source, operatorGain];
      const modulation = context.createGain();
      modulation.gain.value = config.manualGraphDefaults.modulationGain;
      const lfo = context.createOscillator();
      lfo.frequency.value = config.manualGraphDefaults.lfoFrequency;
      lfo.connect(modulation);
      const modulationToDetuneConnected = config.graph !== "manual-no-compressor-no-detune-connection";
      if (modulationToDetuneConnected) modulation.connect(source.detune);
      source.detune.value = config.manualGraphDefaults.bend;
      lfo.start(0);
      cleanup.push(modulation, lfo);
      let panNode = null, compressorNode = null, channelNode = null, outputGainNode;
      if (config.graph === "manual-direct") {
        const output = context.createGain();
        output.gain.value = config.manualGraphDefaults.channelGain * config.manualGraphDefaults.masterGain;
        outputGainNode = output;
        operatorGain.connect(output);
        output.connect(context.destination);
        cleanup.push(output);
      } else {
        const channel = context.createGain();
        channelNode = channel;
        channel.gain.value = config.manualGraphDefaults.channelGain;
        operatorGain.connect(channel);
        cleanup.push(channel);
        let outputNode = channel;
        if (config.graph !== "manual-no-panner") {
          const pan = context.createStereoPanner();
          panNode = pan;
          pan.pan.value = config.manualGraphDefaults.pan;
          outputNode.connect(pan);
          outputNode = pan;
          cleanup.push(pan);
        }
        const output = context.createGain();
        outputGainNode = output;
        output.gain.value = config.manualGraphDefaults.masterGain;
        outputNode.connect(output);
        cleanup.push(output);
        if (config.graph === "manual-no-compressor" || config.graph === "manual-no-compressor-no-detune-connection")
          output.connect(context.destination);
        else {
          const compressor = context.createDynamicsCompressor();
          compressorNode = compressor;
          output.connect(compressor);
          compressor.connect(context.destination);
          cleanup.push(compressor);
        }
      }

      const level = config.velocity * config.velocity / 16384 * operator.v * Math.pow(2, (config.note - 60) / 12 * operator.k);
      const attackEnd = config.start + operator.a;
      const decayAt = attackEnd + operator.h;
      if (operator.a) {
        operatorGain.gain.setValueAtTime(0, config.start);
        operatorGain.gain.linearRampToValueAtTime(level, attackEnd);
      } else operatorGain.gain.setValueAtTime(level, config.start);
      if (operator.d !== 0) operatorGain.gain.setTargetAtTime(operator.s * level, decayAt, operator.d);
      else operatorGain.gain.setValueAtTime(operator.s * level, decayAt);
      const releaseAt = config.start + config.hold;
      operatorGain.gain.cancelScheduledValues(releaseAt);
      if (releaseAt <= attackEnd) {
        if (operator.a > 0) operatorGain.gain.linearRampToValueAtTime(level * (releaseAt - config.start) / operator.a, releaseAt);
        else operatorGain.gain.setValueAtTime(level, releaseAt);
      }
      if (operator.r !== 0) operatorGain.gain.setTargetAtTime(0, releaseAt, operator.r);
      else operatorGain.gain.setValueAtTime(0, releaseAt);
      source.start(config.start);
      return {
        operator: 0,
        wave: operator.w,
        playbackRate: source.playbackRate.value,
        detune: source.detune && source.detune.value,
        loop: source.loop,
        loopStart: source.loopStart,
        loopEnd: source.loopEnd,
        registeredBufferIdentity: false,
        sourceBufferIdentityMatches: source.buffer === buffer,
        bufferOwnership: "manual local AudioBuffer",
        graphSettings: captureGraphSettings(null, config.channel, true, {
          masterGain: outputGainNode ? outputGainNode.gain.value : null,
          masterGainRequested: config.manualGraphDefaults.masterGain,
          channelGain: channelNode ? channelNode.gain.value : null,
          channelGainRequested: config.manualGraphDefaults.channelGain,
          pan: panNode ? panNode.pan.value : 0,
          modulationGain: modulation.gain.value,
          bend: source.detune.value,
          lfoFrequency: lfo.frequency.value,
          modulationToDetuneConnected,
          pannerPresent: !!panNode,
          compressorPresent: !!compressorNode,
          compressorParameters: captureParamValues(compressorNode, ["threshold", "knee", "ratio", "attack", "release"]),
        }),
        cleanup: { stop: [source, lfo], disconnect: cleanup },
        buffer: captureBuffer(buffer),
      };
    };
    const count = config.count;
    for (let offset = 0; offset < count; ++offset) {
      lifecycleEvents = [];
      for (const name of Object.keys(counts)) counts[name] = 0;
      const trial = config.firstTrial + offset;
      const renderStart = performance.now();
      let context, synth;
      let intervalProbe = null;
      let schedulerContextState = null;
      const manualCleanup = { stop: [], disconnect: [] };
      try {
        const length = Math.ceil(config.duration * config.sr);
        context = new globalThis.OfflineAudioContext(2, length, config.sr);
        wrap(context);
        const sources = [];
        if (config.graph === "library") {
          if (config.instrumentScheduler) intervalProbe = instrumentIntervals();
          synth = new globalThis.WebAudioTinySynth({ quality: config.quality, useReverb: 0, seed: config.noiseSeed, context });
          if (config.instrumentScheduler) {
            intervalProbe.activate(synth);
            intervalProbe.restore();
            instrumentLifecycle(synth);
          }
          if (config.variant === "no-scheduler") clearInterval(synth._tid);
          if (config.variant === "no-detune") synth.chmod[config.channel].connect = function () {};
          if (config.variant === "no-lfo") synth.lfo.disconnect();
          if (config.variant === "no-warmup") {
            synth.notetab.forEach((note) => {
              note.o.forEach((source) => { try { source.stop(0); } catch { /* already stopped */ } source.disconnect(); });
              note.g.forEach((gain) => gain.disconnect());
              (note.q || []).forEach((filter) => filter && filter.disconnect());
            });
            synth.notetab.length = 0;
          }
          if (config.variant === "no-panner") {
            synth.chvol[config.channel].disconnect();
            synth.chvol[config.channel].connect(synth.out);
          }
          if (config.variant === "no-compressor") {
            synth.out.disconnect();
            synth.out.connect(synth.dest);
          }
          if (config.scenario === "tinychip-bass") {
            synth.setQuality(1);
            synth.setSampleWave(config.tinychip.wave.name, config.tinychip.wave.samples);
            synth.setTimbre(0, config.tinychip.program, config.tinychip.operators);
          }
          const graphSettings = captureGraphSettings(synth, config.channel, false);
          synth.setProgram(config.channel, config.program);
          synth.noteOn(config.channel, config.note, config.velocity, config.start);
          synth.noteOff(config.channel, config.note, config.start + config.hold);
          const voice = synth.notetab.slice().reverse().find((note) => note.ch === config.channel && note.n === config.note);
          if (!voice) throw new Error("note-on did not create a melodic voice");
          for (let i = 0; i < voice.o.length; ++i) {
            const source = voice.o[i];
            if (!source || !source.buffer) continue;
            const op = (config.scenario === "tinychip-bass" ? config.tinychip.operators : synth.program[config.program].p)[i];
            const buffer = source.buffer;
            sources.push({
              operator: i,
              wave: op && op.w,
              playbackRate: source.playbackRate && source.playbackRate.value,
              detune: source.detune && source.detune.value,
              loop: source.loop,
              loopStart: source.loopStart,
              loopEnd: source.loopEnd,
              registeredBufferIdentity: buffer === synth.noiseBuf[op && op.w],
              sourceBufferIdentityMatches: source.buffer === buffer,
              bufferOwnership: "synth.noiseBuf[" + String(op && op.w) + "]",
              graphSettings,
              buffer: captureBuffer(buffer),
            });
          }
        } else {
          const manualSource = makeManualNoiseSource(context);
          manualCleanup.stop.push(...manualSource.cleanup.stop);
          manualCleanup.disconnect.push(...manualSource.cleanup.disconnect);
          delete manualSource.cleanup;
          sources.push(manualSource);
        }
        const rendered = await context.startRendering();
        const left = Float32Array.from(rendered.getChannelData(0));
        const right = Float32Array.from(rendered.getChannelData(1));
        if (config.instrumentScheduler) schedulerContextState = {
          offlineFlag: !!synth._off,
          intervalPresent: !!synth._tid,
          contextTimeAtCapture: currentTime(synth),
          voicesAtCapture: synth.notetab.map(summarizeVoice),
        };
        records.push({
          trial,
          state: "rendered",
          renderMs: performance.now() - renderStart,
          effectivePlaybackRates: sources.map((source) => source.playbackRate),
          sources,
          nodes: Object.assign({}, counts),
          schedulerContextState: schedulerContextState || undefined,
          lifecycleEvents: config.instrumentScheduler ? lifecycleEvents.slice() : undefined,
          left: b64(bytesOf(left)),
          right: b64(bytesOf(right)),
        });
        if (synth && synth.dispose) await synth.dispose();
        if (intervalProbe) intervalProbe.cleanup();
        for (const node of manualCleanup.stop) {
          try { node.stop(); } catch { /* rendering has completed; preserve captured PCM */ }
        }
        for (const node of manualCleanup.disconnect) {
          try { node.disconnect(); } catch { /* preserve captured PCM */ }
        }
        synth = null;
        context = null;
      } catch (error) {
        if (config.instrumentScheduler && synth && !schedulerContextState) schedulerContextState = {
          offlineFlag: !!synth._off,
          intervalPresent: !!synth._tid,
          contextTimeAtCapture: currentTime(synth),
          voicesAtCapture: synth.notetab.map(summarizeVoice),
        };
        if (synth && synth.dispose) {
          try { await synth.dispose(); } catch { /* preserve the first error */ }
        }
        if (intervalProbe) intervalProbe.cleanup();
        records.push({
          trial,
          state: "error",
          renderMs: performance.now() - renderStart,
          error: String(error && error.stack || error),
          nodes: Object.assign({}, counts),
          schedulerContextState: schedulerContextState || undefined,
          lifecycleEvents: config.instrumentScheduler ? lifecycleEvents.slice() : undefined,
        });
      }
    }
    return records;
  };
}

async function main() {
  const config = parseOptions();
  const build = await testBuild.prepare({ quiet: true });
  const sourcePath = path.join(ROOT, "webaudio-tinysynth.js");
  const sourceBytes = fs.readFileSync(sourcePath);
  const minBytes = fs.readFileSync(build.min);
  const libraryBytes = config.library === "source" ? sourceBytes : minBytes;
  let library = libraryBytes.toString("utf8");
  if (config.variant === "copy-fill") library = copyFillVariant(library);
  const libraryHash = sha256(Buffer.from(library));
  const tinychip = config.scenario === "tinychip-bass" ? makeTinyChipScenario(sourceBytes.toString("utf8")) : null;
  const manualScenario = config.scenario === "gm-noise"
    ? makeManualNoiseScenario(sourceBytes.toString("utf8"), config.quality, config.program)
    : null;
  const manualOperators = manualScenario && manualScenario.operators;
  const manualGraphDefaults = manualScenario && manualScenario.graphDefaults;
  const scenario = tinychip ? {
    name: "tinychip-bass",
    channel: tinychip.channel,
    program: tinychip.program,
    note: tinychip.note,
    velocity: tinychip.velocity,
    hold: tinychip.hold,
    duration: tinychip.duration,
    tinychip,
  } : {
    name: "gm-noise",
    channel: 0,
    program: config.program,
    note: config.note,
    velocity: 100,
    hold: config.hold,
    duration: config.duration,
  };
  const fullConfig = Object.assign({}, config, scenario, {
    manualOperators,
    manualGraphDefaults,
    noiseSeed: manualScenario ? manualScenario.noiseSeed : 0,
    noiseBufferVersion: manualScenario ? manualScenario.noiseBufferVersion : 1,
  });
  if (fullConfig.start + fullConfig.hold > fullConfig.duration) fail("scenario start + hold exceeds its render duration");

  fs.mkdirSync(path.dirname(config.out), { recursive: true });
  const output = fs.openSync(config.out, "wx");
  const metadata = {
    kind: "metadata",
    createdAt: new Date().toISOString(),
    task: "#91 bounded first-attempt reducer",
    engine: config.engine,
    operatingSystem: process.platform + "/" + process.arch,
    node: process.version,
    playwrightCore: require("playwright-core/package.json").version,
    browserPath: process.env.PLAYWRIGHT_BROWSERS_PATH || null,
    library: config.library,
    graph: config.graph,
    browserLibraryLoaded: config.graph === "library",
    manualGraphTimbreSource: manualOperators ? { source: "quality-0 program table", sourceSha256: sha256(sourceBytes) } : null,
    manualGraphOperators: manualOperators,
    manualGraphDefaults,
    programOperators: manualScenario && manualScenario.operators,
    noiseSeed: fullConfig.noiseSeed,
    noiseBufferVersion: fullConfig.noiseBufferVersion,
    noiseBufferAlgorithm: "fmix32-mulberry32-n0-stream-1",
    noiseBufferSampleRate: config.sr,
    noiseBufferFrames: Math.floor(config.sr * 0.5),
    librarySourceSha256: sha256(sourceBytes),
    librarySourceBytes: sourceBytes.byteLength,
    freshMinPath: path.relative(ROOT, build.min),
    freshMinSha256: sha256(minBytes),
    freshMinBytes: minBytes.byteLength,
    executedLibrarySha256: libraryHash,
    executedLibraryBytes: Buffer.byteLength(library),
    sourceTransform: config.variant === "copy-fill" ? "in-memory n0 generation then AudioBuffer.copyToChannel" : null,
    sampleRate: config.sr,
    quality: config.quality,
    variant: config.variant,
    scenario: scenario.name,
    program: scenario.program,
    note: scenario.note,
    velocity: scenario.velocity,
    start: config.start,
    hold: scenario.hold,
    duration: scenario.duration,
    requestedManualLoop: config.graph === "library" ? null : config.loop,
    attemptsRequested: config.n,
    pageBatchSize: config.batchSize,
    schedulerInstrumentation: config.instrumentScheduler,
    schedulerInstrumentationSemantics: config.instrumentScheduler
      ? "observation wrappers forward original callback/method arguments, receiver, return values and exceptions; records performance.now and OfflineAudioContext.currentTime around timer/lifecycle calls"
      : null,
    noRetry: true,
    reference: "first successfully rendered attempt",
    verdict: "investigation only; disagreement is relative to the first PCM, not an event probability or pass/fail threshold",
    exactZeroCheck: "counts output as exact zero only when every sample is finite and numerically equals 0; positive and negative zero both count; no near-zero audibility, loudness, or perceptual assessment",
    fixtureSha256: tinychip && tinychip.fixtureSha256,
    songSha256: tinychip && tinychip.songSha256,
    fixtureTinyChipCommit: tinychip && tinychip.fixtureCommit,
    fixtureConsumerCommit: tinychip && tinychip.consumerCommit,
    tinyChipProgramName: tinychip && tinychip.programName,
    tinyChipWave: tinychip && tinychip.wave.name,
    tinyChipWaveSha256: tinychip && tinychip.waveSha256,
    scoreStartTick: tinychip && tinychip.startTick,
    scoreNoteOffTick: tinychip && tinychip.noteOffTick,
  };
  fs.writeSync(output, JSON.stringify(metadata) + "\n");

  const playwright = require("playwright-core");
  const browserType = playwright[config.engine];
  let browser;
  let reference = null;
  let rendered = 0, errors = 0, analysisErrors = 0, protocolErrors = 0, differences = 0, nonFiniteAttempts = 0, exactZeroAttempts = 0;
  let nonFiniteOutputSamples = 0, nonFiniteSourceSamples = 0;
  let referenceTrial = null, referenceAnalysis = null, referencePcmHash = null;
  const pcmHashes = new Set(), sourceHashes = new Set(), rates = [];
  const renderTimes = [];
  try {
    browser = await browserType.launch({ headless: true });
    const browserInfo = {
      kind: "browser",
      name: config.engine,
      version: browser.version(),
    };
    fs.writeSync(output, JSON.stringify(browserInfo) + "\n");
    for (let offset = 0; offset < config.n; offset += config.batchSize) {
      const batchCount = Math.min(config.batchSize, config.n - offset);
      const browserContext = await browser.newContext({ serviceWorkers: "block" });
      try {
        let batch;
        try {
          const page = await browserContext.newPage();
          page.setDefaultTimeout(120000);
          await page.setContent("<!doctype html><html><head></head><body></body></html>");
          if (config.graph === "library") await page.addScriptTag({ content: library });
          await page.addScriptTag({ content: "(" + worker.toString() + ")();" });
          batch = await page.evaluate((settings) => globalThis.__runNoisePathBatch(settings), Object.assign({}, fullConfig, {
            firstTrial: offset,
            count: batchCount,
          }));
          if (!Array.isArray(batch)) throw new TypeError("browser batch did not return an array");
        } catch (error) {
          errors += batchCount;
          for (let trial = offset; trial < offset + batchCount; ++trial)
            fs.writeSync(output, JSON.stringify({ kind: "attempt", trial, state: "batch-error", firstAttempt: true, error: String(error && error.stack || error) }) + "\n");
          continue;
        }
        const byTrial = new Map();
        const malformedRecords = [];
        for (const result of batch) {
          if (!result || !Number.isInteger(result.trial) || result.trial < offset || result.trial >= offset + batchCount || byTrial.has(result.trial)) {
            ++protocolErrors;
            malformedRecords.push(result);
            continue;
          }
          byTrial.set(result.trial, result);
        }
        if (malformedRecords.length) {
          fs.writeSync(output, JSON.stringify({
            kind: "batch-diagnostic",
            firstTrial: offset,
            batchCount,
            protocolError: "browser batch contained an invalid or duplicate trial record",
            returnedRecords: batch,
          }) + "\n");
        }
        for (let trial = offset; trial < offset + batchCount; ++trial) {
          const result = byTrial.get(trial);
          if (!result) {
            ++errors;
            fs.writeSync(output, JSON.stringify({ kind: "attempt", trial, state: "batch-error", firstAttempt: true, error: "browser batch omitted this trial" }) + "\n");
            continue;
          }
          if (result.state !== "rendered") {
            ++errors;
            fs.writeSync(output, JSON.stringify({ kind: "attempt", trial: result.trial, state: result.state, error: result.error, renderMs: result.renderMs, nodes: result.nodes, schedulerContextState: result.schedulerContextState, lifecycleEvents: result.lifecycleEvents }) + "\n");
            continue;
          }
          ++rendered;
          renderTimes.push(result.renderMs);
          try {
            const left = Buffer.from(result.left, "base64"), right = Buffer.from(result.right, "base64");
            const pcmBytes = Buffer.concat([left, right]);
            const pcmSha256 = fingerprint(pcmBytes);
            pcmHashes.add(pcmSha256);
            const candidateAnalysis = analysis.analyzePcm(left, right);
            nonFiniteOutputSamples += candidateAnalysis.nonFiniteSamples;
            if (!candidateAnalysis.finite) ++nonFiniteAttempts;
            if (candidateAnalysis.allZero) ++exactZeroAttempts;
            const isReference = reference === null;
            if (isReference) {
              reference = [left, right];
              referenceTrial = result.trial;
              referenceAnalysis = candidateAnalysis;
              referencePcmHash = fingerprint(pcmBytes);
            }
            const pcmDifference = isReference
              ? { differentSamples: 0, first: null, firstChannel: null, firstQuantum: null, firstOffsetInQuantum: null, last: null, maxFiniteAbs: 0, candidate: candidateAnalysis, reference: candidateAnalysis }
              : analysis.comparePcm(left, right, reference);
            const differs = pcmDifference.differentSamples > 0;
            if (differs) ++differences;
            const sourceRecords = result.sources.map((source) => {
              const bytes = Buffer.from(source.buffer.pcm, "base64");
              const sourceSha256 = fingerprint(bytes);
              sourceHashes.add(sourceSha256);
              rates.push(source.playbackRate);
              const sourceAnalysis = analysis.analyzePcm(bytes, bytes);
              nonFiniteSourceSamples += sourceAnalysis.nonFiniteSamples / 2;
              return {
                operator: source.operator,
                wave: source.wave,
                playbackRate: source.playbackRate,
                detune: source.detune,
                loop: source.loop,
                loopStart: source.loopStart,
                loopEnd: source.loopEnd,
                registeredBufferIdentity: source.registeredBufferIdentity,
                sourceBufferIdentityMatches: source.sourceBufferIdentityMatches,
                bufferOwnership: source.bufferOwnership,
                graphSettings: source.graphSettings,
                bufferSampleRate: source.buffer.sampleRate,
                bufferLength: source.buffer.length,
                bufferHash32: source.buffer.hash32,
                bufferSha256: sourceSha256,
                bufferFinite: sourceAnalysis.finite,
                bufferPeakAbsolute: sourceAnalysis.peakAbsolute,
                bufferPcm: isReference ? source.buffer.pcm : undefined,
              };
            });
            const record = {
              kind: "attempt",
              trial: result.trial,
              state: "rendered",
              firstAttempt: true,
              firstSuccessfullyRenderedPcm: isReference,
              renderMs: result.renderMs,
              pcmSha256,
              comparisonReferenceTrial: referenceTrial,
              firstPcmReferenceSha256: referencePcmHash,
              outputFinite: candidateAnalysis.finite,
              outputNonFiniteSamples: candidateAnalysis.nonFiniteSamples,
              outputPeakAbsolute: candidateAnalysis.peakAbsolute,
              outputFinitePeakAbsolute: candidateAnalysis.finitePeakAbsolute,
              outputAllZero: candidateAnalysis.allZero,
              disagreementWithFirstPcm: differs,
              pcmDifference,
              effectivePlaybackRates: result.effectivePlaybackRates,
              sources: sourceRecords,
              nodes: result.nodes,
              schedulerContextState: result.schedulerContextState,
              lifecycleEvents: result.lifecycleEvents,
            };
            if (isReference || differs || !candidateAnalysis.finite || candidateAnalysis.allZero) {
              record.leftPcm = result.left;
              record.rightPcm = result.right;
            }
            fs.writeSync(output, JSON.stringify(record) + "\n");
          } catch (error) {
            ++analysisErrors;
            fs.writeSync(output, JSON.stringify({
              kind: "attempt",
              trial: result.trial,
              state: "analysis-error",
              firstAttempt: true,
              renderMs: result.renderMs,
              error: String(error && error.stack || error),
              leftPcm: result.left,
              rightPcm: result.right,
              sources: result.sources,
              nodes: result.nodes,
              schedulerContextState: result.schedulerContextState,
              lifecycleEvents: result.lifecycleEvents,
            }) + "\n");
          }
        }
      } finally {
        await browserContext.close();
      }
    }
  } finally {
    if (browser) await browser.close();
    fs.closeSync(output);
  }
  const summary = {
    kind: "summary",
    attemptsRequested: config.n,
    rendered,
    errors,
    analysisErrors,
    protocolErrors,
    firstSuccessfullyRenderedTrial: referenceTrial,
    firstReferenceFinite: referenceAnalysis ? referenceAnalysis.finite : null,
    firstReferencePeakAbsolute: referenceAnalysis ? referenceAnalysis.peakAbsolute : null,
    disagreementsWithFirstPcm: differences,
    disagreementInterpretation: "count only; the first PCM may itself be shifted and this is not an event-rate estimate",
    nonFiniteAttempts,
    nonFiniteOutputSamples,
    nonFiniteSourceSamples,
    exactZeroOutputAttempts: exactZeroAttempts,
    audibilityAssessment: "not performed; exact-zero detection does not classify quiet or perceptually inaudible output",
    distinctPcmHashes: pcmHashes.size,
    distinctSourceBufferHashes: sourceHashes.size,
    effectivePlaybackRateMin: rates.length ? Math.min(...rates) : null,
    effectivePlaybackRateMax: rates.length ? Math.max(...rates) : null,
    renderMsMedian: renderTimes.length ? renderTimes.sort((a, b) => a - b)[Math.floor(renderTimes.length / 2)] : null,
    renderMsTotal: renderTimes.reduce((sum, n) => sum + n, 0),
    noRetry: true,
    investigationOnly: true,
    verdict: "capture completed; observed PCM is unadjudicated",
  };
  const append = fs.openSync(config.out, "a");
  fs.writeSync(append, JSON.stringify(summary) + "\n");
  fs.closeSync(append);
  console.log(JSON.stringify(Object.assign({ out: config.out }, summary)));
  if (errors || analysisErrors || protocolErrors || nonFiniteOutputSamples || nonFiniteSourceSamples || exactZeroAttempts) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
