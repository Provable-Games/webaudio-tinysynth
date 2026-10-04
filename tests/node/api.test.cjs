/*
 * API contracts (#13, #14) of both builds in plain Node (T5).
 *
 *   - Fire-and-forget loadMIDIUrl() calls that reject in every documented way
 *     cause no unhandled rejection. The build runs in a child process loaded
 *     with require(), so its promises are real Node promises; the child counts
 *     unhandled rejections and makes one on purpose as a control.
 *   - The same calls reject observably when the caller handles them.
 *   - Source and minified builds reject the same misuse with the same errors
 *     and install the same timbres.
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

/*
 * Run `body` in a child Node process with `Synth` (the build, from require()),
 * `ctx` (a mock context), `reqs` (the mock XMLHttpRequests made so far, each
 * answered by the body) and `seen` (the reasons of unhandled rejections).
 */
function child(build, body) {
  const code = [
    "const H = require(" + JSON.stringify(path.join(H.ROOT, "tests", "harness.js")) + ");",
    "const Synth = require(" + JSON.stringify(build.file) + ");",
    "const ctx = new (H.createEnvironment([]).sandbox.AudioContext)();",
    "const reqs = [], seen = [];",
    "globalThis.XMLHttpRequest = class { constructor() { reqs.push(this); } open(m, u) { this.url = u; } send() {} abort() { if (this.onabort) this.onabort(); } };",
    "const answer = (r, status, body) => { r.status = status; r.response = body; r.onload(); };",
    "process.on('unhandledRejection', (e) => seen.push(e && e.message ? e.message : String(e)));",
    body,
  ].join("\n");
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: DEADLINE_MS, killSignal: "SIGKILL" });
  return { status: r.status, signal: r.signal, out: r.stdout + r.stderr };
}

/* Every way a load can fail, started with `start(url, opts)`; ends by disposing the synth. */
const FAILURES = [
  "const synth = new Synth({ context: ctx });",
  "start();", // no url: TypeError
  "start('a.mid');", // superseded by b.mid: LOAD_SUPERSEDED
  "start('b.mid'); answer(reqs[1], 404, new ArrayBuffer(0));", // HTTP_STATUS
  "start('c.mid'); answer(reqs[2], 200, new ArrayBuffer(3));", // SMF_INVALID_HEADER
  "start('d.mid'); reqs[3].onerror();", // NETWORK_ERROR
  "const ac = new AbortController(); start('e.mid', { signal: ac.signal }); ac.abort();", // AbortError
  "const ac0 = new AbortController(); start('e0.mid', { signal: ac0.signal }); ac0.abort(0);", // a falsy reason: AbortError (review F3)
  "start('f.mid', { signal: {} });", // TypeError: not an AbortSignal
  "start('g.mid');", // pending at dispose(): SYNTH_DISPOSED
  "synth.dispose().then(() => {",
  "  start('h.mid');", // after dispose(): SYNTH_DISPOSED
  "  setTimeout(() => console.log('seen ' + JSON.stringify(seen)), 50);",
  "});",
].join("\n");

for (const build of builds) {
  test.describe(build.name + ": loadMIDIUrl under Node (#14)", () => {
    test("ignored rejections of every kind cause no unhandled rejection (control: one made on purpose is seen)", () => {
      const r = child(build, [
        "const start = (u, o) => synth.loadMIDIUrl(u, o);",
        FAILURES,
        "Promise.reject(new Error('control'));",
      ].join("\n"));
      assert.deepEqual([r.status, r.signal], [0, null], r.out);
      assert.match(r.out, /^seen \["control"\]$/m);
    });

    test("the same calls reject observably when handled", () => {
      const r = child(build, [
        "const got = [];",
        "const start = (u, o) => synth.loadMIDIUrl(u, o).then(() => got.push('resolved'), (e) => got.push(typeof e.code === 'string' ? e.code : e.name));", // a DOMException's code is a number
        FAILURES.replace("console.log('seen ' + JSON.stringify(seen))", "console.log('got ' + JSON.stringify(got) + ' seen ' + JSON.stringify(seen))"),
      ].join("\n"));
      assert.deepEqual([r.status, r.signal], [0, null], r.out);
      const got = JSON.parse(/^got (\[.*\]) seen/m.exec(r.out)[1]);
      assert.deepEqual(got.slice().sort(), ["AbortError", "AbortError", "HTTP_STATUS", "LOAD_SUPERSEDED", "NETWORK_ERROR", "SMF_INVALID_HEADER", "SYNTH_DISPOSED",
        "SYNTH_DISPOSED", "TypeError", "TypeError"]);
      assert.match(r.out, /seen \[\]$/m);
    });
  });
}

test("source and minified builds reject misuse with the same errors and install the same timbres (#13)", () => {
  const CALLS = [
    ["noteOn", [16, 60, 100]], ["noteOn", [0, 60.5, 100]], ["noteOn", [0, 60, "x"]], ["noteOn", [0, 60, 100, -1]], ["noteOff", [0, null]],
    ["setProgram", [0, 128]], ["setBend", [0, 16384]], ["setChVol", [0, Infinity]], ["setPan", [{}, 64]], ["setQuality", [2]],
    ["setVoices", [0]], ["setLoopEnd", [-480]], ["setMasterVol", [-1]], ["setReverbLev", [""]], ["send", [42]], ["send", [[0x90, 60, 100], NaN]],
    ["getTimbreName", [1, 34]], ["setTimbre", [0, 0, [{ w: "saw" }]]], ["setTimbre", [0, 0, [{ g: 1 }]]], ["setTimbre", [0, 0, [{}, { g: 2 }]]],
    ["setTimbre", [0, 0, [{ d: -1 }]]], ["setTimbre", [0, 0, []]], ["setTimbre", [0, 0, [null]]],
  ];
  const run = (build) => {
    const env = H.createEnvironment([]);
    vm.runInContext(build.source, env.sandbox, { filename: build.name });
    const synth = new env.sandbox.WebAudioTinySynth({ lazy: true });
    const errors = CALLS.map(([m, args]) => {
      try {
        synth[m](...args);
        return "accepted";
      } catch (e) {
        return e.name + ": " + e.message;
      }
    });
    synth.setTimbre(0, 5, [{ w: "square", v: "0.4" }, { g: 1, t: 2, v: 30, b: 0, c: 0 }]);
    synth.setTimbre(1, 38, [{ w: "n0", d: 0.05 }]);
    return { errors, timbres: JSON.stringify([synth.program, synth.drummap]), context: synth.getAudioContext() };
  };
  const [src, min] = builds.map(run);
  assert.ok(src.errors.every((e) => /^(TypeError|RangeError): /.test(e)), src.errors.join("\n"));
  assert.deepEqual(min.errors, src.errors);
  assert.equal(min.timbres, src.timbres);
  assert.deepEqual([src.context, min.context], [null, null]); // nothing created a context
});
