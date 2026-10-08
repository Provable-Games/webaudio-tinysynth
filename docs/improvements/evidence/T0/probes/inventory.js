#!/usr/bin/env node
/*
 * T0 public-surface and timbre inventory. Prints one JSON document.
 *
 *   node docs/improvements/evidence/T0/probes/inventory.js > inventory.json
 *
 * Everything is measured against the mock WebAudio in tests/harness.js, for
 * both builds, and the script fails (exit 1) if the builds disagree on any
 * hash or on the method/property lists.
 *
 * Timbre hashes. canonical(x) is JSON with object keys sorted at every level,
 * array holes/undefined/null written as null, numbers as JSON.stringify
 * writes them; sha256 is over its UTF-8 bytes. Three states are hashed:
 *   raw        the object literal handed to Object.assign() inside
 *              WebAudioTinySynthCore, captured by wrapping Object.assign in the
 *              vm context before the source runs (before any setTimbre()
 *              default filling);
 *   filled     the same tables after `new WebAudioTinySynth()` (setQuality(1)
 *              fills defaults into program0/program1/drummap0/drummap1 in place);
 *   installed  program[n].p / drummap[i].p as installed for quality 1 (after
 *              construction) and quality 0 (after setQuality(0)).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const C = require("./_common");
const { H } = C;

const TABLES = ["program0", "program1", "drummap0", "drummap1"];
const DEFP = { g: 0, w: "sine", t: 1, f: 0, v: 0.5, a: 0, h: 0.01, d: 0.01, s: 0, r: 0.05, p: 1, q: 1, k: 0 };
let mismatch = [];

function canonical(v) {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) {
    const parts = [];
    for (let i = 0; i < v.length; ++i) parts.push(i in v ? canonical(v[i]) : "null");
    return "[" + parts.join(",") + "]";
  }
  if (typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  if (typeof v === "number" && !isFinite(v)) throw new Error("non-finite number in table");
  return JSON.stringify(v);
}
const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

/* Mock environment with setInterval counting; constructs like H.createSynth but without the _note wrapper. */
function construct(build, opts, extraSandbox, prelude) {
  const trace = [];
  const env = H.createEnvironment(trace);
  let intervals = 0;
  const si = env.sandbox.setInterval;
  env.sandbox.setInterval = (fn, ms) => { ++intervals; return si(fn, ms); };
  Object.assign(env.sandbox, extraSandbox || {});
  if (prelude) vm.runInContext(prelude, env.sandbox);
  vm.runInContext(C.source(build), env.sandbox, { filename: build });
  const Synth = env.sandbox.WebAudioTinySynth;
  const before = trace.length;
  const synth = Synth ? new Synth(opts) : null;
  return { env, trace, synth, Synth, ctorTrace: trace.slice(before), intervals: () => intervals };
}

function createdKinds(trace) {
  const k = {};
  for (const line of trace) {
    const a = JSON.parse(line);
    if (a[0] === "create") { const kind = a[1].split("#")[0]; k[kind] = (k[kind] || 0) + 1; }
    if (a[0] === "createBuffer") k.buffer = (k.buffer || 0) + 1;
    if (a[0] === "createPeriodicWave") k.periodicWave = (k.periodicWave || 0) + 1;
  }
  return k;
}

function summarize(v) {
  if (v === null || v === undefined) return { type: String(v) };
  if (typeof v === "function") return { type: "function", arity: v.length, arrow: !("prototype" in v) };
  if (Array.isArray(v)) return { type: "array", length: v.length };
  if (typeof v === "object") {
    if (v._id) return { type: "mock " + String(v._id).split("#")[0] };
    return { type: "object", keys: Object.keys(v).slice(0, 12) };
  }
  return { type: typeof v, value: v };
}

/* ---------- timbre tables ---------- */

