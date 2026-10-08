#!/usr/bin/env node
/*
 * Prints raw size, gzip size and SHA-256 of the library and its builds.
 *
 * "gzip" is Node's zlib at level 9 (deterministic for the pinned Node).
 * "gzip -9 -n" is GNU gzip, which the T0 baseline used; it is shown when a
 * gzip command is on PATH. The two deflate implementations differ by a few
 * dozen bytes, so compare like with like.
 *
 * Usage: node scripts/size.js [file ...]
 *   Default: the source, and a fresh build of it (scripts/test-build.js:
 *   .build/, or TINYSYNTH_MIN) with its map. The committed min.js can be
 *   older than the source on a branch; `npm run verify` measures that copy.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

function gnuGzipSize(file) {
  const r = spawnSync("gzip", ["-9", "-n", "-c", file], { maxBuffer: 1 << 26 });
  return r.status === 0 ? r.stdout.length : null;
}

function measure(file) {
  const buf = fs.readFileSync(file);
  return {
    file,
    bytes: buf.length,
    gzip: zlib.gzipSync(buf, { level: 9 }).length,
    gnuGzip: gnuGzipSize(file),
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
  };
}

function format(rows) {
  const lines = ["file                              bytes   gzip  gzip -9 -n  sha256"];
  for (const r of rows) {
    lines.push(path.basename(r.file).padEnd(30) + String(r.bytes).padStart(9) + String(r.gzip).padStart(7) +
      String(r.gnuGzip === null ? "n/a" : r.gnuGzip).padStart(12) + "  " + r.sha256);
  }
  return lines.join("\n");
}

module.exports = { measure, format };

async function main(argv) {
  if (argv.length) return format(argv.map(measure));
  const built = await require("./test-build").prepare({ quiet: true });
  return "min.js and map: " + path.relative(ROOT, built.min) + (built.built ? " (fresh build of the current source)" : " (TINYSYNTH_MIN)") + "\n" +
    format([path.join(ROOT, "webaudio-tinysynth.js"), built.min, built.map].map(measure));
}

if (require.main === module) {
  main(process.argv.slice(2)).then((text) => console.log(text), (e) => {
    console.error("size failed: " + (e && e.stack || e));
    process.exit(1);
  });
}
