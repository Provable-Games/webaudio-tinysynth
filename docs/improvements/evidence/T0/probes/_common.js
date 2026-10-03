/*
 * Shared helpers for the T0 baseline probes. Node.js only, no dependencies.
 *
 * The probes load tests/harness.js from the repository root that contains
 * this file (five directories up), so they run from any working directory
 * and against whatever webaudio-tinysynth.js / .min.js that checkout holds.
 *
 * Hang safety: every call that may not return runs through vm with an
 * internal timeout (guarded()), and the runner wraps each probe in an
 * external `timeout -s KILL` deadline (see run-all.sh).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "../../../../..");
const H = require(path.join(ROOT, "tests/harness.js"));

const BUILDS = ["webaudio-tinysynth.js", "webaudio-tinysynth.min.js"];

function source(build) {
  return fs.readFileSync(path.join(ROOT, build), "utf8");
}

/* Run `code` (a string evaluated with `scope` as globals) under a vm timeout. */
function guarded(code, scope, timeoutMs) {
  const t0 = process.hrtime.bigint();
  try {
    const value = vm.runInNewContext(code, scope, { timeout: timeoutMs });
    return { outcome: "returned", ms: Number(process.hrtime.bigint() - t0) / 1e6, value };
  } catch (e) {
    const msg = String(e && e.message || e);
    return {
      outcome: /Script execution timed out/.test(msg) ? "timeout" : "threw",
      ms: Number(process.hrtime.bigint() - t0) / 1e6, error: msg,
    };
  }
}

/* A Standard MIDI File from raw track byte arrays. */
function smf(format, division, tracks, opts) {
  opts = opts || {};
  const u32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  const u16 = (v) => [(v >>> 8) & 0xff, v & 0xff];
  const out = [0x4d, 0x54, 0x68, 0x64, ...u32(6), ...u16(format), ...u16(tracks.length), ...u16(division)];
  tracks.forEach((t, i) => {
    const declared = opts.declaredLengths && opts.declaredLengths[i] !== undefined ? opts.declaredLengths[i] : t.length;
    out.push(0x4d, 0x54, 0x72, 0x6b, ...u32(declared), ...t);
  });
  return Buffer.from(out);
}

/* Track bytes from [{tick, bytes}] (sorted, delta-encoded), optionally without End-of-Track. */
function trackBytes(events, withEot) {
  const vlq = (v) => {
    const out = [v & 0x7f];
    while ((v >>= 7)) out.unshift((v & 0x7f) | 0x80);
    return out;
  };
  const sorted = events.slice().sort((a, b) => a.tick - b.tick);
  const out = [];
  let last = 0;
  for (const ev of sorted) {
    out.push(...vlq(ev.tick - last), ...ev.bytes);
    last = ev.tick;
  }
  if (withEot !== false) out.push(0, 0xff, 0x2f, 0x00);
  return out;
}

/* Note-on times (seconds) recorded by the harness _note wrapper. */
function noteTimes(notes) {
  return notes.map((n) => n[0]);
}

function round(x, d) {
  if (typeof x !== "number" || !isFinite(x)) return x === undefined ? null : String(x);
  const k = Math.pow(10, d === undefined ? 9 : d);
  return Math.round(x * k) / k;
}

function header(name) {
  return { probe: name, node: process.version, root: ROOT, commit: gitHead() };
}

function gitHead() {
  try {
    return require("child_process").execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT }).toString().trim();
  } catch (e) {
    return null;
  }
}

function emit(obj) {
  console.log(JSON.stringify(obj));
}

module.exports = { ROOT, H, BUILDS, source, guarded, smf, trackBytes, noteTimes, round, header, emit };