function timbreHashes(build) {
  const prelude = "(() => { const oa = Object.assign; Object.assign = function (t, s) {" +
    " if (s && s.program0 && !globalThis.__raw) globalThis.__raw = JSON.stringify({ program: s.program, drummap: s.drummap," +
    " program0: s.program0, program1: s.program1, drummap0: s.drummap0, drummap1: s.drummap1 });" +
    " return oa.apply(this, arguments); }; })()";
  const { env, synth } = construct(build, undefined, {}, prelude);
  const raw = JSON.parse(env.sandbox.__raw);
  const h = { raw: {}, filled: {}, installed: {} };
  h.raw.names = sha(canonical({ drummap: raw.drummap.map((x) => x.name), program: raw.program.map((x) => x.name) }));
  for (const t of TABLES) h.raw[t] = sha(canonical(raw[t]));
  h.raw.allTables = sha(canonical({ drummap0: raw.drummap0, drummap1: raw.drummap1, program0: raw.program0, program1: raw.program1 }));
  h.raw.namesAndTables = sha(canonical(raw));
  for (const t of TABLES) h.filled[t] = sha(canonical(synth[t]));
  h.filled.allTables = sha(canonical({ drummap0: synth.drummap0, drummap1: synth.drummap1, program0: synth.program0, program1: synth.program1 }));
  h.installed.quality1 = sha(canonical({ drummap: synth.drummap.map((x) => x.p), program: synth.program.map((x) => x.p) }));
  synth.setQuality(0);
  h.installed.quality0 = sha(canonical({ drummap: synth.drummap.map((x) => x.p), program: synth.program.map((x) => x.p) }));
  return { hashes: h, raw, filled: { program0: synth.program0, program1: synth.program1, drummap0: synth.drummap0, drummap1: synth.drummap1 } };
}

function tableStats(tables) {
  const fields = {};
  const wCounts = {};
  const gCounts = {};
  const unknownKeys = {};
  const notRepresentable = [];
  const perTable = {};
  let maxOps = 0;
  for (const t of TABLES) {
    const arr = tables[t];
    let timbres = 0, nulls = 0, ops = 0, maxT = 0;
    arr.forEach((timbre, idx) => {
      if (!timbre) { ++nulls; return; }
      ++timbres; ops += timbre.length; maxT = Math.max(maxT, timbre.length);
      timbre.forEach((op, oi) => {
        for (const [k, v] of Object.entries(op)) {
          if (!(k in DEFP)) unknownKeys[k] = (unknownKeys[k] || 0) + 1;
          if (k === "w") { wCounts[v] = (wCounts[v] || 0) + 1; continue; }
          if (k === "g") gCounts[v] = (gCounts[v] || 0) + 1;
          if (typeof v !== "number") continue;
          const f = fields[k] || (fields[k] = { min: Infinity, max: -Infinity, count: 0 });
          f.min = Math.min(f.min, v); f.max = Math.max(f.max, v); ++f.count;
          const scaled = v * 10000;
          if (Math.abs(scaled - Math.round(scaled)) > 1e-6) notRepresentable.push({ table: t, index: idx, op: oi, field: k, value: v });
        }
      });
    });
    perTable[t] = { length: arr.length, timbres, nulls, operators: ops, maxOperatorsPerTimbre: maxT };
    maxOps = Math.max(maxOps, maxT);
  }
  return { perTable, maxOperatorsPerTimbre: maxOps, fields, wCounts, gCounts, unknownKeys, notRepresentableAt1e4: notRepresentable };
}

/* Consumer (onchain-tinysynth src/types.cairo @ 71fce28) proposed ranges, for comparison only. */
const CONSUMER_RANGES = {
  v: [0, 100], t: [0, 64], f: [-20000, 20000], a: [0, 10], h: [0, 10], d: [0, 10], s: [0, 100], r: [0, 10],
  p: [0, 16], q: [0, 10], k: [-8, 8], g: [0, 18],
};
function outsideConsumerRanges(tables) {
  const out = [];
  for (const t of TABLES) tables[t].forEach((timbre, idx) => {
    if (!timbre) return;
    if (timbre.length > 8) out.push({ table: t, index: idx, field: "operators", value: timbre.length, range: [1, 8] });
    timbre.forEach((op, oi) => {
      for (const [k, [lo, hi]] of Object.entries(CONSUMER_RANGES)) {
        const v = op[k];
        if (typeof v === "number" && (v < lo || v > hi)) out.push({ table: t, index: idx, op: oi, field: k, value: v, range: [lo, hi] });
      }
      if (typeof op.g === "number" && op.g >= 9 && op.g <= 10) out.push({ table: t, index: idx, op: oi, field: "g", value: op.g, note: "FM route 9-10" });
    });
  });
  return out;
}

/* ---------- public surface ---------- */

