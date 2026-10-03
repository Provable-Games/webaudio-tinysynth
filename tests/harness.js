/*
 * Shared test harness: a mock WebAudio implementation with a hand-driven
 * clock, loaders for the upstream reference and this repo's builds, and a
 * small Standard MIDI File writer for generated fixtures.
 *
 * No dependencies beyond Node.js.
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

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/*
 * Upstream's webaudio-tinysynth.js at UPSTREAM_COMMIT, read with
 * `git show` (needs that commit in local history; a shallow CI checkout
 * needs fetch-depth: 0) or from TINYSYNTH_REFERENCE=/path/to/file.
 * Either way it must match UPSTREAM_SHA256.
 */
function upstreamSource() {
  let src;
  if (process.env.TINYSYNTH_REFERENCE) {
    src = fs.readFileSync(process.env.TINYSYNTH_REFERENCE);
  } else {
    try {
      src = execFileSync("git", ["show", UPSTREAM_COMMIT + ":webaudio-tinysynth.js"],
        { cwd: ROOT, maxBuffer: 1 << 24, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
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

/*
 * Behavior changes this fork makes on purpose. The differential test
 * compares against upstream with exactly these replacements applied (each
 * must match exactly once), so it asserts "upstream plus these patches,
 * nothing else".
 */
const FORK_PATCHES = [
  {
    name: "fractional MIDI tempo (no Math.floor on BPM)",
    from: "var val = Math.floor(60000000 / Get3(s, i + 3));",
    to: "var val = 60000000 / Get3(s, i + 3);",
  },
];

function applyPatches(src, patches) {
  for (const p of patches) {
    const n = src.split(p.from).length - 1;
    if (n !== 1) fail("patch '" + p.name + "' matches " + n + " times in the upstream reference, expected 1");
    src = src.replace(p.from, () => p.to);
  }
  return src;
}

/* Upstream with FORK_PATCHES applied: what this fork should behave like. */
function referenceSource() {
  return applyPatches(upstreamSource(), FORK_PATCHES);
}

/* This repo's builds. */
function forkVariants() {
  return ["webaudio-tinysynth.js", "webaudio-tinysynth.min.js"].map((name) => ({
    name, source: fs.readFileSync(path.join(ROOT, name), "utf8"),
  }));
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

/*
 * Load `source` into a fresh mock environment and construct a synth.
 * Every _note(t, ch, n, v, p) call made after construction is appended to
 * `notes` as [t, ch, n, v, p]; every WebAudio call is appended to `trace`.
 */
function createSynth(source, label, opts) {
  const trace = [];
  const notes = [];
  const env = createEnvironment(trace);
  vm.runInContext(source, env.sandbox, { filename: label });
  const Synth = env.sandbox.WebAudioTinySynth;
  if (typeof Synth !== "function") fail(label + ": window.WebAudioTinySynth was not exported");
  const synth = new Synth(opts);
  const note = synth._note;
  synth._note = (t, ch, n, v, p) => {
    notes.push([t, ch, n, v, p]);
    return note(t, ch, n, v, p);
  };
  return { synth, env, trace, notes };
}

/* Copy a Node Buffer into a fresh ArrayBuffer (a Buffer can be a view into a shared pool). */
function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/* Step the clock until `until()` is true or `maxMs` of virtual time has passed. */
function runUntil(env, until, maxMs) {
  const end = env.clock.ms + maxMs;
  while (env.clock.ms < end) {
    env.step();
    if (until()) return true;
  }
  return false;
}

/* ---------- Standard MIDI File writer (format 0, one track) ---------- */

/*
 * events: [{tick, bytes:[...]}] in any order (stable-sorted by tick).
 * Returns a Buffer holding a complete .mid file.
 */
function makeMidi(ppq, events) {
  const vlq = (v) => {
    const out = [v & 0x7f];
    while ((v >>= 7)) out.unshift((v & 0x7f) | 0x80);
    return out;
  };
  const sorted = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.tick - b.e.tick || a.i - b.i).map((x) => x.e);
  const track = [];
  let last = 0;
  for (const ev of sorted) {
    track.push(...vlq(ev.tick - last), ...ev.bytes);
    last = ev.tick;
  }
  track.push(0, 0xff, 0x2f, 0x00);
  const u32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  const u16 = (v) => [(v >>> 8) & 0xff, v & 0xff];
  return Buffer.from([
    0x4d, 0x54, 0x68, 0x64, ...u32(6), ...u16(0), ...u16(1), ...u16(ppq),
    0x4d, 0x54, 0x72, 0x6b, ...u32(track.length), ...track,
  ]);
}

const midi = {
  tempo: (tick, us) => ({ tick, bytes: [0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff] }),
  noteOn: (tick, ch, n, v) => ({ tick, bytes: [0x90 | ch, n, v] }),
  noteOff: (tick, ch, n) => ({ tick, bytes: [0x80 | ch, n, 0] }),
};

module.exports = {
  ROOT, UPSTREAM_COMMIT, UPSTREAM_SHA256,
  FORK_PATCHES, fail, sha256, upstreamSource, applyPatches, referenceSource, forkVariants,
  createEnvironment, createSynth, toArrayBuffer, runUntil,
  makeMidi, midi,
};
