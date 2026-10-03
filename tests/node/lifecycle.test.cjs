/*
 * Lifecycle (#11, #12) of both builds in plain Node: the build is loaded with
 * require(), so its interval is a real Node timer and a rejected promise is a
 * real unhandled rejection. The audio context is the harness mock, injected
 * with the `context` option (no global AudioContext exists here).
 *
 *   - dispose() clears every timer: the process exits by itself. Without
 *     dispose() the 60 ms interval keeps it running (the baseline had no way
 *     to stop it).
 *   - send() on a suspended context whose resume() rejects causes no
 *     unhandled rejection, which would end the process with an error.
 *   - Source and minified builds make the same calls through a lifecycle.
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

/* Run `body` in a child Node process with `Synth` (the build, from require()) and `ctx` (a mock context) defined. */
function child(build, body, timeout = DEADLINE_MS) {
  const code = [
    "const H = require(" + JSON.stringify(path.join(H.ROOT, "tests", "harness.js")) + ");",
    "const Synth = require(" + JSON.stringify(path.join(H.ROOT, build.name)) + ");",
    "const Ctx = H.createEnvironment([]).sandbox.AudioContext;",
    "const ctx = new Ctx();",
    body,
  ].join("\n");
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout, killSignal: "SIGKILL" });
  return { status: r.status, signal: r.signal, out: r.stdout + r.stderr };
}

for (const build of builds) {
  test.describe(build.name + " under Node", () => {
    test("dispose() clears the interval and ready() polls: the process exits by itself", () => {
      const r = child(build, [
        "const synth = new Synth({ context: ctx });",
        "synth.noteOn(0, 60, 100); synth.noteOn(9, 38, 100, 0.5);",
        "synth.ready().then(() => console.log('ready resolved'));",
        "synth.dispose().then(() => console.log('disposed', ctx.state));",
      ].join("\n"));
      assert.deepEqual([r.status, r.signal], [0, null], r.out);
      assert.match(r.out, /ready resolved\ndisposed running\n/);
    });

    test("without dispose() the interval keeps the process running (control)", () => {
      const r = child(build, "new Synth({ context: ctx }); console.log('constructed');", 1500);
      assert.equal(r.signal, "SIGKILL", r.out);
      assert.match(r.out, /constructed/);
    });

    test("a lazy synth that is never started exits after dispose()", () => {
      const r = child(build, "const synth = new Synth({ lazy: true }); synth.setMasterVol(0.2); synth.dispose().then(() => console.log('disposed'));");
      assert.deepEqual([r.status, r.signal], [0, null], r.out);
      assert.match(r.out, /disposed/);
    });

    test("send() on a suspended context whose resume() rejects: no unhandled rejection", () => {
      const r = child(build, [
        "ctx.state = 'suspended';",
        "let asked = 0;",
        "ctx.resume = () => { ++asked; return Promise.reject(new Error('blocked')); };",
        "const synth = new Synth({ context: ctx });",
        "const bytes = H.makeMidi(480, [0, 1, 2, 3].flatMap((ch) => [{ tick: 0, bytes: [0xc0 | ch, 5] }, { tick: 0, bytes: [0xb0 | ch, 7, 90] }]).concat([H.midi.noteOn(960, 0, 60, 100)]));",
        "setTimeout(() => { synth.loadMIDI(H.toArrayBuffer(bytes)); synth.locateMIDI(960); }, 0);",
        "setTimeout(() => { synth.send([0x90, 60, 100]); }, 10);",
        "setTimeout(() => synth.resume().catch((e) => console.log('resume rejected:', e.message)), 20);",
        "setTimeout(() => synth.dispose().then(() => console.log('asked', asked)), 40);",
      ].join("\n"));
      assert.deepEqual([r.status, r.signal], [0, null], r.out);
      // Asked by the construction's warm-up note, the seek (once for its 8 events), the later send(), and resume().
      assert.match(r.out, /resume rejected: blocked\nasked 4\n/);
    });
  });
}

/* WebAudio calls and states of a lifecycle: lazy start, play, replacement, scheduled drums, stop, dispose. */
function lifecycle(variant) {
  const trace = [];
  const env = H.createEnvironment(trace);
  vm.runInContext(variant.source, env.sandbox, { filename: variant.name });
  const synth = new env.sandbox.WebAudioTinySynth({ lazy: true });
  const states = [];
  const note = (tick, ch, n) => [H.midi.noteOn(tick, ch, n, 100), H.midi.noteOff(tick + 200, ch, n)];
  synth.resume();
  synth.loadMIDI(H.toArrayBuffer(H.makeMidi(480, [...note(0, 0, 60), ...note(480, 1, 64), { tick: 600, bytes: [0x99, 38, 100] }, ...note(960, 0, 67)])));
  synth.playMIDI();
  H.runUntil(env, () => false, 700);
  const next = new env.sandbox.AudioContext();
  synth.setAudioContext(next);
  synth.noteOn(9, 49, 100, next.currentTime + 1);
  synth.playMIDI();
  H.runUntil(env, () => false, 300);
  synth.stopMIDI();
  states.push({ ...synth.getPlayStatus() }, synth._src.length, synth.notetab.length);
  const p = synth.dispose();
  states.push(synth.dispose() === p, synth.getAudioContext(), next.state, env.timers.size);
  return { trace, states };
}

test("the minified build makes the same calls as the source through a lifecycle", () => {
  const [source, minified] = builds.map(lifecycle);
  assert.ok(source.trace.length > 500, "the lifecycle made few calls");
  assert.deepEqual(minified.states, source.states);
  assert.deepEqual(minified.trace, source.trace);
});

test("both builds have resume() and dispose(), detached-safe", async () => {
  for (const variant of builds) {
    const env = H.createEnvironment([]);
    vm.runInContext(variant.source, env.sandbox, { filename: variant.name });
    const { resume, dispose } = new env.sandbox.WebAudioTinySynth({ context: new env.sandbox.AudioContext() });
    assert.equal(await resume(), undefined);
    assert.equal(await dispose(), undefined);
    await assert.rejects(resume(), (e) => e.code === "SYNTH_DISPOSED");
  }
});
