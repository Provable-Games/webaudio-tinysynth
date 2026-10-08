#!/usr/bin/env node
/*
 * Runs the native Node tests and fails closed.
 *
 * `node --test` exits 0 when its pattern matches no files, and when a test
 * file calls process.exit(0) early: the tests it did not reach are simply
 * never reported. This runner therefore:
 *   - finds the test files itself and fails if there are none;
 *   - runs `node --test` on them under a deadline (scripts/run-with-deadline.js)
 *     with the spec reporter on stdout and scripts/node-test-events.mjs
 *     recording every test's start and end;
 *   - fails if node --test fails, if any file passed no test, or if any test
 *     or suite was started but never passed or failed;
 *   - fails if fewer than --min-files files ran or fewer than --min-tests tests
 *     passed. The floors are committed in package.json ("test:node"); raise
 *     them when you add tests, so a renamed or deleted test file is noticed.
 * The minified build under test is a fresh build of the current source
 * (scripts/test-build.js), made before the tests start.
 *
 * Usage: node scripts/run-node-tests.js [--min-files=N] [--min-tests=N] [--deadline=SECONDS] [pattern ...]
 *   Default pattern: tests/node/**\/*.test.cjs (relative to the repository root).
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runWithDeadline, describeFailure } = require("./run-with-deadline");
const { prepare } = require("./test-build");

const ROOT = path.resolve(__dirname, "..");
const REPORTER = path.join(__dirname, "node-test-events.mjs");
const PER_TEST_TIMEOUT_MS = 120000;

function parseArgs(argv) {
  const opts = { minFiles: 1, minTests: 1, deadline: 600, patterns: [] };
  for (const arg of argv) {
    const m = /^--(min-files|min-tests|deadline)=(\d+)$/.exec(arg);
    if (m) opts[{ "min-files": "minFiles", "min-tests": "minTests", deadline: "deadline" }[m[1]]] = Number(m[2]);
    else if (!arg.startsWith("--")) opts.patterns.push(arg);
    else throw new Error("unknown option " + arg);
  }
  if (!opts.patterns.length) opts.patterns.push("tests/node/**/*.test.cjs");
  return opts;
}

/* Per-file counts from the reporter's JSON lines. `relative` maps absolute file paths to the names node --test gives them. */
function tally(lines, relative) {
  const files = new Map([...relative.keys()].map((f) => [f, { enqueued: 0, finished: 0, passed: 0, failed: 0 }]));
  for (const line of lines) {
    const ev = JSON.parse(line);
    const stats = files.get(ev.file);
    if (!stats) continue;
    if (ev.nesting === 0 && ev.name === relative.get(ev.file)) continue; // the file itself, not a test in it
    if (ev.type === "test:enqueue") ++stats.enqueued;
    else ++stats.finished;
    if (ev.type === "test:fail") ++stats.failed;
    if (ev.type === "test:pass" && ev.kind === "test" && !ev.skip && !ev.todo) ++stats.passed;
  }
  return files;
}

/* The environment without NODE_TEST_CONTEXT, which node --test sets in its child processes: a nested run must report normally. */
function runnerEnv() {
  const env = Object.assign({}, process.env);
  delete env.NODE_TEST_CONTEXT;
  return env;
}

async function main(argv) {
  const opts = parseArgs(argv);
  const found = [...new Set(opts.patterns.flatMap((p) => fs.globSync(p, { cwd: ROOT })))].sort();
  if (!found.length) {
    console.error("FAIL: no test files match " + opts.patterns.join(" "));
    return 1;
  }
  const relative = new Map(found.map((f) => [path.join(ROOT, f), f]));
  await prepare();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tinysynth-node-tests-"));
  const eventsFile = path.join(tmp, "events.jsonl");
  let result, lines;
  try {
    result = await runWithDeadline("node", [
      "--test", "--test-timeout=" + PER_TEST_TIMEOUT_MS,
      "--test-reporter=spec", "--test-reporter-destination=stdout",
      "--test-reporter=" + REPORTER, "--test-reporter-destination=" + eventsFile,
      ...found,
    ], opts.deadline, { cwd: ROOT, env: runnerEnv() });
    lines = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, "utf8").split("\n").filter(Boolean) : [];
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const problems = [];
  const runFailure = describeFailure(result, opts.deadline);
  if (runFailure) problems.push("node --test " + runFailure);
  let passed = 0;
  for (const [file, s] of tally(lines, relative)) {
    const name = relative.get(file);
    passed += s.passed;
    console.log("  " + name + ": " + s.passed + " passed, " + s.failed + " failed, " + (s.enqueued - s.finished) + " unfinished");
    if (s.passed === 0) problems.push(name + " passed no tests (it has none, or it exited before reporting them)");
    if (s.enqueued > s.finished) problems.push(name + ": " + (s.enqueued - s.finished) + " test(s) started but never finished (did the file exit early?)");
  }
  if (found.length < opts.minFiles) problems.push(found.length + " test file(s) ran, fewer than the committed floor of " + opts.minFiles);
  if (passed < opts.minTests) problems.push(passed + " test(s) passed, fewer than the committed floor of " + opts.minTests);
  console.log("node tests: " + found.length + " file(s), " + passed + " test(s) passed (floors: " + opts.minFiles + " files, " + opts.minTests + " tests)");
  if (problems.length) {
    for (const p of problems) console.error("FAIL: " + p);
    return 1;
  }
  return 0;
}

main(process.argv.slice(2)).then((status) => process.exit(status), (e) => {
  console.error("FAIL: " + (e && e.stack || e));
  process.exit(1);
});
