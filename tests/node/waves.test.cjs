/*
 * The #26 waveform registry with the pinned consumer setup fixture
 * (tests/fixtures/consumer/waves-setup.json, waves-song.mid), on the mock
 * WebAudio of tests/harness.js, for the source and minified builds:
 *   - the fixture's engine values are its consumer values converted per D-006
 *     (i8 / 128; harmonic i+1 at imag[i+1], DC and real zero), and its pinned
 *     hashes hold;
 *   - the setup installs in the consumer's order (quality, settings, waves,
 *     timbres), the song plays every note on the registered waves, at each
 *     wave's home pitch, and both builds make identical WebAudio calls;
 *   - the generated tables are deterministic: a fresh process gives the same
 *     bytes, equal to an independent held table (D-027) at 44.1 and 48 kHz.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const H = require("../harness");

const DIR = path.join(H.ROOT, "tests", "fixtures", "consumer");
const SETUP = JSON.parse(fs.readFileSync(path.join(DIR, "waves-setup.json"), "utf8"));
const SONG = fs.readFileSync(path.join(DIR, SETUP.song.file));
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const f32 = (a) => Buffer.from(Float32Array.from(a).buffer);

function lfsr({ length, tap, high }) {
  const out = [];
  let r = 1;
  for (let i = 0; i < length; ++i) {
    const fb = (r & 1) ^ ((r >> tap) & 1);
    r = (r >> 1) | (fb << 14);
    out.push(r & 1 ? high : -high);
  }
  return out;
}

/* The engine call for one fixture wave, converted here from its consumer form (D-006). */
function engineCall(w) {
  if (w.Harmonics) return ["setHarmonicWave", w.name, new Array(w.Harmonics.length + 1).fill(0), [0, ...w.Harmonics.map((h) => h / 10000)]];
  const s = w.Samples || lfsr(w.SamplesGenerator.lfsr);
  return ["setSampleWave", w.name, s.map((x) => x / 128)];
}

/* D-027's held table, written from the formula, with the guard frame (the first sample again; tasks/T11.md): {frames, base}. */
function held(samples, sr) {
  const n = samples.length, k = Math.max(1, Math.round(sr / (440 * n)));
  const frames = new Float32Array(n * k + 1);
  for (let j = 0; j < n * k; ++j) frames[j] = samples[Math.floor(j / k)];
  frames[n * k] = samples[0];
  return { frames, base: sr / (n * k) };
}

/* Installs the fixture the way the consumer's page does (contracts.md, consumer setup contract). */
function install(synth) {
  const e = SETUP.settings.engine;
  synth.setQuality(e.quality);
  synth.setMasterVol(e.masterVol);
  synth.setReverbLev(e.reverbLev);
  synth.setVoices(e.voices);
  for (const w of SETUP.waves) {
    const [method, ...args] = engineCall(w);
    synth[method](...args);
  }
  for (const t of SETUP.timbres) synth.setTimbre(t.drum ? 1 : 0, t.slot, JSON.parse(JSON.stringify(t.operators)));
}

test("the fixture's engine values are its consumer values converted per D-006, and its hashes hold", () => {
  assert.equal(sha(SONG), SETUP.song.sha256);
  assert.match(SETUP.provenance.consumer.commit, /^[0-9a-f]{40}$/);
  for (const w of SETUP.waves) {
    const [method, name, a, b] = engineCall(w);
    assert.match(name, method === "setSampleWave" ? /^n[A-Za-z_]\w{0,30}$/ : /^w[A-Za-z_]\w{0,30}$/);
    if (w.Samples) {
      assert.deepEqual(w.samples, a, w.name);
      assert.ok(w.Samples.every((x) => Number.isInteger(x) && x >= -128 && x <= 127), w.name + " is i8");
    } else if (w.SamplesGenerator) {
      const s = lfsr(w.SamplesGenerator.lfsr);
      assert.equal(sha(Buffer.from(Int8Array.from(s).buffer)), w.sha256.i8);
      assert.equal(sha(f32(a)), w.sha256.float32);
      assert.equal(a.length, 32767);
    } else {
      assert.deepEqual([w.real, w.imag], [a, b], w.name);
      assert.equal(b[0], 0);
    }
  }
  const names = new Set(SETUP.waves.map((w) => w.name));
  for (const t of SETUP.timbres) for (const o of t.operators)
    assert.ok(["sine", "square", "sawtooth", "triangle", "n0", "n1", "w9999"].includes(o.w) || names.has(o.w), t.name + ": " + o.w);
});