function readmeDocumented(name) {
  const readme = fs.readFileSync(path.join(C.ROOT, "README.md"), "utf8");
  return new RegExp("\\*\\*" + name + "\\(").test(readme);
}
function readmeMentioned(name) {
  const readme = fs.readFileSync(path.join(C.ROOT, "README.md"), "utf8");
  return new RegExp("(^|[^\\w])" + name + "\\(").test(readme);
}

function testReliedMembers() {
  const dir = path.join(C.ROOT, "tests");
  const set = {};
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of src.matchAll(/(?<![\w$.-])synth\.([A-Za-z_$][\w$]*)/g)) (set[m[1]] = set[m[1]] || new Set()).add(f);
  }
  const out = {};
  for (const k of Object.keys(set).sort()) out[k] = Array.from(set[k]).sort();
  return out;
}

function surface(build) {
  const c = construct(build);
  const synth = c.synth;
  const own = Object.getOwnPropertyNames(synth).sort();
  const methods = {};
  const data = {};
  for (const k of own) {
    const v = synth[k];
    if (typeof v === "function") methods[k] = { arity: v.length, arrow: !("prototype" in v), private: k.startsWith("_"), documentedInReadme: readmeDocumented(k), mentionedInReadme: readmeMentioned(k) };
    else data[k] = summarize(v);
  }
  const properties = {};
  for (const [k, p] of Object.entries(synth.properties)) {
    properties[k] = { type: p.type && p.type.name, default: p.value, observer: p.observer || null, valueAfterConstruction: synth[k] };
  }
  return {
    prototypeOwnNames: Object.getOwnPropertyNames(c.Synth.prototype),
    staticOwnNames: Object.getOwnPropertyNames(c.Synth).sort(),
    methods, properties, dataFields: data,
    effectiveAudioParams: {
      "out.gain (masterVol)": synth.out.gain.value,
      "rev.gain (reverbLev*8)": synth.rev ? synth.rev.gain.value : null,
      "chvol[0].gain": synth.chvol[0].gain.value,
      "vol[0]": synth.vol[0], "brange[0]": synth.brange[0], "bend[0]": synth.bend[0], "pg[0]": synth.pg[0],
      "rhythm (channels)": synth.rhythm.map((x, i) => (x ? i : -1)).filter((i) => i >= 0),
      "lfo.frequency": synth.lfo.frequency.value, releaseRatio: synth.releaseRatio, preroll: synth.preroll,
    },
    intervalsAfterConstruction: c.intervals(),
    nodesCreatedByConstructor: { default: createdKinds(c.ctorTrace), useReverb0: createdKinds(construct(build, { useReverb: 0 }).ctorTrace) },
    rendersOnConstruction: c.ctorTrace.filter((x) => x.startsWith('["start"')).length,
  };
}

function detached(build) {
  const { synth, env, notes } = H.createSynth(C.source(build), build + " detached");
  const res = {};
  const { noteOn, noteOff, send, setProgram, getPlayStatus, loadMIDI, playMIDI, stopMIDI, setQuality, setMasterVol, setTimbre, getTimbreName } = synth;
  const n0 = synth.notetab.length;
  try { noteOn(0, 60, 100); res["noteOn(0,60,100) detached"] = { ok: true, notetabGrewBy: synth.notetab.length - n0, noteCalls: notes.length }; }
  catch (e) { res["noteOn(0,60,100) detached"] = { ok: false, error: e.message }; }
  try { noteOff(0, 60); res["noteOff(0,60) detached"] = { ok: true, releasedFlag: synth.notetab[synth.notetab.length - 1].f }; }
  catch (e) { res["noteOff detached"] = { ok: false, error: e.message }; }
  try { send([0x91, 64, 90]); res["send([0x91,64,90]) detached"] = { ok: true, noteCalls: notes.length }; }
  catch (e) { res["send detached"] = { ok: false, error: e.message }; }
  try { setProgram(2, 5); res["setProgram(2,5) detached"] = { ok: synth.pg[2] === 5 }; } catch (e) { res["setProgram detached"] = { ok: false, error: e.message }; }
  try { setMasterVol(0.25); res["setMasterVol(0.25) detached"] = { ok: synth.out.gain.value === 0.25 }; } catch (e) { res["setMasterVol detached"] = { ok: false, error: e.message }; }
  try { setQuality(0); res["setQuality(0) detached"] = { ok: synth.quality === 0 && synth.program[0].p === synth.program0[0] }; } catch (e) { res["setQuality detached"] = { ok: false, error: e.message }; }
  try { res["getTimbreName(1,35) detached"] = { ok: true, value: getTimbreName(1, 35) }; } catch (e) { res["getTimbreName detached"] = { ok: false, error: e.message }; }
  try {
    loadMIDI(H.toArrayBuffer(H.makeMidi(480, [H.midi.noteOn(0, 0, 60, 100), H.midi.noteOff(480, 0, 60)])));
    playMIDI();
    const st = getPlayStatus();
    stopMIDI();
    res["loadMIDI/playMIDI/getPlayStatus/stopMIDI detached"] = { ok: st.play === 1 && getPlayStatus().play === 0, statusWhilePlaying: st };
  } catch (e) { res["transport detached"] = { ok: false, error: e.message }; }
  try {
    const p = [{ w: "square", v: 0.2 }];
    setTimbre(0, 3, p);
    res["setTimbre(0,3,p) detached"] = { ok: synth.program[3].p === p };
  } catch (e) { res["setTimbre detached"] = { ok: false, error: e.message }; }
  // ready() resolves on its own 100 ms polling interval.
  let resolved = false;
  synth.ready().then(() => { resolved = true; });
  H.runUntil(env, () => false, 200);
  return Promise.resolve().then(() => { res["ready() resolves after stepping 200 ms of mock time"] = { ok: resolved }; return res; });
}

