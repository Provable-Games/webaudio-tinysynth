#!/usr/bin/env node
/*
 * Differential test: this fork vs. upstream webaudio-tinysynth.
 *
 * Loads the upstream source (g200kg/webaudio-tinysynth at UPSTREAM_COMMIT),
 * this repo's webaudio-tinysynth.js and webaudio-tinysynth.min.js into
 * separate `vm` contexts backed by a mock WebAudio implementation, plays
 * every MIDI file in the repo through each one on a hand-driven clock, and
 * requires every variant to produce exactly the same
 *   - sequence of _note(t, ch, n, v, p) calls, and
 *   - trace of WebAudio calls (node creation, connections, AudioParam
 *     scheduling, start/stop),
 * as upstream.
 *
 * The upstream reference is read with `git show UPSTREAM_COMMIT:...`, so it
 * needs a clone with that commit (a shallow CI checkout needs
 * fetch-depth: 0). Or set TINYSYNTH_REFERENCE=/path/to/upstream/file.
 * Either way the reference must match UPSTREAM_SHA256.
 *
 * No dependencies beyond Node.js. Run: npm test
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const UPSTREAM_COMMIT = "3d75aee4b3f43cbd932265e7d60201fd5b770397";
const UPSTREAM_SHA256 = "dd2b1d95d64499dfc3c292858e8c2d6525dc0bcdc345a900b7db207dffaae38c";
const TICK_MS = 60;          // the synth's own sequencer interval
const TAIL_MS = 15000;       // keep the clock running after the song ends
const MAX_MS = 60 * 60 * 1000;

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function loadReference() {
  let src;
  if (process.env.TINYSYNTH_REFERENCE) {
    src = fs.readFileSync(process.env.TINYSYNTH_REFERENCE);
  } else {
    try {
      src = execFileSync("git", ["show", UPSTREAM_COMMIT + ":webaudio-tinysynth.js"],
        { cwd: ROOT, maxBuffer: 1 << 24, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      fail("cannot read the upstream reference with git (shallow clone?). " +
        "Fetch full history, or set TINYSYNTH_REFERENCE to upstream's webaudio-tinysynth.js @ " +
        UPSTREAM_COMMIT.slice(0, 7) + ".");
    }
  }
  const h = sha256(src);
  if (h !== UPSTREAM_SHA256)
    fail("upstream reference sha256 is " + h + ", expected " + UPSTREAM_SHA256);
  return src.toString("utf8");
}

/* ---------- mock WebAudio + hand-driven clock ---------- */

