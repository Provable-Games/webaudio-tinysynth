/*
 * Seeded built-in buffers (#7, D-004) across loads: each build is loaded with
 * require() in a fresh Node process whose global Math.random throws, and
 * synths are built on the harness's mock context at 44.1 and 48 kHz (no
 * global AudioContext exists here). Every load must produce the seeded
 * expectations (tests/browser/specs/seed-expected.js) and never call
 * Math.random.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const H = require("../harness");
const { SEED_EXPECTED: E } = require("../browser/specs/seed-expected.js");

const DEADLINE_MS = 30000;
const builds = H.forkVariants();

/* One load of `build` in a child process: {"<sr>/<seed>": {seed, bufferVersion, convBuf, n0, n1}} for the default seed and 0xffffffff. */
function load(build) {
  const code = [
    "Math.random = () => { throw new Error('Math.random called'); };",
    "const crypto = require('crypto');",
    "const H = require(" + JSON.stringify(path.join(H.ROOT, "tests", "harness.js")) + ");",
    "const Synth = require(" + JSON.stringify(path.join(H.ROOT, build.name)) + ");",
    "const Ctx = H.createEnvironment([]).sandbox.AudioContext;",
    "const sha = (buf) => {",
    "  const h = crypto.createHash('sha256');",
    "  for (let c = 0; c < buf.numberOfChannels; ++c) { const d = buf.getChannelData(c); h.update(Buffer.from(d.buffer, d.byteOffset, d.byteLength)); }",
    "  return h.digest('hex');",
    "};",
    "const out = {};",
    "for (const sr of [44100, 48000]) for (const seed of [undefined, 0xffffffff]) {",
    "  const context = Object.assign(new Ctx(), { sampleRate: sr });",
    "  const synth = new Synth(seed === undefined ? { context } : { context, seed });",
    "  synth.noteOn(9, 42, 100, 0);",
    "  out[sr + '/' + (seed === undefined ? 'default' : seed)] = { seed: synth.seed, bufferVersion: synth.bufferVersion,",
    "    convBuf: sha(synth.convBuf), n0: sha(synth.noiseBuf.n0), n1: sha(synth.noiseBuf.n1) };",
    "  synth.dispose();",
    "}",
    "console.log(JSON.stringify(out));",
  ].join("\n");
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: DEADLINE_MS, killSignal: "SIGKILL" });
  assert.deepEqual([r.status, r.signal], [0, null], r.stdout + r.stderr);
  return JSON.parse(r.stdout);
}

for (const build of builds) {
  test.describe(build.name + " under Node", () => {
    test("two loads in fresh processes give the seeded expectations, without Math.random", () => {
      const first = load(build), second = load(build);
      assert.deepEqual(second, first);
      for (const sr of [44100, 48000]) {
        for (const [key, seed] of [["default", E.defaultSeed], [String(0xffffffff), 0xffffffff]]) {
          const got = first[sr + "/" + key];
          assert.deepEqual([got.seed, got.bufferVersion], [seed, E.bufferVersion], sr + "/" + key);
          assert.deepEqual({ convBuf: got.convBuf, n0: got.n0, n1: got.n1 }, E.hashes[sr][seed], sr + "/" + key);
        }
      }
    });
  });
}
