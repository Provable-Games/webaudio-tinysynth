#!/usr/bin/env node
/*
 * The minified build that tests, pack:check and the size report use.
 *
 * Pull requests do not carry webaudio-tinysynth.min.js or its map (CI
 * rebuilds the committed copies on improve/integration after each merge,
 * .github/workflows/dist.yml). The committed files on a feature branch can
 * therefore be older than its source, so the test suites never read them.
 * They read a fresh build of the current source in .build/ (ignored by git),
 * which leaves every tracked file untouched.
 *
 *   minPath()   TINYSYNTH_MIN if set, else .build/webaudio-tinysynth.min.js
 *   mapPath()   minPath() + ".map"
 *   prepare()   builds into .build/ with the pinned build (scripts/build.js)
 *               and sets TINYSYNTH_MIN for child processes. With TINYSYNTH_MIN
 *               already set it builds nothing and uses that file, for example
 *               TINYSYNTH_MIN=webaudio-tinysynth.min.js to test the committed copy.
 *
 * Every test runner (run-unit-tests, run-node-tests, run-regressions,
 * browser-matrix, check-pack, size, browser-server) calls prepare() first.
 * A test file run on its own reads whatever .build/ holds; run
 * `node scripts/test-build.js` first to refresh it.
 *
 * Usage: node scripts/test-build.js    (builds into .build/ and prints the path)
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const BUILD_DIR = path.join(ROOT, ".build");
const MIN_NAME = "webaudio-tinysynth.min.js";

function minPath() {
  return process.env.TINYSYNTH_MIN ? path.resolve(ROOT, process.env.TINYSYNTH_MIN) : path.join(BUILD_DIR, MIN_NAME);
}

function mapPath() {
  return minPath() + ".map";
}

/* minPath(), or an error that says how to create the file. */
function existingMinPath() {
  const file = minPath();
  if (!fs.existsSync(file)) {
    throw new Error(process.env.TINYSYNTH_MIN
      ? "TINYSYNTH_MIN=" + process.env.TINYSYNTH_MIN + " does not exist"
      : "no fresh build at " + path.relative(ROOT, file) + "; run `node scripts/test-build.js` " +
        "(every npm test script builds it first)");
  }
  return file;
}

/*
 * Builds into a private directory under .build/ and renames both files into
 * place, so a concurrent run in the same checkout never reads a partial file.
 * The build is deterministic: concurrent runs write the same bytes.
 */
async function prepare({ quiet = false } = {}) {
  if (process.env.TINYSYNTH_MIN) {
    const file = existingMinPath();
    if (!quiet) console.log("min.js under test: " + file + " (TINYSYNTH_MIN)");
    return { min: file, map: file + ".map", built: false };
  }
  const { build, OUTPUT, MAP } = require("./build");
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(BUILD_DIR, "tmp-"));
  let out;
  try {
    out = await build(tmp);
    fs.renameSync(out.map, path.join(BUILD_DIR, MAP));
    fs.renameSync(out.min, path.join(BUILD_DIR, OUTPUT));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const min = path.join(BUILD_DIR, OUTPUT);
  process.env.TINYSYNTH_MIN = min;
  if (!quiet) console.log("min.js under test: " + path.relative(ROOT, min) + " (fresh build, terser " + out.terser + ")");
  return { min, map: min + ".map", built: true };
}

module.exports = { ROOT, BUILD_DIR, minPath, mapPath, existingMinPath, prepare };

if (require.main === module) {
  prepare().catch((e) => {
    console.error("build failed: " + (e && e.stack || e));
    process.exit(1);
  });
}
