#!/usr/bin/env node
/*
 * Checks the npm package as a consumer would receive it, with the minified
 * build of the current source.
 *
 * 1. `npm pack --dry-run` in the repository; the package must contain
 *    exactly EXPECTED (the "files" whitelist plus what npm always adds).
 * 2. Copies those files into a staging directory outside the repository,
 *    with webaudio-tinysynth.min.js and its map replaced by a fresh build
 *    (scripts/test-build.js; the committed copies can be older than the
 *    source on a branch), and packs that directory.
 * 3. Installs the tarball into a scratch consumer project (offline, no
 *    scripts) and require()s the package entry point and the minified build
 *    there. Both must export the WebAudioTinySynth class, and the installed
 *    files must equal the staged files byte for byte.
 *
 * Exits 1 on any failure. Usage: npm run pack:check
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const { prepare } = require("./test-build");

const ROOT = path.resolve(__dirname, "..");
const MIN = "webaudio-tinysynth.min.js";
const EXPECTED = [
  "LICENSE", "NOTICE", "README.md", "package.json",
  "webaudio-tinysynth.js", "webaudio-tinysynth.min.js", "webaudio-tinysynth.min.js.map",
];
const DEADLINE_MS = 120000;

class CheckError extends Error {}
function fail(msg) {
  throw new CheckError(msg);
}

/* Run npm (the same npm that runs this script under `npm run`, else npm on PATH). */
function npm(args, cwd) {
  const cli = process.env.npm_execpath;
  const [cmd, argv] = cli && /\.c?js$/.test(cli) ? [process.execPath, [cli, ...args]] : ["npm", args];
  const r = spawnSync(cmd, argv, { cwd, encoding: "utf8", timeout: DEADLINE_MS, killSignal: "SIGKILL", maxBuffer: 1 << 26 });
  if (r.error || r.status !== 0)
    fail("npm " + args.join(" ") + " failed (" + (r.error ? r.error.message : "exit " + r.status) + ")\n" + r.stdout + r.stderr);
  return r.stdout;
}

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function checkContents(packed) {
  const files = packed.files.map((f) => f.path).sort();
  const missing = EXPECTED.filter((f) => !files.includes(f));
  const extra = files.filter((f) => !EXPECTED.includes(f));
  if (missing.length || extra.length)
    fail("package contents differ from the whitelist: missing " + JSON.stringify(missing) + ", unexpected " + JSON.stringify(extra));
  return files;
}

function main(tmp, built) {
  if (path.relative(ROOT, tmp).split(path.sep)[0] !== "..") fail("scratch directory " + tmp + " is inside the repository");
  // The whitelist is checked on the repository itself, then the same files are staged with the fresh build.
  const files = checkContents(JSON.parse(npm(["pack", "--dry-run", "--json"], ROOT))[0]);
  const stage = path.join(tmp, "stage");
  const sourceOf = (f) => f === MIN ? built.min : f === MIN + ".map" ? built.map : path.join(ROOT, f);
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(stage, f)), { recursive: true });
    fs.copyFileSync(sourceOf(f), path.join(stage, f));
  }
  const packed = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", tmp, stage], tmp))[0];
  checkContents(packed);
  console.log("packed " + packed.filename + ": " + packed.size + " bytes, " + packed.unpackedSize + " unpacked, " + packed.files.length + " files");
  for (const f of packed.files) console.log("  " + String(f.size).padStart(7) + "  " + f.path);

  const consumer = path.join(tmp, "consumer");
  fs.mkdirSync(consumer);
  fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "tinysynth-pack-consumer", version: "0.0.0", private: true }) + "\n");
  npm(["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", path.join(tmp, packed.filename)], consumer);

  const installed = path.join(consumer, "node_modules", packed.name);
  for (const f of EXPECTED.filter((x) => x !== "package.json")) {
    if (sha256(path.join(installed, f)) !== sha256(sourceOf(f))) fail("installed " + f + " differs from " + path.relative(ROOT, sourceOf(f)));
  }
  const probe = [
    "const assert = require('assert');",
    "for (const id of [" + JSON.stringify(packed.name) + ", " + JSON.stringify(packed.name + "/webaudio-tinysynth.min.js") + "]) {",
    "  const S = require(id);",
    "  assert.strictEqual(typeof S, 'function', id + ' does not export a function');",
    "  assert.strictEqual(S.name, 'WebAudioTinySynth', id + ' exports ' + S.name);",
    "  assert.strictEqual(typeof globalThis.WebAudioTinySynth, 'undefined', id + ' leaked a global');",
    "  console.log('  require(' + JSON.stringify(id) + ') -> class ' + S.name);",
    "}",
  ].join("\n");
  const r = spawnSync(process.execPath, ["-e", probe], { cwd: consumer, encoding: "utf8", timeout: DEADLINE_MS, killSignal: "SIGKILL" });
  process.stdout.write(r.stdout);
  if (r.error || r.status !== 0) fail("require() in the scratch consumer failed\n" + r.stderr);
  console.log("installed min.js sha256 " + sha256(path.join(installed, MIN)) + " (" + path.relative(ROOT, built.min) + ")");
}

prepare().then((built) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tinysynth-pack-"));
  try {
    main(tmp, built);
    console.log("PASS: package contents and scratch-consumer require()");
  } catch (e) {
    console.error("FAIL: " + (e instanceof CheckError ? e.message : e && e.stack || e));
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}, (e) => {
  console.error("FAIL: " + (e && e.stack || e));
  process.exitCode = 1;
});
