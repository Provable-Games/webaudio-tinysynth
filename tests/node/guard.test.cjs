/*
 * T5.2 (#13 follow-up, tasks/T5.2.md) in plain Node, for both builds.
 *
 *   - loadMIDIUrl() with an opts.signal getter that throws: the build runs in
 *     a child process loaded with require(), so its promises are real Node
 *     promises. The call returns a promise that rejects with the getter's
 *     error; ignored, it causes no unhandled rejection (a control rejection
 *     made on purpose is seen).
 *   - One scenario for every item (times finite as float32 in setTimbre,
 *     notes whose values overflow, tsmode times before the context started,
 *     an empty array-like SysEx) gives the same errors and the same WebAudio
 *     trace in the source and minified builds, and that trace holds no value
 *     outside float32 and no negative time.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const vm = require("node:vm");
const H = require("../harness");

const DEADLINE_MS = 20000;
const builds = H.forkVariants();

/* Run `body` in a child Node process with `Synth` (the build, from require()), `ctx` (a mock context), `reqs` and `seen` (unhandled rejections). */
function child(build, body) {
  const code = [
    "const H = require(" + JSON.stringify(path.join(H.ROOT, "tests", "harness.js")) + ");",
    "const Synth = require(" + JSON.stringify(build.file) + ");",
    "const ctx = new (H.createEnvironment([]).sandbox.AudioContext)();",
    "const reqs = [], seen = [];",
    "globalThis.XMLHttpRequest = class { constructor() { reqs.push(this); } open(m, u) { this.url = u; } send() {} abort() {} };",
    "process.on('unhandledRejection', (e) => seen.push(e && e.message ? e.message : String(e)));",
    "const synth = new Synth({ context: ctx });",
    "const opts = { get signal() { throw new Error('getter'); } };",
    body,
  ].join("\n");
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: DEADLINE_MS, killSignal: "SIGKILL" });
  return { status: r.status, signal: r.signal, out: r.stdout + r.stderr };
}

for (const build of builds) {
  test.describe(build.name + ": loadMIDIUrl with a throwing opts.signal getter (T5.2)", () => {
    test("returns a promise that rejects with the getter's error, and sends nothing", () => {
      const r = child(build, [
        "let p, sync = null;",
        "try { p = synth.loadMIDIUrl('a.mid', opts); } catch (e) { sync = e.message; }",
        "p.then(() => console.log('resolved'), (e) => setTimeout(() => console.log('rejected ' + JSON.stringify([e.message, sync, reqs.length, seen])), 50)).finally(() => synth.dispose());",
      ].join("\n"));
      assert.deepEqual([r.status, r.signal], [0, null], r.out);
      assert.match(r.out, /^rejected \["getter",null,0,\[\]\]$/m);
    });

    test("ignored, it causes no unhandled rejection (control: one made on purpose is seen)", () => {
      const r = child(build, [
        "synth.loadMIDIUrl('a.mid', opts);",
        "Promise.reject(new Error('control'));",
        "setTimeout(() => { console.log('seen ' + JSON.stringify(seen)); synth.dispose(); }, 50);",
      ].join("\n"));
      assert.deepEqual([r.status, r.signal], [0, null], r.out);
      assert.match(r.out, /^seen \["control"\]$/m);
    });
  });
}

test("source and minified builds: the same errors and WebAudio trace for every T5.2 item, with only float32 values and no negative times", () => {
  const run = (build) => {
    const trace = [];
    const env = H.createEnvironment(trace);
    env.sandbox.performance = { now: () => env.clock.ms + 5000 }; // the context started 5 s after the page
    vm.runInContext(build.source, env.sandbox, { filename: build.name });
    const synth = new env.sandbox.WebAudioTinySynth({ quality: 1, lazy: true });
    const errors = [];
    const attempt = (fn) => {
      try {
        fn();
        errors.push("ok");
      } catch (e) {
        errors.push(e.name + ": " + e.message);
      }
    };
    for (const k of ["a", "h", "d", "r", "q"]) attempt(() => synth.setTimbre(0, 5, [{}, { g: 1, [k]: 1e39 }]));
    attempt(() => synth.send({ 0: 0xf0, length: 0 }));
    const lazy = synth.getAudioContext();
    synth.setTimbre(0, 5, [{}, ...Array.from({ length: 10 }, (_, i) => ({ g: i + 1, t: 1e4, v: 1 }))]);
    synth.setTimbre(0, 6, [{ k: 30 }]);
    synth.setTimbre(0, 7, [{}, { g: 1, v: 1e37 }]);
    synth.setTimbre(1, 38, [{ w: "n0", t: 1e40 }]);
    H.runUntil(env, () => false, 1000);
    synth.setProgram(0, 0); // the first use: the context starts now, 1.02 s on
    const mark = trace.length;
    synth.setTsMode(1);
    for (const [ch, prog, note, t] of [[0, 5, 60, 1], [1, 6, 127, 1], [1, 6, 60, 1], [2, 7, 60, 4000], [3, 0, 64, 1]]) {
      attempt(() => synth.setProgram(ch, prog));
      attempt(() => synth.noteOn(ch, note, 100, t));
    }
    attempt(() => synth.noteOn(9, 38, 100, 1));
    attempt(() => synth.noteOn(9, 36, 100, 1));
    attempt(() => synth.noteOff(3, 64, 1));
    attempt(() => synth.setBend(3, 9000, 1));
    attempt(() => synth.send([0xb0 | 3, 7, 90], 1));
    H.runUntil(env, () => false, 2000);
    return { errors, lazy, trace, mark };
  };
  const [src, min] = builds.map(run);
  assert.equal(src.lazy, null); // the empty SysEx created no context
  assert.deepEqual(src.errors.slice(0, 5), ["a", "h", "d", "r", "q"].map((k) => "RangeError: operator 1 " + k + " out of range: 1e+39"));
  assert.ok(src.errors.slice(5).every((e) => e === "ok"), src.errors.join("\n"));
  assert.deepEqual(min.errors, src.errors);
  assert.deepEqual(min.trace, src.trace);
  const parsed = src.trace.map((l) => JSON.parse(l));
  const starts = parsed.slice(src.mark).filter((c) => c[0] === "start");
  assert.ok(starts.length >= 3, "the notes that fit played: " + starts.length); // note 60 on program 6, program 0, drum 36
  const f32 = (v) => typeof v === "number" && Number.isFinite(Math.fround(v));
  for (const c of parsed) {
    if (c[0] === "value" || /^(setValueAtTime|linearRamp|expRamp|setTargetAtTime)$/.test(c[0])) assert.ok(f32(c[2]), "value " + JSON.stringify(c));
    if (c[0] === "setTargetAtTime") assert.ok(f32(c[4]) && c[4] >= 0, "time constant " + JSON.stringify(c));
    const t = c[0] === "start" || c[0] === "stop" || c[0] === "cancel" ? c[2] : /^(setValueAtTime|linearRamp|expRamp|setTargetAtTime)$/.test(c[0]) ? c[3] : 0;
    assert.ok(t === null || (Number.isFinite(t) && t >= 0), "time " + JSON.stringify(c));
  }
  assert.ok(starts.every((c) => c[2] === 1.02), "tsmode times are clamped at currentTime: " + JSON.stringify(starts));
});