function quality(build) {
  const { synth } = H.createSynth(C.source(build), build + " quality");
  const r = {};
  const q1ProgFromP1 = synth.program.filter((x, i) => synth.program1[i] && x.p === synth.program1[i]).length;
  const q1DrumFromD1 = synth.drummap.filter((x, i) => synth.drummap1[i] && x.p === synth.drummap1[i]).length;
  const q1DrumFromD0 = synth.drummap.filter((x, i) => x.p === synth.drummap0[i]).length;
  r.afterConstruction = { quality: synth.quality, programsFromProgram1: q1ProgFromP1, drumsFromDrummap1: q1DrumFromD1, drumsFromDrummap0: q1DrumFromD0 };
  synth.setQuality(0);
  r.afterSetQuality0 = {
    quality: synth.quality,
    programsFromProgram0: synth.program.filter((x, i) => x.p === synth.program0[i]).length,
    drumsFromDrummap0: synth.drummap.filter((x, i) => x.p === synth.drummap0[i]).length,
  };
  const custom = [{ w: "square", v: 0.2 }];
  const customDrum = [{ w: "n0", v: 0.3, t: 0, f: 440 }];
  synth.setTimbre(0, 5, custom);
  synth.setTimbre(1, 40, customDrum);
  r.setTimbreKeepsCallerArray = synth.program[5].p === custom && synth.drummap[5].p === customDrum;
  r.setTimbreFillsDefaultsIntoCallerObject = Object.keys(custom[0]).sort();
  synth.setQuality(1);
  r.afterSetQuality1_customProgram5Kept = synth.program[5].p === custom;
  r.afterSetQuality1_customDrum40Kept = synth.drummap[5].p === customDrum;
  synth.setTimbre(0, 5, custom);
  synth.setQuality(0);
  r.afterSetQuality0_customProgram5Kept = synth.program[5].p === custom;
  synth.setQuality("0");
  r["setQuality('0') installs"] = { quality: synth.quality, program0IsProgram1: synth.program[0].p === synth.program1[0] };
  synth.setQuality(2);
  r["setQuality(2) installs"] = { quality: synth.quality, program0IsProgram1: synth.program[0].p === synth.program1[0] };
  const before = synth.program.map((x) => x.p);
  synth.setTimbre(0, 128, custom); synth.setTimbre(1, 34, custom); synth.setTimbre(1, 82, custom);
  r.outOfRangeSetTimbreIsNoOp = synth.program.every((x, i) => x.p === before[i]) && synth.drummap.every((x) => x.p !== custom);
  return r;
}

/* ---------- export paths ---------- */