for (const variant of H.forkVariants()) {
  test(variant.name + ": the consumer setup installs and its song plays on the registered waves", () => {
    const { synth, env, trace, notes } = H.createSynth(variant.source, variant.name);
    install(synth);
    synth.loadMIDI(H.toArrayBuffer(SONG));
    synth.setLoop(0);
    synth.playMIDI();
    assert.ok(H.runUntil(env, () => synth.getPlayStatus().play === 0, 60000), "the song ends");
    H.runUntil(env, () => false, 2000);
    const noteOns = notes.length;
    assert.ok(noteOns >= 40, "notes played: " + noteOns);
    // Every buffer source plays a registered wave's buffer at that wave's home pitch basis.
    const bufs = new Map(Object.entries(synth.noiseBuf).map(([k, b]) => [b._id, k]));
    const used = new Set();
    const lines = trace.map((l) => JSON.parse(l));
    const rateOf = new Map();
    for (const [op, id, v] of lines) if (op === "value" && /\.playbackRate$/.test(id)) rateOf.set(id.split(".")[0], v);
    for (const [op, id, b] of lines) {
      if (op !== "buffer" || !id.startsWith("src#")) continue;
      const name = bufs.get(b);
      assert.ok(name, "buffer " + b + " is a current wave");
      used.add(name);
    }
    for (const name of ["nTRI", "nP12", "nSAW", "nMET", "nNOI", "nP50", "nBTRI"]) assert.ok(used.has(name), name + " was played");
    // The lead's first note: A4 on nTRI (program 0, ch 0) at 440 Hz.
    const lead = notes.find(([, ch, n]) => ch === 0 && n === 69);
    assert.ok(lead);
    const tri = SETUP.waves.find((w) => w.name === "nTRI").samples;
    const triRates = [...rateOf.entries()].filter(([src]) => lines.some(([op, id, b]) => op === "buffer" && id === src && bufs.get(b) === "nTRI")).map(([, r]) => r);
    assert.ok(triRates.some((r) => Math.abs(r - 440 / held(tri, 44100).base) < 1e-12), "nTRI at A4 plays at 440 / base");
    // Harmonic waves were built from the converted coefficients.
    const pw = lines.filter(([op]) => op === "createPeriodicWave").map((c) => c.slice(2));
    assert.deepEqual(pw.slice(-2), SETUP.waves.filter((w) => w.Harmonics).map((w) => [w.real, w.imag.map(Math.fround)]));
  });
}

test("source and minified builds make identical WebAudio calls through the consumer setup and song", () => {
  const run = (variant) => {
    const { synth, env, trace } = H.createSynth(variant.source, variant.name);
    install(synth);
    synth.loadMIDI(H.toArrayBuffer(SONG));
    synth.playMIDI();
    H.runUntil(env, () => synth.getPlayStatus().play === 0, 60000);
    H.runUntil(env, () => false, 2000);
    synth.setAudioContext(new env.sandbox.AudioContext()); // rebuilds every wave
    return trace;
  };
  const [a, b] = H.forkVariants().map(run);
  assert.ok(a.length > 1000);
  assert.deepEqual(a, b);
});

test("generated tables are deterministic across processes and equal D-027's held table at 44.1 and 48 kHz", () => {
  const script = `
    const H = require(${JSON.stringify(path.join(H.ROOT, "tests", "harness.js"))});
    const crypto = require("crypto");
    const setup = require(${JSON.stringify(path.join(DIR, "waves-setup.json"))});
    const out = {};
    for (const variant of H.forkVariants()) for (const sr of [44100, 48000]) {
      const { synth, env } = H.createSynth(variant.source, variant.name);
      const c = new env.sandbox.AudioContext(); c.sampleRate = sr; synth.setAudioContext(c);
      for (const w of setup.waves.filter((x) => x.samples)) synth.setSampleWave(w.name, w.samples);
      for (const w of setup.waves.filter((x) => x.samples)) {
        const d = synth.noiseBuf[w.name].getChannelData(0);
        out[variant.name + "@" + sr + ":" + w.name] = crypto.createHash("sha256").update(Buffer.from(d.buffer, d.byteOffset, d.byteLength)).digest("hex");
      }
    }
    process.stdout.write(JSON.stringify(out));`;
  const runs = [0, 1].map(() => JSON.parse(execFileSync(process.execPath, ["-e", script], { encoding: "utf8" })));
  assert.deepEqual(runs[0], runs[1]);
  for (const sr of [44100, 48000]) {
    for (const w of SETUP.waves.filter((x) => x.samples)) {
      const want = sha(Buffer.from(held(w.samples, sr).frames.buffer));
      assert.equal(runs[0]["webaudio-tinysynth.js@" + sr + ":" + w.name], want, w.name + " @" + sr);
      assert.equal(runs[0]["webaudio-tinysynth.min.js@" + sr + ":" + w.name], want, w.name + " @" + sr + " (min)");
    }
  }
});

