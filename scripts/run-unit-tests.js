#!/usr/bin/env node
/*
 * Runs the Vitest unit tests and fails closed.
 *
 * Vitest itself fails when no test file matches and when a test calls
 * process.exit, but a unit test file renamed out of its include pattern
 * (vitest.config.mjs) silently drops its tests. This runner runs `vitest run`
 * under a deadline (scripts/run-with-deadline.js) with the default reporter on
 * the console and the JSON reporter in a temporary file, then fails if Vitest
 * failed, if any file passed no test, or if fewer than --min-files files ran or
 * fewer than --min-tests tests passed. The floors are committed in
 * package.json ("test:unit"); raise them when you add tests.
 *
 * Usage: node scripts/run-unit-tests.js [--min-files=N] [--min-tests=N] [--deadline=SECONDS]
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runWithDeadline, describeFailure } = require("./run-with-deadline");

const ROOT = path.resolve(__dirname, "..");
const VITEST = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");

function parseArgs(argv) {
  const opts = { minFiles: 1, minTests: 1, deadline: 600 };
  for (const arg of argv) {
    const m = /^--(min-files|min-tests|deadline)=(\d+)$/.exec(arg);
    if (!m) throw new Error("unknown argument " + arg);
    opts[{ "min-files": "minFiles", "min-tests": "minTests", deadline: "deadline" }[m[1]]] = Number(m[2]);
  }
  return opts;
}

async function main(argv) {
  const opts = parseArgs(argv);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tinysynth-unit-tests-"));
  const reportFile = path.join(tmp, "vitest.json");
  let result, report = null;
  try {
    result = await runWithDeadline("node", [VITEST, "run", "--reporter=default", "--reporter=json", "--outputFile.json=" + reportFile],
      opts.deadline, { cwd: ROOT });
    if (fs.existsSync(reportFile)) report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const problems = [];
  const runFailure = describeFailure(result, opts.deadline);
  if (runFailure) problems.push("vitest " + runFailure);
  const files = report ? report.testResults : [];
  let passed = 0;
  for (const file of files) {
    const name = path.relative(ROOT, file.name);
    const n = file.assertionResults.filter((t) => t.status === "passed").length;
    passed += n;
    console.log("  " + name + ": " + n + " passed, " + file.assertionResults.filter((t) => t.status === "failed").length + " failed");
    if (n === 0) problems.push(name + " passed no tests");
  }
  if (!report) problems.push("vitest wrote no JSON report");
  else if (!report.success) problems.push("vitest reported failure");
  if (files.length < opts.minFiles) problems.push(files.length + " test file(s) ran, fewer than the committed floor of " + opts.minFiles);
  if (passed < opts.minTests) problems.push(passed + " test(s) passed, fewer than the committed floor of " + opts.minTests);
  console.log("unit tests: " + files.length + " file(s), " + passed + " test(s) passed (floors: " + opts.minFiles + " files, " + opts.minTests + " tests)");
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