function createEnvironment(trace) {
  const clock = { ms: 0 };
  const timers = new Map();
  let nextTimer = 1;
  let nextNode = 1;
  const rec = (...a) => trace.push(JSON.stringify(a));

  class AudioParam {
    constructor(id, v) { this._id = id; this._v = v; }
    get value() { return this._v; }
    set value(v) { this._v = v; rec("value", this._id, v); }
    setValueAtTime(v, t) { rec("setValueAtTime", this._id, v, t); return this; }
    linearRampToValueAtTime(v, t) { rec("linearRamp", this._id, v, t); return this; }
    exponentialRampToValueAtTime(v, t) { rec("expRamp", this._id, v, t); return this; }
    setTargetAtTime(v, t, c) { rec("setTargetAtTime", this._id, v, t, c); return this; }
    cancelScheduledValues(t) { rec("cancel", this._id, t); return this; }
  }

  class AudioNode {
    constructor(kind) { this._id = kind + "#" + nextNode++; rec("create", this._id); }
    connect(dest) { rec("connect", this._id, dest._id); return dest; }
    disconnect(dest) { rec("disconnect", this._id, dest ? dest._id : null); }
  }

  class Scheduled extends AudioNode {
    constructor(kind) { super(kind); this.onended = null; }
    start(t) { rec("start", this._id, t); }
    stop(t) { rec("stop", this._id, t === undefined ? null : t); }
  }

  class Oscillator extends Scheduled {
    constructor() {
      super("osc");
      this.frequency = new AudioParam(this._id + ".frequency", 440);
      this.detune = new AudioParam(this._id + ".detune", 0);
      this._type = "sine";
    }
    get type() { return this._type; }
    set type(t) { this._type = t; rec("type", this._id, t); }
    setPeriodicWave(w) { rec("setPeriodicWave", this._id, w._id); }
  }

  class BufferSource extends Scheduled {
    constructor() {
      super("src");
      this.playbackRate = new AudioParam(this._id + ".playbackRate", 1);
      this.detune = new AudioParam(this._id + ".detune", 0);
      this._buffer = null;
      this.loop = false;
    }
    get buffer() { return this._buffer; }
    set buffer(b) { this._buffer = b; rec("buffer", this._id, b ? b._id : null); }
  }

  class Gain extends AudioNode {
    constructor() { super("gain"); this.gain = new AudioParam(this._id + ".gain", 1); }
  }

  class StereoPanner extends AudioNode {
    constructor() { super("pan"); this.pan = new AudioParam(this._id + ".pan", 0); }
  }

  class Convolver extends AudioNode {
    constructor() { super("conv"); this._buffer = null; }
    get buffer() { return this._buffer; }
    set buffer(b) { this._buffer = b; rec("buffer", this._id, b ? b._id : null); }
  }

  class AudioBuffer {
    constructor(ch, len, sr) {
      this._id = "buf#" + nextNode++;
      this.numberOfChannels = ch; this.length = len; this.sampleRate = sr;
      this._data = [];
      for (let i = 0; i < ch; ++i) this._data.push(new Float32Array(len));
      rec("createBuffer", this._id, ch, len, sr);
    }
    getChannelData(i) { return this._data[i]; }
  }

  class MockAudioContext {
    constructor() {
      this.sampleRate = 44100;
      this.state = "running";
      this.destination = new AudioNode("destination");
    }
    get currentTime() { return clock.ms / 1000; }
    resume() { rec("resume"); return Promise.resolve(); }
    createGain() { return new Gain(); }
    createOscillator() { return new Oscillator(); }
    createBufferSource() { return new BufferSource(); }
    createBuffer(ch, len, sr) { return new AudioBuffer(ch, len, sr); }
    createStereoPanner() { return new StereoPanner(); }
    createDynamicsCompressor() { return new AudioNode("comp"); }
    createConvolver() { return new Convolver(); }
    createPeriodicWave(real, imag) {
      const id = "wave#" + nextNode++;
      rec("createPeriodicWave", id, Array.from(real), Array.from(imag));
      return { _id: id };
    }
  }

  const sandbox = {
    AudioContext: MockAudioContext,
    performance: { now: () => clock.ms },
    setInterval: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms, due: clock.ms + ms }); return id; },
    clearInterval: (id) => { timers.delete(id); },
    setTimeout: () => fail("unexpected setTimeout"),
    XMLHttpRequest: function () { fail("unexpected XMLHttpRequest"); },
    console,
  };
  vm.createContext(sandbox);

  // Advance the clock to the next due interval and fire it (in creation order on ties).
  function step() {
    let due = Infinity;
    for (const t of timers.values()) due = Math.min(due, t.due);
    if (due === Infinity) fail("no interval scheduled");
    clock.ms = due;
    for (const t of Array.from(timers.values())) {
      if (t.due === due) { t.due += t.ms; t.fn(); }
    }
  }

  return { sandbox, clock, step };
}

/* ---------- run one variant against one MIDI file ---------- */

