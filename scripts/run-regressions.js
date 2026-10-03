#!/usr/bin/env node
/*
 * Runs the standalone regression scripts, each in its own Node process with
 * a deadline (scripts/run-with-deadline.js). Every script runs even when an
 * earlier one fails. Exits 1 if any script failed, crashed or timed out.
 *
 * Usage: node scripts/run-regressions.js [--deadline=SECONDS] [script ...]
 *   Default scripts: tests/differential.js tests/tempo.js tests/loop-end.js
 *   Default deadline: 300 s per script.
 */
"use strict";
const path = require("path");
const { runWithDeadline, describeFailure } = require("./run-with-deadline");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_SCRIPTS = ["tests/differential.js", "tests/tempo.js", "tests/loop-end.js"];

async function main(argv) {
  let deadline = 300;
  const scripts = [];
  for (const arg of argv) {
    const m = /^--deadline=(.+)$/.exec(arg);
    if (m) deadline = Number(m[1]);
    else scripts.push(arg);
  }
  if (!(deadline > 0)) {
    console.error("usage: node scripts/run-regressions.js [--deadline=SECONDS] [script ...]");
    return 2;
  }
  if (!scripts.length) scripts.push(...DEFAULT_SCRIPTS);

  const results = [];
  for (const script of scripts) {
    console.log("== " + script);
    const result = await runWithDeadline("node", [path.resolve(ROOT, script)], deadline, { cwd: ROOT });
    const failure = describeFailure(result, deadline);
    results.push({ script, failure, seconds: result.seconds });
    console.log("-- " + script + ": " + (failure ? "FAILED, " + failure : "ok") + " (" + result.seconds.toFixed(1) + " s)\n");
  }
  const failed = results.filter((r) => r.failure);
  console.log("regressions: " + (results.length - failed.length) + " of " + results.length + " passed");
  for (const r of failed) console.log("  FAILED " + r.script + ": " + r.failure);
  return failed.length ? 1 : 0;
}

main(process.argv.slice(2)).then((status) => process.exit(status));