test("TinyChip's 32,767-step LFSR registers directly (D-028) and replays at k = 1", () => {
  const noi = SETUP.waves.find((w) => w.name === "nNOI");
  const [, name, samples] = engineCall(noi);
  for (const variant of H.forkVariants()) {
    const { synth, env } = H.createSynth(variant.source, variant.name);
    for (const sr of [44100, 48000]) {
      const c = new env.sandbox.AudioContext();
      c.sampleRate = sr;
      synth.setAudioContext(c);
      synth.setSampleWave(name, samples);
      const b = synth.noiseBuf[name];
      assert.equal(sha(Buffer.from(synth._wv.get(name)[0].buffer)), noi.sha256.float32); // the stored copy
      assert.equal(b.length, 32768); // k = 1, plus the guard frame
      assert.equal(sha(Buffer.from(b.getChannelData(0).buffer)), sha(Buffer.from(held(samples, sr).frames.buffer)));
    }
  }
});

/*
 * TinyChip's current integration (midi_fun_contract b16c8ef, tinychip.js lines 15-43): it writes 1 s
 * buffers at 440 cycles per second into synth.noiseBuf, writes presets into program slots above 127
 * and installs its drum kit with setTimbre. That is the unsupported compatibility path (D-031): the
 * flow must keep working and play exactly as on upstream (the reference build, with the fork's
 * tempo patch only), call for call.
 */
function tinyChipFlow(source, label) {
  const { synth, env, trace } = H.createSynth(source, label);
  // tinychip.js: the waveform generators and registerWaves(), verbatim apart from formatting.
  const bits = (len, tap) => { const out = []; let r = 1; for (let i = 0; i < len; i++) { const fb = (r & 1) ^ ((r >> tap) & 1); r = (r >> 1) | (fb << 14); out.push(r & 1 ? 0.5 : -0.5); } return out; };
  const SHORT = bits(93, 6), LONG = bits(32767, 1);
  const tri4 = (x) => { const s = Math.floor(x * 32); return ((s < 16 ? 15 - s : s - 16) / 7.5 - 1) * 0.6; };
  const saw4 = (x) => (Math.floor(x * 16) / 7.5 - 1) * 0.45;
  const pulse = (duty) => (x) => (x < duty ? 0.5 : -0.5);
  const ac = synth.getAudioContext(), sr = ac.sampleRate;
  const make = (fill) => { const b = ac.createBuffer(1, sr, sr), d = b.getChannelData(0); for (let i = 0; i < sr; i++) d[i] = fill(i); return b; };
  const cyc = (shape) => make((i) => shape(((i * 440) / sr) % 1));
  Object.assign(synth.noiseBuf, {
    nP12: cyc(pulse(0.125)), nP25: cyc(pulse(0.25)), nP50: cyc(pulse(0.5)), nTRI: cyc(tri4), nSAW: cyc(saw4),
    nNOI: make((i) => LONG[i % 32767]), nMET: make((i) => SHORT[i % 93]),
  });
  // install(): presets at 129 + bank number, filled with the operator defaults; the drum kit through setTimbre.
  const DEFAULTS = { g: 0, w: "sine", t: 1, f: 0, v: 0.5, a: 0, h: 0.01, d: 0.01, s: 0, r: 0.05, p: 1, q: 1, k: 0 };
  const presets = SETUP.timbres.filter((t) => !t.drum && /^TinyChip /.test(t.name));
  for (const t of presets) synth.program[129 + t.slot] = { name: t.name, p: t.operators.map((o) => ({ ...DEFAULTS, ...o })) };
  const drums = SETUP.timbres.filter((t) => t.drum);
  for (const t of drums) synth.setTimbre(1, t.slot, (t.tinychipOperators || t.operators).map((o) => ({ ...o })));
  // Play every preset and drum.
  const from = trace.length;
  presets.forEach((t, i) => {
    synth.setProgram(i % 8, 129 + t.slot);
    synth.noteOn(i % 8, 57 + i * 3, 100, 1 + i * 0.25);
    synth.noteOff(i % 8, 57 + i * 3, 1.2 + i * 0.25);
  });
  drums.forEach((t, i) => synth.noteOn(9, t.slot, 110, 4 + i * 0.25));
  H.runUntil(env, () => false, 8000);
  return { trace: trace.slice(from), synth, presets, drums };
}

test("TinyChip's current noiseBuf and setTimbre flow plays exactly as on upstream (unsupported compatibility path)", () => {
  const ref = tinyChipFlow(H.referenceSource(), "upstream+patches");
  assert.ok(ref.trace.length > 200, "the flow plays: " + ref.trace.length + " calls");
  assert.ok(ref.drums.some((t) => (t.tinychipOperators || []).some((o) => o.w === "nNOI")) && ref.presets.length >= 7);
  for (const variant of H.forkVariants()) {
    const fork = tinyChipFlow(variant.source, variant.name);
    assert.deepEqual(fork.trace, ref.trace, variant.name);
    assert.equal(fork.synth._wv.size, 0, "nothing was registered");
  }
});