function run(source, label, midiBytes) {
  const trace = [];
  const notes = [];
  const env = createEnvironment(trace);
  vm.runInContext(source, env.sandbox, { filename: label });
  const Synth = env.sandbox.WebAudioTinySynth;
  if (typeof Synth !== "function") fail(label + ": window.WebAudioTinySynth was not exported");

  const synth = new Synth();
  const note = synth._note;
  synth._note = (t, ch, n, v, p) => {
    notes.push(JSON.stringify([t, ch, n, v, p]));
    return note(t, ch, n, v, p);
  };

  // Copy into a fresh ArrayBuffer: a Node Buffer can be a view into a shared pool.
  const ab = midiBytes.buffer.slice(midiBytes.byteOffset, midiBytes.byteOffset + midiBytes.byteLength);
  synth.loadMIDI(ab);
  synth.setLoop(0);
  synth.playMIDI();
  const st = synth.getPlayStatus();
  if (st.play !== 1 || !(st.maxTick > 0)) fail(label + ": playMIDI did not start (" + JSON.stringify(st) + ")");

  let endedAt = null;
  while (env.clock.ms < MAX_MS) {
    env.step();
    if (endedAt === null && synth.getPlayStatus().play === 0) endedAt = env.clock.ms;
    if (endedAt !== null && env.clock.ms >= endedAt + TAIL_MS) break;
  }
  if (endedAt === null) fail(label + ": song did not finish within " + MAX_MS / 1000 + "s of virtual time");
  const end = synth.getPlayStatus();
  return { notes, trace, endedAt, maxTick: st.maxTick, curTick: end.curTick, voicesLeft: synth.notetab.length };
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; ++i) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

/* ---------- main ---------- */

const variants = [
  { name: "upstream@" + UPSTREAM_COMMIT.slice(0, 7), source: loadReference() },
  { name: "webaudio-tinysynth.js", source: fs.readFileSync(path.join(ROOT, "webaudio-tinysynth.js"), "utf8") },
  { name: "webaudio-tinysynth.min.js", source: fs.readFileSync(path.join(ROOT, "webaudio-tinysynth.min.js"), "utf8") },
];

const midiFiles = ["ws.mid"].concat(
  fs.readdirSync(path.join(ROOT, "test-midi")).filter((f) => /\.midi?$/i.test(f)).sort().map((f) => "test-midi/" + f));

let failures = 0;
let totalNotes = 0;
console.log("reference: upstream " + UPSTREAM_COMMIT + " (sha256 verified)");
for (const file of midiFiles) {
  const bytes = fs.readFileSync(path.join(ROOT, file));
  const results = variants.map((v) => run(v.source, v.name, bytes));
  const ref = results[0];
  if (ref.notes.length === 0) { console.log("FAIL " + file + ": upstream produced no notes"); ++failures; continue; }
  totalNotes += ref.notes.length;
  const problems = [];
  for (let i = 1; i < variants.length; ++i) {
    const r = results[i];
    const dn = firstDiff(ref.notes, r.notes);
    const dt = firstDiff(ref.trace, r.trace);
    if (dn !== -1) problems.push(variants[i].name + ": _note #" + dn + " differs\n    upstream: " + ref.notes[dn] + "\n    this:     " + r.notes[dn]);
    if (dt !== -1) problems.push(variants[i].name + ": WebAudio call #" + dt + " differs\n    upstream: " + ref.trace[dt] + "\n    this:     " + r.trace[dt]);
    if (r.endedAt !== ref.endedAt || r.curTick !== ref.curTick || r.voicesLeft !== ref.voicesLeft)
      problems.push(variants[i].name + ": end state differs");
  }
  const summary = file.padEnd(46) + String(ref.notes.length).padStart(5) + " notes  " +
    String(ref.trace.length).padStart(7) + " WebAudio calls  maxTick " + ref.maxTick +
    "  ends at " + (ref.endedAt / 1000).toFixed(2) + "s";
  if (problems.length) {
    ++failures;
    console.log("FAIL " + summary);
    for (const p of problems) console.log("  " + p);
  } else {
    console.log("ok   " + summary);
  }
}
console.log("\n" + midiFiles.length + " files, " + totalNotes + " notes per variant; compared " +
  variants.slice(1).map((v) => v.name).join(" and ") + " against " + variants[0].name);
if (failures) fail(failures + " file(s) differ");
console.log("PASS: identical _note sequences and WebAudio call traces");
