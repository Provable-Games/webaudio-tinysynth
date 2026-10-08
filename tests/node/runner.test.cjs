/*
 * Subprocess behavior that the test commands rely on: the regression runner
 * and the deadline wrapper propagate failures, crashes and timeouts, and
 * kill hung processes; the regression scripts fail descriptively when the
 * upstream reference is missing or wrong.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const H = require("../harness");

const RUNNER = path.join(H.ROOT, "scripts", "run-regressions.js");
const NODE_RUNNER = path.join(H.ROOT, "scripts", "run-node-tests.js");
const DEADLINE = path.join(H.ROOT, "scripts", "run-with-deadline.js");
const fixture = (name) => path.join(__dirname, "fixtures", name);

/* Run `node args...` with an outer deadline well above the deadlines under test. */
function node(args, env) {
  const r = spawnSync(process.execPath, args, {
    cwd: H.ROOT, encoding: "utf8", timeout: 60000, killSignal: "SIGKILL",
    env: Object.assign({}, process.env, env),
  });
  assert.equal(r.error, undefined, "child did not finish: " + (r.error && r.error.message));
  return { status: r.status, out: r.stdout + r.stderr };
}

/* True while `pid` exists and is not a zombie. */
function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return fs.readFileSync("/proc/" + pid + "/stat", "utf8").split(") ").pop()[0] !== "Z";
  } catch {
    return true;
  }
}

test.describe("regression runner", () => {
  test("passes when every script passes", () => {
    const r = node([RUNNER, fixture("pass.cjs"), fixture("pass.cjs")]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /2 of 2 scripts passed/);
  });

  test("passes the arguments given with a script", () => {
    const r = node([RUNNER, fixture("pass.cjs") + " one two"]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /PASS: fixture one two/);
  });

  test("fails a script that exits 0 before its final PASS line", () => {
    const r = node([RUNNER, fixture("exit-early.cjs"), fixture("pass.cjs")]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /FAILED .*exit-early\.cjs: exited 0 without a final "PASS:" line/);
    assert.match(r.out, /1 of 2 scripts passed/);
  });

  test("fails a script that does not exist", () => {
    const r = node([RUNNER, fixture("no-such-script.cjs")]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /Cannot find module/);
  });

  test("fails on a failing script and still runs the rest", () => {
    const r = node([RUNNER, fixture("fail.cjs"), fixture("pass.cjs")]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /FAIL: fixture assertion/);
    assert.match(r.out, /PASS: fixture/);
    assert.match(r.out, /FAILED .*fail\.cjs: exited with status 1/);
  });

  test("fails on an uncaught error", () => {
    const r = node([RUNNER, fixture("throw.cjs")]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /Error: fixture error/);
  });

  test("kills a hung script at the deadline and fails", () => {
    const started = Date.now();
    const r = node([RUNNER, "--deadline=1", fixture("hang.cjs"), fixture("pass.cjs")]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /FAILED .*hang\.cjs: timed out after 1 s/);
    assert.match(r.out, /1 of 2 scripts passed/);
    assert.ok(Date.now() - started < 20000, "the runner did not stop the hung script promptly");
  });

  test("kills the processes a hung script started", async () => {
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tinysynth-runner-")), "pid");
    try {
      const r = node([RUNNER, "--deadline=2", fixture("spawn-hang.cjs")], { PIDFILE: pidFile });
      assert.equal(r.status, 1, r.out);
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      for (let i = 0; i < 50 && alive(pid); ++i) await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(alive(pid), false, "grandchild " + pid + " survived");
    } finally {
      fs.rmSync(path.dirname(pidFile), { recursive: true, force: true });
    }
  });
});

test.describe("native test runner", () => {
  const suite = (name) => path.relative(H.ROOT, path.join(__dirname, "fixtures", "suites", name));

  test("passes when every file runs its tests", () => {
    const r = node([NODE_RUNNER, "--min-files=1", "--min-tests=2", suite("ok.cjs")]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /1 file\(s\), 2 test\(s\) passed/);
  });

  test("fails when no test file matches", () => {
    const r = node([NODE_RUNNER, suite("no-such-dir/**/*.test.cjs")]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /FAIL: no test files match/);
  });

  for (const [file, message] of [
    ["exit-in-test.cjs", /exit-in-test\.cjs passed no tests/],
    ["exit-at-load.cjs", /exit-at-load\.cjs passed no tests/],
    ["exit-between.cjs", /exit-between\.cjs: 2 test\(s\) started but never finished/],
  ]) {
    test("fails a file that calls process.exit(0) early: " + file, () => {
      const r = node([NODE_RUNNER, suite(file), suite("ok.cjs")]);
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, message);
    });
  }

  test("fails below the committed floors", () => {
    const tests = node([NODE_RUNNER, "--min-tests=3", suite("ok.cjs")]);
    assert.equal(tests.status, 1, tests.out);
    assert.match(tests.out, /2 test\(s\) passed, fewer than the committed floor of 3/);
    const files = node([NODE_RUNNER, "--min-files=2", suite("ok.cjs")]);
    assert.equal(files.status, 1, files.out);
    assert.match(files.out, /1 test file\(s\) ran, fewer than the committed floor of 2/);
  });
});

test.describe("deadline wrapper", () => {
  test("passes the command's exit status through", () => {
    assert.equal(node([DEADLINE, "10", "node", "-e", "process.exit(3)"]).status, 3);
    assert.equal(node([DEADLINE, "10", "node", fixture("pass.cjs")]).status, 0);
  });

  test("fails with status 124 when the deadline passes", () => {
    const r = node([DEADLINE, "1", "node", fixture("hang.cjs")]);
    assert.equal(r.status, 124, r.out);
    assert.match(r.out, /timed out after 1 s/);
  });
});

test.describe("upstream reference", () => {
  test("is readable and verified in this checkout (needs full history)", () => {
    const r = node(["-e", "require('./tests/harness').upstreamSource()"], { TINYSYNTH_REFERENCE: "" });
    assert.equal(r.status, 0, r.out);
  });

  test("a missing TINYSYNTH_REFERENCE file fails descriptively", () => {
    const missing = path.join(os.tmpdir(), "tinysynth-no-such-reference.js");
    const r = node([path.join(H.ROOT, "tests", "tempo.js")], { TINYSYNTH_REFERENCE: missing });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /FAIL: cannot read TINYSYNTH_REFERENCE=.*tinysynth-no-such-reference\.js \(ENOENT/);
  });

  test("a modified TINYSYNTH_REFERENCE file is rejected", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tinysynth-ref-"));
    try {
      const file = path.join(dir, "webaudio-tinysynth.js");
      fs.writeFileSync(file, H.upstreamSource() + "\n");
      const r = node([path.join(H.ROOT, "tests", "tempo.js")], { TINYSYNTH_REFERENCE: file });
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, new RegExp("FAIL: upstream reference sha256 is [0-9a-f]{64}, expected " + H.UPSTREAM_SHA256));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