function exportsCheck(build) {
  const out = {};
  // Classic script / global.
  {
    const env = H.createEnvironment([]);
    vm.runInContext(C.source(build), env.sandbox);
    out.global = { type: typeof env.sandbox.WebAudioTinySynth };
  }
  // AMD.
  {
    const env = H.createEnvironment([]);
    let captured, calls = 0;
    env.sandbox.define = function (f) { ++calls; captured = f(); };
    env.sandbox.define.amd = {};
    vm.runInContext(C.source(build), env.sandbox);
    let constructed = false;
    try { constructed = !!new captured(); } catch (e) { constructed = "threw: " + e.message; }
    out.amd = { defineCalls: calls, factoryReturns: typeof captured, globalAlsoSet: typeof env.sandbox.WebAudioTinySynth, constructed };
  }
  // CommonJS (real Node require; AudioContext provided as a global mock).
  {
    const env = H.createEnvironment([]);
    const prev = globalThis.AudioContext;
    globalThis.AudioContext = env.sandbox.AudioContext;
    const file = path.join(C.ROOT, build);
    delete require.cache[file];
    const X = require(file);
    let constructed = false;
    try { const s = new X(); constructed = typeof s.noteOn === "function"; } catch (e) { constructed = "threw: " + e.message; }
    out.commonjs = { exportType: typeof X, sameAsName: X && X.name, globalLeak: typeof globalThis.WebAudioTinySynth, constructed };
    globalThis.AudioContext = prev;
  }
  // Top-level `this` undefined (as in native ESM), with and without module/exports.
  for (const withCjs of [true, false]) {
    const env = H.createEnvironment([]);
    if (withCjs) { env.sandbox.module = { exports: {} }; env.sandbox.exports = env.sandbox.module.exports; }
    let load = "ok", ctor = null;
    try {
      vm.runInContext("(function(){\"use strict\";\n" + C.source(build) + "\n}).call(undefined)", env.sandbox);
    } catch (e) { load = "threw: " + e.message; }
    if (load === "ok" && withCjs) {
      try { new env.sandbox.module.exports(); ctor = "ok"; } catch (e) { ctor = "threw: " + e.message; }
    }
    out[withCjs ? "thisUndefinedWithModuleExports" : "thisUndefinedNoModule"] = { load, construct: ctor };
  }
  return out;
}

/* ---------- README defaults ---------- */

function readmeDefaults(synth) {
  const readme = fs.readFileSync(path.join(C.ROOT, "README.md"), "utf8");
  const rows = {};
  for (const m of readme.matchAll(/^\|\*\*(\w+)\*\*\s*\|\s*([^|]+?)\s*\|/gm)) rows[m[1]] = m[2];
  const out = {};
  for (const [k, v] of Object.entries(rows)) {
    if (!(k in synth.properties)) continue;
    const code = synth.properties[k].value;
    out[k] = { readme: v, code, match: String(code) === v.trim() };
  }
  out._propertiesNotInReadmeTable = Object.keys(synth.properties).filter((k) => !(k in rows));
  return out;
}

/* ---------- main ---------- */

(async () => {
  const result = { header: C.header("inventory"), builds: {} };
  for (const build of C.BUILDS) {
    const t = timbreHashes(build);
    const b = {
      timbreHashes: t.hashes,
      surface: surface(build),
      detached: await detached(build),
      quality: quality(build),
      exports: exportsCheck(build),
    };
    if (build === C.BUILDS[0]) {
      result.timbreStatsRaw = tableStats(t.raw);
      result.timbreStatsFilled = tableStats(t.filled);
      result.builtinValuesOutsideConsumerRanges = outsideConsumerRanges(t.raw);
      result.readmeDefaults = readmeDefaults(H.createSynth(C.source(build), "readme").synth);
      result.testReliedMembers = testReliedMembers();
      result.canonicalization = "sha256 over UTF-8 of JSON with object keys sorted at every level; array holes/undefined/null -> null; numbers per JSON.stringify";
    }
    result.builds[build] = b;
  }
  const [a, b] = C.BUILDS.map((x) => result.builds[x]);
  if (JSON.stringify(a.timbreHashes) !== JSON.stringify(b.timbreHashes)) mismatch.push("timbreHashes");
  if (JSON.stringify(Object.keys(a.surface.methods)) !== JSON.stringify(Object.keys(b.surface.methods))) mismatch.push("methods");
  if (JSON.stringify(a.surface.properties) !== JSON.stringify(b.surface.properties)) mismatch.push("properties");
  result.buildsAgree = mismatch.length === 0;
  result.mismatches = mismatch;
  console.log(JSON.stringify(result, null, 2));
  process.exit(mismatch.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
