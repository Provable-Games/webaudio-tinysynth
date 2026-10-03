#!/usr/bin/env node
/*
 * Runs a command with a deadline.
 *
 * The command runs in its own process group. If it is still running when the
 * deadline passes, the whole group (the command and every process it
 * started, such as the per-file processes of `node --test`) is killed with
 * SIGKILL, and the run fails. A test runner's own timeouts cannot do this
 * for a test stuck in a synchronous loop, because their timers never fire.
 * Processes the command leaves behind are killed when it exits, and an
 * interrupt or termination of this script is passed on to the group.
 *
 * CLI: node scripts/run-with-deadline.js SECONDS COMMAND [ARGS...]
 *   Exits with the command's status, 1 if a signal ended it, or 124 if the
 *   deadline passed. COMMAND "node" means the Node binary running this script.
 *
 * Needs POSIX process groups (Linux, macOS).
 */
"use strict";
const { spawn } = require("child_process");

const TIMEOUT_STATUS = 124;

/*
 * Resolves to {status, signal, timedOut, error, seconds}; status is null unless
 * the command exited. With options.onStdout, the command's stdout is piped and
 * each chunk is passed to it (stderr stays inherited).
 */
function runWithDeadline(command, args, seconds, options = {}) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const elapsed = () => Number(process.hrtime.bigint() - started) / 1e9;
    const stdio = options.onStdout ? ["inherit", "pipe", "inherit"] : "inherit";
    const child = spawn(command === "node" ? process.execPath : command, args,
      { stdio, cwd: options.cwd, env: options.env, detached: true });
    if (options.onStdout) child.stdout.on("data", options.onStdout);
    let timedOut = false;
    const killGroup = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group has no processes left.
      }
    };
    const onSignal = (signal) => {
      killGroup();
      process.exit(128 + (signal === "SIGINT" ? 2 : 15));
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, seconds * 1000);
    const finish = (result) => {
      clearTimeout(timer);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      resolve(Object.assign({ status: null, signal: null, timedOut, error: null, seconds: elapsed() }, result));
    };
    child.once("error", (error) => finish({ error }));
    // "close" comes after "exit" once the command's output is fully read.
    child.once("exit", killGroup);
    child.once("close", (status, signal) => finish({ status, signal }));
  });
}

/* One-line description of a failed run, or null if it succeeded. */
function describeFailure(result, seconds) {
  if (result.timedOut) return "timed out after " + seconds + " s; its process group was killed";
  if (result.error) return "could not start: " + result.error.message;
  if (result.signal) return "ended by " + result.signal;
  if (result.status !== 0) return "exited with status " + result.status;
  return null;
}

module.exports = { runWithDeadline, describeFailure, TIMEOUT_STATUS };

if (require.main === module) {
  const [secondsArg, command, ...args] = process.argv.slice(2);
  const seconds = Number(secondsArg);
  if (!(seconds > 0) || !command) {
    console.error("usage: node scripts/run-with-deadline.js SECONDS COMMAND [ARGS...]");
    process.exit(2);
  }
  runWithDeadline(command, args, seconds).then((result) => {
    const failure = describeFailure(result, seconds);
    if (failure) console.error("FAIL: " + [command, ...args].join(" ") + ": " + failure);
    process.exit(result.timedOut ? TIMEOUT_STATUS : result.status === null ? 1 : result.status);
  });
}
