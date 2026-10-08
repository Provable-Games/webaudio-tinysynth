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
const testBuild = require("../scripts/test-build");

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
    try {
      src = fs.readFileSync(process.env.TINYSYNTH_REFERENCE);
    } catch (e) {
      fail("cannot read TINYSYNTH_REFERENCE=" + process.env.TINYSYNTH_REFERENCE + " (" + e.message + ")");
    }
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
  /*
   * #59 (D-039, ledger L-15): a note released before an operator's attack
   * ends. The two patches below are the fork's change, so they alter only
   * the release automation of such notes: an operator still in its attack
   * at the note-off ramps on to its own value there and is released from it,
   * instead of being silent until the note-off and set from the last
   * operator's attack. Notes released after every attack has ended make
   * upstream's calls exactly; tests/unit/short-notes.test.mjs checks that
   * against raw upstream for every built-in program in both quality modes.
   */
  {
    name: "short notes: each operator's attack end (#59)",
    from: "g:g,t2:t+pn.a,v:vp",
    to: "g:g,t2:p.map(x=>t+x.a),v:vp",
  },
  {
    name: "short notes: release an operator still in its attack from its own ramp value (#59)",
    from: [
      "          nt.g[k].gain.cancelScheduledValues(t);",
      "          if(t==nt.t2)",
      "            nt.g[k].gain.setValueAtTime(nt.v[k],t);",
      "          else if(t<nt.t2)",
      "            nt.g[k].gain.setValueAtTime(nt.v[k]*(t-nt.t)/(nt.t2-nt.t),t);",
      "          this._setParamTarget(nt.g[k].gain,0,t,nt.r[k]);",
    ].join("\n"),
    to: [
      "          const g=nt.g[k].gain,e=nt.t2[k];",
      "          g.cancelScheduledValues(t);",
      "          if(t<=e){",
      "            if(e>nt.t)",
      "              g.linearRampToValueAtTime(nt.v[k]*=(t-nt.t)/(e-nt.t),t);",
      "            else",
      "              g.setValueAtTime(nt.v[k],t);",
      "            nt.t2[k]=t;",
      "          }",
      "          this._setParamTarget(g,0,t,nt.r[k]);",
    ].join("\n"),
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

/*
 * This repo's builds: the source, and the minified build of the current
 * source (scripts/test-build.js: .build/, or TINYSYNTH_MIN), never the
 * committed min.js, which CI regenerates after merging. `name` labels the
 * build; `file` is the path that was read.
 */
function forkVariants() {
  return [
    { name: "webaudio-tinysynth.js", file: path.join(ROOT, "webaudio-tinysynth.js") },
    { name: "webaudio-tinysynth.min.js", file: testBuild.existingMinPath() },
  ].map((v) => ({ ...v, source: fs.readFileSync(v.file, "utf8") }));
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

  /* Added for T12 (#27): BiquadFilterNode, with its four AudioParams at their Web Audio defaults. */
  class BiquadFilter extends AudioNode {
    constructor() {
      super("biquad");
      this.frequency = new AudioParam(this._id + ".frequency", 350);
      this.Q = new AudioParam(this._id + ".Q", 1);
      this.gain = new AudioParam(this._id + ".gain", 0);
      this.detune = new AudioParam(this._id + ".detune", 0);
      this._type = "lowpass";
    }
    get type() { return this._type; }
    set type(t) { this._type = t; rec("type", this._id, t); }
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
    close() { rec("close"); this.state = "closed"; return Promise.resolve(); }
    createGain() { return new Gain(); }
    createOscillator() { return new Oscillator(); }
    createBufferSource() { return new BufferSource(); }
    createBuffer(ch, len, sr) { return new AudioBuffer(ch, len, sr); }
    createStereoPanner() { return new StereoPanner(); }
    createDynamicsCompressor() { return new AudioNode("comp"); }
    createConvolver() { return new Convolver(); }
    createBiquadFilter() { return new BiquadFilter(); } // T12 (#27)
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

  // Let `ms` pass with no interval firing, as in a throttled background tab: every
  // overdue interval then fires once, at the new time, on the next step().
  function skip(ms) {
    clock.ms += ms;
    for (const t of timers.values()) t.due = Math.max(t.due, clock.ms);
  }

  // timers: the active intervals (id -> {fn, ms, due}), for lifecycle tests (T4).
  return { sandbox, clock, step, skip, timers };
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

/* ---------- raw Standard MIDI File pieces, for the parser tests ---------- */

/* A variable-length quantity. There is no length limit, so over-long values can be written on purpose. */
function vlq(v) {
  const out = [v % 128];
  while ((v = Math.floor(v / 128))) out.unshift((v % 128) | 0x80);
  return out;
}

/* Track data from [{tick, bytes}] (stable-sorted by tick, delta-encoded), ending with End-of-Track unless eot === false. */
function trackBytes(events, eot) {
  const sorted = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.tick - b.e.tick || a.i - b.i).map((x) => x.e);
  const out = [];
  let last = 0;
  for (const ev of sorted) {
    out.push(...vlq(ev.tick - last), ...ev.bytes);
    last = ev.tick;
  }
  if (eot !== false) out.push(0, 0xff, 0x2f, 0x00);
  return out;
}

const be32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];

/* A chunk as a byte array: a 4-character id, a length (`declared`, default the real one) and the data. */
function chunk(id, bytes, declared) {
  return [...Buffer.from(id, "latin1"), ...be32(declared === undefined ? bytes.length : declared), ...bytes];
}

/*
 * A file: an MThd chunk, then `chunks`. A byte array becomes an MTrk chunk;
 * {raw: [...]} is copied as is (build it with chunk()). ntrks counts the byte
 * arrays unless opts.ntrks is given; opts.headerExtra appends bytes to the
 * header chunk and its length.
 */
function smf(format, division, chunks, opts = {}) {
  const extra = opts.headerExtra || [];
  const ntrks = opts.ntrks === undefined ? chunks.filter((c) => Array.isArray(c)).length : opts.ntrks;
  const out = chunk("MThd", [format >> 8, format & 0xff, ntrks >> 8, ntrks & 0xff, division >> 8, division & 0xff, ...extra]);
  for (const c of chunks) out.push(...(Array.isArray(c) ? chunk("MTrk", c) : c.raw));
  return Buffer.from(out);
}

/*
 * getPlayStatus() results. This fork adds startTime (D-023), the scheduler's
 * current pass origin, and initialStartTime (#68), the origin of the latest
 * playMIDI() run until explicit invalidation. playStatus() builds a whole
 * expected result; statusOf() fills missing fork fields on upstream's result.
 */
const playStatus = (play, maxTick, curTick, startTime = null, initialStartTime = null) => ({
  play, maxTick, curTick, startTime, initialStartTime,
});
const statusOf = (synth) => Object.assign({ startTime: null, initialStartTime: null }, synth.getPlayStatus());

/*
 * Everything a failed loadMIDI must leave unchanged, as plain JSON: the song,
 * the sequencer position and timing, the voice count, the channel and tuning
 * state, and the timbre tables (program, drummap). Undefined and non-finite
 * numbers are kept as strings.
 */
function playbackState(synth) {
  const keep = (k, v) => (v === undefined ? "undefined" : typeof v === "number" && !Number.isFinite(v) ? String(v) : v);
  return JSON.parse(JSON.stringify({
    song: synth.song, maxTick: synth.maxTick, playTick: synth.playTick, playIndex: synth.playIndex,
    playing: synth.playing, playTime: synth.playTime, tick2Time: synth.tick2Time, status: statusOf(synth),
    loop: synth.loop, loopEnd: synth.loopEnd, voices: synth.notetab.length,
    pg: synth.pg, vol: synth.vol, ex: synth.ex, bend: synth.bend, brange: synth.brange, rpnidx: synth.rpnidx,
    sustain: synth.sustain, rhythm: synth.rhythm, tuningC: synth.tuningC, tuningF: synth.tuningF,
    scaleTuning: synth.scaleTuning, masterTuningC: synth.masterTuningC, masterTuningF: synth.masterTuningF,
    program: synth.program, drummap: synth.drummap,
  }, keep));
}

module.exports = {
  ROOT, UPSTREAM_COMMIT, UPSTREAM_SHA256,
  FORK_PATCHES, fail, sha256, upstreamSource, applyPatches, referenceSource, forkVariants,
  createEnvironment, createSynth, toArrayBuffer, runUntil,
  makeMidi, midi,
  vlq, trackBytes, chunk, smf, playStatus, statusOf, playbackState,
};
