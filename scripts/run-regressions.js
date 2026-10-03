#!/usr/bin/env node
/*
 * Runs standalone test scripts (by default the regression scripts), each in
 * its own Node process with a deadline (scripts/run-with-deadline.js). Every
 * script runs even when an earlier one fails.
 *
 * A script passes only if it exits with status 0 and the last line it prints
 * on stdout starts with "PASS:". A script that calls process.exit(0) before
 * finishing its checks therefore fails instead of passing silently. Exits 1
 * if any script failed, crashed, timed out or stopped early.
 *
 * Usage: node scripts/run-regressions.js [--deadline=SECONDS] [entry ...]
 *   Each entry is a script path, optionally followed by its arguments in the
 *   same shell word, for example "tests/browser-smoke.js test-midi/a.mid"
 *   (paths with spaces are not supported).
 *   Default entries: tests/differential.js tests/tempo.js tests/loop-end.js
 *   Default deadline: 300 s per script.
 */
"use strict";
const path = require("path");
const { runWithDeadline, describeFailure } = require("./run-with-deadline");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_SCRIPTS = ["tests/differential.js", "tests/tempo.js", "tests/loop-end.js"];

async function main(argv) {
  let deadline = 300;
  const entries = [];
  for (const arg of argv) {
    const m = /^--deadline=(.+)$/.exec(arg);
    if (m) deadline = Number(m[1]);
    else entries.push(arg);
  }
  if (!(deadline > 0)) {
    console.error("usage: node scripts/run-regressions.js [--deadline=SECONDS] [entry ...]");
    return 2;
  }
  if (!entries.length) entries.push(...DEFAULT_SCRIPTS);

  const results = [];
  for (const entry of entries) {
    const [script, ...args] = entry.trim().split(/\s+/);
    let out = "";
    console.log("== " + entry);
    const result = await runWithDeadline("node", [path.resolve(ROOT, script), ...args], deadline, {
      cwd: ROOT,
      onStdout: (chunk) => {
        process.stdout.write(chunk);
        out += chunk;
      },
    });
    let failure = describeFailure(result, deadline);
    const last = out.split("\n").map((l) => l.trim()).filter(Boolean).pop() || "";
    if (!failure && !last.startsWith("PASS:"))
      failure = "exited 0 without a final \"PASS:\" line (it stopped before finishing its checks)";
    results.push({ entry, failure });
    console.log("-- " + entry + ": " + (failure ? "FAILED, " + failure : "ok") + " (" + result.seconds.toFixed(1) + " s)\n");
  }
  const failed = results.filter((r) => r.failure);
  console.log((results.length - failed.length) + " of " + results.length + " scripts passed");
  for (const r of failed) console.log("  FAILED " + r.entry + ": " + r.failure);
  return failed.length ? 1 : 0;
}

main(process.argv.slice(2)).then((status) => process.exit(status));
