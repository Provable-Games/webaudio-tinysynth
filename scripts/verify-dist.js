#!/usr/bin/env node
/*
 * Verifies the committed distribution files.
 *
 * 1. Rebuilds webaudio-tinysynth.min.js and its map with scripts/build.js
 *    into a temporary directory and requires both to equal the committed
 *    files byte for byte.
 * 2. Requires the minified file and the source to be safe to inline in an
 *    HTML <script> element (the onchain consumer embeds the minified bytes in
 *    a data: URI): no "</script", "<script" or "<!--" in any letter case, and
 *    only ASCII bytes.
 * 3. Prints raw size, gzip size and SHA-256 (scripts/size.js).
 *
 * Exits 1 if any check fails. Usage: npm run verify
 *
 * This is the consumer's check of a commit. Pull requests other than
 * improve/integration -> main do not carry the generated files and use
 * scripts/check-dist.js instead.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ROOT, SOURCE, OUTPUT, MAP, build } = require("./build");
const size = require("./size");

const FORBIDDEN = [/<\/script/i, /<script/i, /<!--/];

function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; ++i) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

function compare(name, built, committed, failures) {
  const want = fs.readFileSync(built);
  let have;
  try {
    have = fs.readFileSync(committed);
  } catch (e) {
    failures.push(name + ": cannot read the committed file (" + e.message + ")");
    return;
  }
  const at = firstDifference(want, have);
  if (at === -1) {
    console.log("ok   " + name + " matches a fresh build");
    return;
  }
  const show = (buf) => JSON.stringify(buf.subarray(Math.max(0, at - 30), at + 30).toString("latin1"));
  failures.push(name + " differs from a fresh build (stale or hand-edited; run npm run build):\n" +
    "       committed " + have.length + " bytes, sha256 " + size.measure(committed).sha256 + "\n" +
    "       fresh     " + want.length + " bytes, sha256 " + size.measure(built).sha256 + "\n" +
    "       first difference at byte " + at + "\n" +
    "         committed: " + show(have) + "\n" +
    "         fresh:     " + show(want));
}

function checkInlineSafe(name, file, failures) {
  const buf = fs.readFileSync(file);
  const text = buf.toString("latin1");
  const problems = [];
  for (const re of FORBIDDEN) {
    const m = re.exec(text);
    if (m) problems.push(JSON.stringify(m[0]) + " at byte " + m.index);
  }
  const nonAscii = buf.findIndex((b) => b > 0x7f);
  if (nonAscii !== -1) problems.push("non-ASCII byte 0x" + buf[nonAscii].toString(16) + " at byte " + nonAscii);
  if (problems.length) failures.push(name + " is not safe to inline in a <script> element: " + problems.join("; "));
  else console.log("ok   " + name + " has no </script, <script or <!-- and only ASCII bytes");
}

async function main() {
  const failures = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tinysynth-verify-"));
  try {
    const out = await build(tmp);
    console.log("rebuilt with terser " + out.terser + " into " + tmp);
    compare(OUTPUT, out.min, path.join(ROOT, OUTPUT), failures);
    compare(MAP, out.map, path.join(ROOT, MAP), failures);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  for (const f of [OUTPUT, SOURCE]) {
    const file = path.join(ROOT, f);
    if (fs.existsSync(file)) checkInlineSafe(f, file, failures);
    else failures.push(f + " is missing");
  }
  const present = [SOURCE, OUTPUT, MAP].map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f));
  console.log("\n" + size.format(present.map(size.measure)));
  if (failures.length) {
    console.error("\nFAIL: " + failures.length + " problem(s)");
    for (const f of failures) console.error("  - " + f);
    process.exit(1);
  }
  console.log("\nPASS: committed distribution matches the pinned build");
}

module.exports = { checkInlineSafe };

if (require.main === module) {
  main().catch((e) => {
    console.error("verify failed: " + (e && e.stack || e));
    process.exit(1);
  });
}
