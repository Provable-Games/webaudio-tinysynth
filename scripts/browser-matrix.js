#!/usr/bin/env node
/*
 * Browser and rendered-audio matrix (#16): Chromium, Firefox and WebKit, the
 * source and minified builds, both quality modes and two sample rates. The
 * matrix is declared in tests/browser/matrix.js and printed with the results.
 *
 * Usage: node scripts/browser-matrix.js [options]
 *   --mode=core|full-mix-qualification  select the ordinary matrix or the strict fixture qualifier
 *   --engines=chromium,firefox,webkit   engines to run (default: all declared)
 *   --specs=embed,render,...            specs to run (default: every "assert" spec)
 *   --observe                           also run the observe-only specs (hang, variation)
 *   --seed=N                            Math.random seed for the test pages
 *   --source=PATH --min=PATH            test another copy of a build (for example a
 *                                       deliberately broken scratch copy). Without
 *                                       --min, the min build is a fresh build of the
 *                                       current source (scripts/test-build.js)
 *   --out=DIR                           write results.json, renders (WAV) and logs there
 *   --shard=K/N                         run only the selected specs that belong to shard K
 *                                       of N (see shardLayout); with --list, print all N
 *   --merge=DIR                         run nothing: check the mode-specific results.json files under DIR
 *                                       (one per shard and step, from CI) together, and
 *                                       print the combined table and the measured times
 *   --list                              print the matrix and exit
 *
 * Sharding (CI, .github/workflows/browser-matrix.yml): each engine's specs,
 * assert and observe, are split across N jobs by their measured seconds in
 * tests/browser/matrix.js. A shard none of whose specs are selected passes
 * without launching a browser; --merge then fails unless every engine ran
 * every declared spec exactly once and every case passed.
 *
 * Each engine runs in its own worker process (this script with --engine=NAME)
 * under scripts/run-with-deadline.js, so a hung browser is killed with the
 * worker's process group; inside the worker every case has its own deadline.
 * The analysis self-test (tests/browser/lib/analysis.js) runs first.
 *
 * Exit status 0 only if every declared engine launched and every case passed.
 * A missing browser is a failure, never a skip. The last line printed starts
 * with "PASS:" or "FAIL:".
 *
 * Needs playwright-core (pinned devDependency) and its browsers:
 *   npx playwright-core install --with-deps chromium firefox webkit
 * Firefox only starts a realtime AudioContext when an audio output exists;
 * on a machine without one, run a PulseAudio null sink (see
 * .github/workflows/browser-matrix.yml). The gesture spec fails otherwise.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { runWithDeadline, describeFailure } = require("./run-with-deadline");
const browserToolchainSpec = require("./browser-toolchain");
const { MATRIX } = require("../tests/browser/matrix");
const analysis = require("../tests/browser/lib/analysis");
const { SEED_EXPECTED } = require("../tests/browser/specs/seed-expected");
const fullMixSpec = require("../tests/browser/specs/full-mix");
const FULL_MIX_CASES = new Map(fullMixSpec.expectedCases().map((c) => [c.id, c]));

const ROOT = path.resolve(__dirname, "..");
const SPEC_DIR = path.join(ROOT, "tests", "browser", "specs");
const PROVENANCE_SCHEMA = 3;
const PROVENANCE_CONTEXT_FIELDS = ["repository", "workflowRef", "eventName", "runId", "runAttempt", "testedSha"];
const RENDER_BUFFER_SHA_OBSERVATION = "generated buffer SHA-256 (first reverb-enabled attempt)";
const RENDER_BUFFER_SHA_METHOD = "sha256-f32le-planar-channel-order-v1";
const RENDER_BUFFER_SHA_PRODUCER = "node-crypto-after-browser-byte-transfer";
const RENDER_BUFFER_SHA_ENCODING = "IEEE-754 binary32 little-endian; planar channel-index order; sample bytes only";
const REVERB_CAPTURE_TIMBRES = [[0, 0, [{ w: "sine", t: 0, f: 300, v: 0.5, a: 0, h: 0.01, d: 0, s: 1, r: 0.01, p: 1, q: 1, k: 0 }]]];
const REVERB_CAPTURE_STEPS = [
  { call: "noteOn", args: [0, 69, 100, 0.5] },
  { call: "noteOff", args: [0, 69, 0.8] },
];
const QUALIFICATION_SPECS = ["render", "full-mix"];

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

function resolveBrowserToolchain(env = process.env) {
  return browserToolchainSpec.resolveBrowserToolchain(env, ROOT);
}

function browserBundle(toolchain, engine) {
  return browserToolchainSpec.engineBundle(toolchain, engine);
}

/* A run identity comes from GitHub's protected runner environment, or an explicit local context file. */
function githubContext(env = process.env) {
  return {
    repository: env.GITHUB_REPOSITORY || "",
    workflowRef: env.GITHUB_WORKFLOW_REF || "",
    eventName: env.GITHUB_EVENT_NAME || "",
    runId: env.GITHUB_RUN_ID || "",
    runAttempt: env.GITHUB_RUN_ATTEMPT || "",
    testedSha: env.GITHUB_SHA || "",
  };
}

function validateContext(context, label) {
  const missing = PROVENANCE_CONTEXT_FIELDS.filter((key) => typeof context[key] !== "string" || !context[key].trim());
  if (missing.length) throw new Error(label + " is missing " + missing.join(", "));
  if (!/^[a-f0-9]{40,64}$/i.test(context.testedSha)) throw new Error(label + " testedSha must be a full Git object ID");
  if (!/^\d+$/.test(context.runAttempt) || Number(context.runAttempt) < 1) throw new Error(label + " runAttempt must be a positive integer");
  return Object.fromEntries(PROVENANCE_CONTEXT_FIELDS.map((key) => [key, context[key]]));
}

function readContextFile(file, label) {
  let value;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { throw new Error(label + " is unreadable: " + e.message, { cause: e }); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(label + " must be a JSON object");
  return validateContext(value, label);
}

/* Fingerprint the executable browser test surface and its pinned toolchain. */
function matrixConfigSha256() {
  const files = [
    ".github/workflows/browser-matrix.yml",
    "package.json",
    "package-lock.json",
    "scripts/browser-matrix.js",
    "scripts/browser-toolchain.js",
    "scripts/reanalyze-fullmix-v6.js",
    "scripts/test-build.js",
  ];
  const collect = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) collect(rel);
      else if (entry.isFile()) files.push(rel);
    }
  };
  collect("tests/browser");
  collect("tests/fixtures/consumer");
  files.push("ws.mid");
  const unique = [...new Set(files)].sort();
  const h = crypto.createHash("sha256");
  for (const rel of unique) {
    h.update(rel);
    h.update("\0");
    h.update(fs.readFileSync(path.join(ROOT, rel)));
    h.update("\0");
  }
  h.update("full-mix-reference-provenance-v1\0");
  h.update(stableJson(fullMixSpec.referenceProvenance()));
  h.update("\0");
  return h.digest("hex");
}

function buildSha256(overrides = {}) {
  const testBuild = require("./test-build");
  const source = overrides.source || path.join(ROOT, "webaudio-tinysynth.js");
  const min = overrides.min || testBuild.existingMinPath();
  return { source: sha256File(source), min: sha256File(min) };
}

function reportProvenance(o, engines, context = null) {
  const selection = selectedSpecs(o);
  const kinds = [...new Set(selection.map((spec) => MATRIX.specs[spec].kind))];
  const identity = context ? validateContext(context, "run context") : githubContext();
  return {
    schemaVersion: PROVENANCE_SCHEMA,
    ...identity,
    matrixConfigSha256: matrixConfigSha256(),
    fullMixReference: fullMixSpec.referenceProvenance(),
    engine: engines.length === 1 ? engines[0] : null,
    shard: o.shard ? { index: o.shard.k, total: o.shard.n } : null,
    selection: { mode: o.mode || "core", kind: kinds.length === 1 ? kinds[0] : "mixed", seed: o.seed, specs: selection },
    buildSha256: buildSha256(o.overrides),
    browserToolchain: resolveBrowserToolchain(),
  };
}

function caseManifest(engine, specs) {
  const shared = { matrix: MATRIX, engine, version: "manifest", options: { seed: MATRIX.seed, overrides: {} } };
  const out = [];
  for (const spec of specs) {
    const mod = require(path.join(SPEC_DIR, spec + ".js"));
    const cases = mod.cases(shared);
    if (!Array.isArray(cases) || !cases.length) throw new Error("spec " + spec + " produced no declared cases");
    for (const c of cases) out.push({ id: c.id, spec, kind: c.kind || MATRIX.specs[spec].kind, dims: c.dims || {} });
  }
  return out;
}

function stableJson(value) {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stableJson(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/* Validate the exact first-attempt probe that creates all three buffers. */
function renderBufferShaProblems(c, observation, where, { expectedSeed = MATRIX.seed, requireSaved = true } = {}) {
  const problems = [];
  const add = (message) => problems.push(where + " " + message);
  if (!isRecord(observation)) return [where + " is missing generated-buffer SHA-256 evidence"];
  const expectedObservationKeys = ["attempt", "builds", "encoding", "firstAttempt", "method", "producer", "scenarioId", "schemaVersion", "settings"];
  if (stableJson(Object.keys(observation).sort()) !== stableJson(expectedObservationKeys))
    add("generated-buffer observation has missing or unexpected top-level fields");
  if (observation.schemaVersion !== 1 || observation.method !== RENDER_BUFFER_SHA_METHOD ||
      observation.producer !== RENDER_BUFFER_SHA_PRODUCER ||
      observation.encoding !== RENDER_BUFFER_SHA_ENCODING || observation.scenarioId !== "reverb" ||
      observation.attempt !== 1 || observation.firstAttempt !== true)
    add("has malformed generated-buffer SHA-256 method or first-attempt metadata");
  if (!Number.isSafeInteger(expectedSeed) || expectedSeed < 0 || expectedSeed > 0xffffffff)
    add("expected generated-buffer seed is invalid");
  const rate = c.dims && c.dims.sampleRate;
  const quality = c.dims && c.dims.quality;
  const expectedSettings = {
    seed: expectedSeed, sampleRate: rate, quality, options: { quality, useReverb: 1 },
    masterVol: 0.05, reverbLev: null, durationSec: 1.6,
    timbres: REVERB_CAPTURE_TIMBRES,
    steps: REVERB_CAPTURE_STEPS,
    activeProbe: {
      channel: 0, program: 0, pitch: 69, velocity: 100, onsetSec: 0.5,
      offChannel: 0, offPitch: 69, offSec: 0.8, timbre: REVERB_CAPTURE_TIMBRES[0][2],
    },
  };
  if (!isRecord(observation.settings) || stableJson(Object.keys(observation.settings).sort()) !== stableJson(["min", "source"]) ||
      stableJson(observation.settings.source) !== stableJson(expectedSettings) ||
      stableJson(observation.settings.min) !== stableJson(expectedSettings))
    add("has missing, stale or mismatched active reverb-probe settings");
  if (!isRecord(observation.builds) || stableJson(Object.keys(observation.builds).sort()) !== stableJson(["min", "source"])) {
    add("is missing source/min generated-buffer SHA-256 results");
    return problems;
  }
  const frames = Number.isSafeInteger(rate) ? Math.floor(rate * 0.5) : -1;
  const validBufferSet = (build, buildName) => {
    if (!isRecord(build)) { add(buildName + " build generated-buffer descriptors are missing"); return false; }
    let valid = stableJson(Object.keys(build).sort()) === stableJson(["convBuf", "n0", "n1"]);
    if (!valid)
      add(buildName + " build must contain exactly convBuf, n0 and n1 descriptors");
    for (const [name, channels] of [["convBuf", 2], ["n0", 1], ["n1", 1]]) {
      const row = build[name], at = buildName + " " + name;
      const artifactPath = "generated-buffers/q" + quality + "-" + rate + "-reverb-" + buildName + "-" + name + ".f32le";
      if (!isRecord(row)) { add(at + " generated-buffer descriptor is missing or malformed"); valid = false; continue; }
      if (stableJson(Object.keys(row).sort()) !== stableJson(["artifact", "byteLength", "captureTrace", "channels", "frames", "sha256"])) {
        add(at + " descriptor fields are incomplete or unexpected"); valid = false;
      }
      if (typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256)) {
        add(at + " SHA-256 must be 64 lowercase hexadecimal characters"); valid = false;
      }
      if (row.channels !== channels) { add(at + " channel count is " + String(row.channels) + ", expected " + channels); valid = false; }
      if (row.frames !== frames) { add(at + " frame count is " + String(row.frames) + ", expected " + frames); valid = false; }
      const byteLength = channels * frames * 4;
      if (row.byteLength !== byteLength) { add(at + " byte length is " + String(row.byteLength) + ", expected " + byteLength); valid = false; }
      const trace = row.captureTrace;
      if (!isRecord(trace) || stableJson(Object.keys(trace).sort()) !== stableJson(["browser", "node"]) ||
          !isRecord(trace.browser) || stableJson(Object.keys(trace.browser).sort()) !== stableJson(["base64Chars", "byteLength", "channels", "frames"]) ||
          !isRecord(trace.node) || stableJson(Object.keys(trace.node).sort()) !== stableJson(["byteLength", "channels", "decodedByteLength", "frames", "sha256"])) {
        add(at + " browser-to-Node generated-buffer capture-stage snapshot is missing or malformed");
        valid = false;
      } else {
        const browser = trace.browser, node = trace.node;
        if (![browser.channels, browser.frames, browser.byteLength, browser.base64Chars,
          node.channels, node.frames, node.byteLength, node.decodedByteLength].every(Number.isSafeInteger) ||
            typeof node.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(node.sha256)) {
          add(at + " browser-to-Node capture-stage snapshot has malformed dimensions or digest");
          valid = false;
        }
        if (browser.channels !== node.channels || browser.frames !== node.frames || browser.byteLength !== node.byteLength ||
            browser.byteLength !== node.decodedByteLength || browser.base64Chars !== Math.ceil(node.decodedByteLength / 3) * 4) {
          add(at + " browser-declared buffer dimensions/length differ from Node-validated bytes");
          valid = false;
        }
        if (node.channels !== row.channels || node.frames !== row.frames || node.byteLength !== row.byteLength || node.sha256 !== row.sha256) {
          add(at + " final descriptor differs from the Node-validated capture-stage snapshot");
          valid = false;
        }
      }
      if (!isRecord(row.artifact)) { add(at + " raw byte artifact reference is missing or malformed"); valid = false; }
      else {
        if (stableJson(Object.keys(row.artifact).sort()) !== stableJson(["path", "saved"])) {
          add(at + " raw byte artifact fields are incomplete or unexpected"); valid = false;
        }
        if (row.artifact.path !== artifactPath) { add(at + " raw byte artifact path is mismatched"); valid = false; }
        if (row.artifact.saved !== requireSaved) {
          add(at + " raw byte artifact retention is " + String(row.artifact.saved) + ", expected " + String(requireSaved)); valid = false;
        }
      }
    }
    return valid;
  };
  const sourceValid = validBufferSet(observation.builds.source, "source");
  const minValid = validBufferSet(observation.builds.min, "min");
  const measurementsOnly = (build) => Object.fromEntries(["convBuf", "n0", "n1"].map((name) => [name,
    build[name] && { sha256: build[name].sha256, channels: build[name].channels, frames: build[name].frames, byteLength: build[name].byteLength }]));
  if (sourceValid && minValid && stableJson(measurementsOnly(observation.builds.source)) !== stableJson(measurementsOnly(observation.builds.min)))
    add("source/min generated-buffer SHA-256 measurements disagree");
  const expected = Number.isSafeInteger(rate) && SEED_EXPECTED.hashes[rate] && SEED_EXPECTED.hashes[rate][expectedSeed];
  if (expected && sourceValid) {
    for (const name of ["convBuf", "n0", "n1"]) {
      if (observation.builds.source[name].sha256 !== expected[name])
        add("source generated-buffer SHA-256 differs from the independent seeded expectation for " + name);
    }
  }
  return problems;
}

/* Read only regular artifacts below the downloaded shard root; never follow a symlink. */
function readArtifactUnderShard(shardRoot, relativePath, expectedByteLength) {
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath))
    throw new Error("artifact path must be relative to the shard");
  if (!Number.isSafeInteger(expectedByteLength) || expectedByteLength < 1)
    throw new Error("expected artifact byte length is invalid; artifact was not read");
  const root = fs.realpathSync(shardRoot);
  const target = path.resolve(root, relativePath);
  if (target === root || !target.startsWith(root + path.sep)) throw new Error("artifact path escapes the shard directory");
  let current = root;
  const components = path.relative(root, target).split(path.sep);
  for (let i = 0; i < components.length; ++i) {
    current = path.join(current, components[i]);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("artifact path contains a symbolic link");
    if (i < components.length - 1 && !stat.isDirectory()) throw new Error("artifact parent is not a directory");
    if (i === components.length - 1) {
      if (!stat.isFile()) throw new Error("artifact is not a regular file");
      if (stat.size !== expectedByteLength)
        throw new Error("artifact byte length is " + stat.size + ", expected " + expectedByteLength + "; artifact was not read");
    }
  }
  const realTarget = fs.realpathSync(target);
  if (!realTarget.startsWith(root + path.sep)) throw new Error("artifact path escapes the shard directory");
  return fs.readFileSync(realTarget);
}

function generatedBufferArtifactProblems(engine, rel, resultFile, c, want, problems) {
  const obs = c && c.observations && c.observations[RENDER_BUFFER_SHA_OBSERVATION];
  if (!isRecord(obs) || !isRecord(obs.builds)) return;
  if (!want || stableJson(c.dims) !== stableJson(want.dims)) {
    problems.push(rel + ": " + engine + " / " + (c && c.id || "render case") + " generated-buffer artifacts were not read because downloaded dimensions differ from the independent manifest");
    return;
  }
  const shardRoot = path.dirname(resultFile);
  const captured = { source: {}, min: {} };
  const sampleRate = want.dims && want.dims.sampleRate;
  const frames = Number.isSafeInteger(sampleRate) && sampleRate > 0 ? Math.floor(sampleRate * 0.5) : -1;
  for (const build of ["source", "min"]) for (const name of ["convBuf", "n0", "n1"]) {
    const row = obs.builds[build] && obs.builds[build][name];
    if (!isRecord(row) || !isRecord(row.artifact) || typeof row.artifact.path !== "string") continue;
    const where = rel + ": " + engine + " / " + c.id + " " + build + " " + name;
    if (row.artifact.saved !== true) problems.push(where + " raw Float32 buffer bytes are not marked as retained");
    let bytes;
    const channels = name === "convBuf" ? 2 : 1;
    const expectedByteLength = channels * frames * 4;
    if (!Number.isSafeInteger(expectedByteLength) || expectedByteLength < 4) {
      problems.push(where + " expected Float32 byte length is invalid; artifact was not read");
      continue;
    }
    try { bytes = readArtifactUnderShard(shardRoot, path.join(engine, row.artifact.path), expectedByteLength); }
    catch (e) { problems.push(where + " raw Float32 buffer bytes are missing or invalid: " + e.message); continue; }
    if (bytes.length !== row.byteLength) {
      problems.push(where + " raw byte length is " + bytes.length + ", descriptor says " + String(row.byteLength));
      continue;
    }
    const actualSha = sha256(bytes);
    if (actualSha !== row.sha256)
      problems.push(where + " raw byte SHA-256 is " + actualSha + ", descriptor says " + String(row.sha256));
    let badOffset = -1;
    for (let offset = 0; offset < bytes.length; offset += 4) {
      if (!Number.isFinite(bytes.readFloatLE(offset))) { badOffset = offset; break; }
    }
    if (badOffset >= 0) problems.push(where + " raw Float32 bytes contain a non-finite sample at byte " + badOffset);
    captured[build][name] = bytes;
  }
  for (const name of ["convBuf", "n0", "n1"]) {
    const source = captured.source[name], min = captured.min[name];
    if (source && min && !source.equals(min))
      problems.push(rel + ": " + engine + " / " + c.id + " source/min " + name + " raw Float32 bytes differ");
  }
}

function parseArgs(argv) {
  const o = { mode: "core", engines: null, specs: null, observe: false, seed: MATRIX.seed, overrides: {}, out: null, list: false, engine: null, results: null, orchestrator: false, shard: null, merge: null, runContext: null, expectedContext: null };
  // A list option must name at least one entry: "--engines=," or "--specs=" would
  // otherwise select nothing and pass without running a browser.
  const list = (name, value) => {
    const items = value.split(",").map((x) => x.trim()).filter(Boolean);
    if (!items.length) throw new Error("--" + name + "= selects nothing; name at least one, or omit the option");
    return items;
  };
  for (const a of argv) {
    let m;
    if ((m = /^--mode=(.*)$/.exec(a))) o.mode = m[1];
    else if ((m = /^--engines=(.*)$/.exec(a))) o.engines = list("engines", m[1]);
    else if ((m = /^--specs=(.*)$/.exec(a))) o.specs = list("specs", m[1]);
    else if (a === "--observe") o.observe = true;
    else if ((m = /^--seed=(.*)$/.exec(a))) {
      if (!/^\d+$/.test(m[1]) || Number(m[1]) > 0xffffffff) throw new Error("--seed must be an integer from 0 to 4294967295");
      o.seed = Number(m[1]);
    }
    else if ((m = /^--source=(.+)$/.exec(a))) o.overrides.source = path.resolve(m[1]);
    else if ((m = /^--min=(.+)$/.exec(a))) o.overrides.min = path.resolve(m[1]);
    else if ((m = /^--out=(.+)$/.exec(a))) o.out = path.resolve(m[1]);
    else if (a === "--list") o.list = true;
    else if ((m = /^--shard=(\d+)\/(\d+)$/.exec(a))) {
      o.shard = { k: Number(m[1]), n: Number(m[2]) };
      if (!(o.shard.n >= 1 && o.shard.k >= 1 && o.shard.k <= o.shard.n)) throw new Error("--shard=K/N needs 1 <= K <= N");
    }
    else if ((m = /^--merge=(.+)$/.exec(a))) o.merge = path.resolve(m[1]);
    else if ((m = /^--run-context=(.+)$/.exec(a))) o.runContext = path.resolve(m[1]);
    else if ((m = /^--expected-context=(.+)$/.exec(a))) o.expectedContext = m[1] === "github" ? "github" : path.resolve(m[1]);
    else if ((m = /^--engine=(.+)$/.exec(a))) o.engine = m[1];
    else if ((m = /^--results=(.+)$/.exec(a))) o.results = path.resolve(m[1]);
    else if (a === "--orchestrator") o.orchestrator = true;
    else throw new Error("unknown argument " + a);
  }
  for (const e of [...(o.engines || []), ...(o.engine ? [o.engine] : [])]) if (!MATRIX.engines.includes(e)) throw new Error("engine " + e + " is not declared in tests/browser/matrix.js");
  for (const s of o.specs || []) if (!MATRIX.specs[s]) throw new Error("spec " + s + " is not declared in tests/browser/matrix.js");
  if (!["core", "full-mix-qualification"].includes(o.mode)) throw new Error("--mode must be core or full-mix-qualification");
  if (o.mode === "core" && o.specs && o.specs.includes("full-mix"))
    throw new Error("full-mix requires --mode=full-mix-qualification");
  if (o.mode === "full-mix-qualification" && (o.observe || (o.specs &&
      stableJson([...o.specs].sort()) !== stableJson([...QUALIFICATION_SPECS].sort()))))
    throw new Error("full-mix-qualification mode selects only the render and full-mix assert specs");
  if (o.merge && !o.expectedContext) throw new Error("--merge requires --expected-context=github or an explicit JSON context file");
  return o;
}

function selectedSpecs(o) {
  const specs = o.specs || (o.mode === "full-mix-qualification" ? QUALIFICATION_SPECS :
    Object.keys(MATRIX.specs).filter((s) => s !== "full-mix" && (MATRIX.specs[s].kind === "assert" || o.observe)));
  if (!o.shard) return specs;
  const mine = new Set(shardLayout(o.shard.n)[o.shard.k - 1].specs);
  return specs.filter((s) => mine.has(s));
}

/*
 * Splits every declared spec, assert and observe, across n shards by its
 * measured seconds (tests/browser/matrix.js): longest first, each to the shard
 * with the least total so far (the lowest-numbered on a tie). The layout
 * depends only on the declaration, so every job computes the same one.
 */
function shardLayout(n) {
  const names = Object.keys(MATRIX.specs);
  const missing = names.filter((s) => !(MATRIX.specs[s].seconds > 0));
  if (missing.length) throw new Error("sharding needs a measured duration for every spec; add seconds to " + missing.join(", ") + " in tests/browser/matrix.js");
  if (n > names.length) throw new Error("--shard: " + n + " shards for " + names.length + " specs would leave a shard empty");
  const shards = Array.from({ length: n }, (_, i) => ({ shard: i + 1 + "/" + n, specs: [], seconds: 0 }));
  const order = names.slice().sort((a, b) => MATRIX.specs[b].seconds - MATRIX.specs[a].seconds || (a < b ? -1 : 1));
  for (const name of order) {
    const target = shards.reduce((least, x) => (x.seconds < least.seconds ? x : least));
    target.specs.push(name);
    target.seconds += MATRIX.specs[name].seconds;
  }
  return shards;
}

function printMatrix(o) {
  console.log("Declared matrix (tests/browser/matrix.js):");
  console.log("  mode:         " + o.mode);
  console.log("  engines:      " + MATRIX.engines.join(", ") + (o.engines ? "   (this run: " + o.engines.join(", ") + ")" : ""));
  console.log("  builds:       " + MATRIX.builds.map((b) => b + (o.overrides[b] ? " = " + o.overrides[b] : "")).join(", "));
  console.log("  qualities:    " + MATRIX.qualities.join(", "));
  console.log("  sample rates: " + MATRIX.sampleRates.join(", "));
  console.log("  seed:         " + o.seed + " (test pages only; Math.random replaced before the library loads)");
  console.log("  deadlines:    " + MATRIX.caseDeadline + " s per case (default), " + MATRIX.engineDeadline + " s per engine");
  if (o.shard) {
    const layout = shardLayout(o.shard.n);
    for (const x of o.list ? layout : [layout[o.shard.k - 1]])
      console.log("  shard " + x.shard + (x.shard === o.shard.k + "/" + o.shard.n ? " (this run)" : "") + ": " + x.specs.join(", ") + " (" + x.seconds + " s measured)");
  }
  const run = new Set(selectedSpecs(o));
  for (const [name, s] of Object.entries(MATRIX.specs))
    console.log("  spec " + name.padEnd(10) + s.kind.padEnd(8) + ("[" + s.dims.join(" x ") + "]").padEnd(34) + (run.has(name) ? "run   " : "not run") + " " + s.about);
}

/* ---------------- worker: one engine ---------------- */

async function worker(o) {
  const { EngineSession } = require("../tests/browser/lib/cases");
  const { startServer } = require("./browser-server");
  const playwright = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
  const engine = o.engine;
  const out = o.out ? path.join(o.out, engine) : null;
  if (out) fs.mkdirSync(out, { recursive: true });
  const toolchain = resolveBrowserToolchain();
  const results = { engine, version: null, launchError: null, cases: [], relaunches: 0, seed: o.seed, overrides: o.overrides,
    platform: process.platform + "-" + process.arch, browserBundle: browserBundle(toolchain, engine) };
  const save = () => { if (o.results) fs.writeFileSync(o.results, JSON.stringify(results, null, 1)); };
  const session = new EngineSession({ engine, playwright, out });
  try {
    await session.launch();
  } catch (e) {
    results.launchError = String(e && e.message ? e.message : e);
    save();
    console.log("FAIL: " + engine + " could not be launched; a missing browser fails the matrix:\n" + results.launchError);
    return 1;
  }
  results.version = session.version;
  const pinnedBrowserBundle = browserToolchainSpec.isPinnedBrowserBundle(results.browserBundle, process.env, ROOT);
  const reportedVersionMatches = browserToolchainSpec.matchesBrowserVersion(results.browserBundle, session.version);
  if (!pinnedBrowserBundle || !reportedVersionMatches) {
    results.launchError = "reported browser version " + session.version + " differs from pinned " + results.browserBundle.bundleId +
      " version " + String(results.browserBundle.browserVersion) + (pinnedBrowserBundle ? "" : " (bundle is not an exact pinned manifest entry)");
    save();
    console.log("FAIL: " + engine + " " + results.launchError);
    await session.closeBrowser();
    return 1;
  }
  console.log("== " + engine + " " + session.version + " (" + results.platform + ")");
  const server = await startServer({ overrides: o.overrides });
  const shared = { options: o, server, matrix: MATRIX, engine, version: session.version, platform: results.platform,
    browserBundle: results.browserBundle, out };
  let failed = 0;
  try {
    for (const spec of selectedSpecs(o)) {
      const mod = require(path.join(SPEC_DIR, spec + ".js"));
      const cases = mod.cases(shared);
      if (!cases.length) throw new Error("spec " + spec + " produced no cases");
      console.log("-- " + spec + ": " + cases.length + " cases");
      for (const c of cases) {
        c.spec = spec;
        c.kind = c.kind || MATRIX.specs[spec].kind;
        c.deadline = c.deadline || MATRIX.caseDeadline;
        const r = await session.run(c, shared);
        results.cases.push(r);
        if (r.status === "fail") ++failed;
        save();
        if (session.fatal) break;
      }
      if (session.fatal) {
        // The case that set fatal already failed its cleanup check and is
        // counted in `failed`; the stop itself fails the worker below.
        results.fatal = session.fatal;
        console.log("FAIL: " + session.fatal + "; no further case runs in this worker");
        break;
      }
    }
  } finally {
    results.relaunches = session.relaunches;
    results.serverRequests = server.requests.length;
    save();
    await server.close();
    if (!(await session.closeBrowser())) console.log("note: " + engine + " did not close within 15 s (a hung page process); the worker exits anyway");
  }
  const n = results.cases.length;
  if (!n) {
    console.log("FAIL: " + engine + " " + session.version + ": no case ran");
    return 1;
  }
  const fail = failed || results.fatal;
  console.log((fail ? "FAIL: " : "PASS: ") + engine + " " + session.version + ": " + (n - failed) + " of " + n + " cases passed");
  return fail ? 1 : 0;
}

/* ---------------- orchestrator ---------------- */

function summarize(all, o) {
  console.log("\n== Results (" + Object.keys(all).length + " engines)");
  printMatrix(o);
  const specs = selectedSpecs(o);
  const header = "  " + "engine".padEnd(30) + specs.map((s) => s.padEnd(14)).join("");
  console.log(header);
  for (const [engine, r] of Object.entries(all)) {
    let line = "  " + (engine + " " + (r.version || "")).padEnd(30);
    if (!r.version) {
      console.log(line + "NOT LAUNCHED: " + String(r.launchError || r.failure || "no results").split("\n")[0]);
      continue;
    }
    for (const s of specs) {
      const cs = r.cases.filter((c) => c.spec === s);
      const failedCases = cs.filter((c) => c.status === "fail").length;
      const checks = cs.reduce((a, c) => a + c.checks.length, 0);
      const okChecks = cs.reduce((a, c) => a + c.checks.filter((k) => k.ok).length, 0);
      line += (cs.length ? (failedCases ? "FAIL " : "ok ") + okChecks + "/" + checks : "missing").padEnd(14);
    }
    console.log(line);
  }
}

/*
 * Cross-engine comparison of render measurements, when two or more engines ran
 * the render spec in this invocation (CI runs one engine per job, so it is
 * local evidence there). Generated buffers must be identical across engines
 * (deterministic data); GM per-slot energies at the default level and the
 * linear-level makeup gain must agree within tolerances.crossEngineDb.
 */
function crossEngine(all, mode = "core", { expectedSeed = MATRIX.seed, requireSaved = true } = {}) {
  const { DEFAULT } = require("../tests/browser/tolerances");
  const engines = MATRIX.engines.filter((e) => all[e] && all[e].version && all[e].cases.some((c) => c.spec === "render"));
  const checks = [];
  if (engines.length < 2) return checks;
  const ids = [...new Set(engines.flatMap((e) => all[e].cases.filter((c) => c.spec === "render").map((c) => c.id)))].sort();
  for (const id of ids) {
    const cs = engines.map((e) => all[e].cases.find((c) => c.id === id));
    if (cs.some((c) => !c)) {
      checks.push({ name: id + ": render case present in every engine", ok: false, detail: engines.filter((e, i) => !cs[i]).join(", ") + " missing" });
      continue;
    }
    const ms = cs.map((c) => c.observations && c.observations.measurements);
    const bufferValues = cs.map((c) => c.observations && c.observations[RENDER_BUFFER_SHA_OBSERVATION]);
    const bufferProblems = cs.flatMap((c, i) => renderBufferShaProblems(c, bufferValues[i], engines[i] + " " + id, { expectedSeed, requireSaved }));
    const hashLists = bufferValues.map((b) => isRecord(b) ? stableJson(b) : null);
    const hashesMatch = hashLists.every(Boolean) && new Set(hashLists).size === 1;
    checks.push({ name: id + ": actual generated-buffer SHA-256 matches across builds and engines",
      ok: !bufferProblems.length && hashesMatch,
      detail: bufferProblems.length ? bufferProblems.slice(0, 5).join("; ") : hashesMatch ? stableJson(bufferValues[0]) : "source/min/generated-buffer SHA-256 metadata differs across engines" });
    const groups = ["gm-programs-0-31", "gm-programs-32-63", "gm-programs-64-95", "gm-programs-96-127", "gm-drums"];
    let worst = 0, where = "", complete = ms.every(isRecord);
    const malformed = [];
    const overFullScale = [];
    const slots = [32, 32, 32, 32, 47];
    for (let gi = 0; gi < groups.length; ++gi) {
      const group = groups[gi];
      const arrays = ms.map((m) => m && m[group] && m[group].rms);
      const peaks = ms.map((m) => m && m[group] && m[group].peaks);
      const validRms = (xs) => Array.isArray(xs) && xs.length === slots[gi] &&
        xs.every((v) => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1);
      const validPeaks = (xs) => Array.isArray(xs) && xs.length === slots[gi] &&
        xs.every((v) => typeof v === "number" && Number.isFinite(v) && v > 0);
      if (!arrays.every(validRms) || !peaks.every(validPeaks)) {
        complete = false;
        if (!arrays.every(validRms)) malformed.push(group + " RMS");
        if (!peaks.every(validPeaks)) malformed.push(group + " peak");
        continue;
      }
      peaks.forEach((values, engineIndex) => values.forEach((value, slot) => {
        if (value > 1) overFullScale.push(engines[engineIndex] + " " + id + " " + group + " slot " + slot + " = " + value);
      }));
      arrays[0].forEach((_, i) => {
        const v = arrays.map((a) => 20 * Math.log10(Number(a[i])));
        const d = Math.max(...v) - Math.min(...v);
        if (!Number.isFinite(d)) complete = false;
        if (d > worst) { worst = d; where = group + " slot " + i; }
      });
    }
    const enforceHeadroom = mode === "full-mix-qualification";
    checks.push({ name: id + ": GM per-slot energy spread <= " + DEFAULT.crossEngineDb.compressed + " dB (default level)",
      ok: complete && (!enforceHeadroom || !overFullScale.length) && worst <= DEFAULT.crossEngineDb.compressed,
      detail: !complete ? "missing, null or malformed GM measurements: " + malformed.join(", ")
        : enforceHeadroom && overFullScale.length ? "over-full-scale render peak " + overFullScale.slice(0, 5).join("; ")
          : worst.toFixed(3) + " dB at " + where });
    const mk = ms.map((m) => m && m.linearity && m.linearity.makeup);
    const ratios = ms.map((m) => m && m.linearity && m.linearity.ratio);
    if (!mk.every((v) => typeof v === "number" && Number.isFinite(v) && v > 0) ||
        !ratios.every((v) => typeof v === "number" && Number.isFinite(v) && v > 0)) {
      checks.push({ name: id + ": linear-level gain observation present", ok: false, detail: "missing, null or non-positive makeup gain" });
    } else {
      const d = 20 * Math.log10(Math.max(...mk) / Math.min(...mk));
      checks.push({ name: id + ": linear-level gain spread <= " + DEFAULT.crossEngineDb.linear + " dB", ok: Number.isFinite(d) && d <= DEFAULT.crossEngineDb.linear, detail: d.toFixed(4) + " dB" });
    }
  }
  return checks;
}

/* Markdown summary for a GitHub Actions job (GITHUB_STEP_SUMMARY), when set. */
function stepSummary(all, cross, o, status) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const specs = selectedSpecs(o);
  const lines = ["### Browser matrix: " + status, "", "| engine | " + specs.join(" | ") + " |", "| --- | " + specs.map(() => "---").join(" | ") + " |"];
  for (const [engine, r] of Object.entries(all)) {
    if (!r.version) { lines.push("| " + engine + " | not launched: " + String(r.launchError || r.failure || "").split("\n")[0].replace(/\|/g, "/") + " |"); continue; }
    lines.push("| " + engine + " " + r.version + " (" + r.platform + ") | " + specs.map((sp) => {
      const cs = r.cases.filter((c) => c.spec === sp);
      const failedCases = cs.filter((c) => c.status === "fail").length;
      const checks = cs.reduce((a, c) => a + c.checks.length, 0), ok = cs.reduce((a, c) => a + c.checks.filter((k) => k.ok).length, 0);
      return cs.length ? (failedCases ? "FAIL " : "ok ") + ok + "/" + checks + " checks, " + cs.length + " cases" : "missing";
    }).join(" | ") + " |");
  }
  for (const c of cross) lines.push("", (c.ok ? "ok" : "FAIL") + ": " + c.name + " (" + c.detail + ")");
  const failedChecks = [];
  for (const r of Object.values(all)) for (const c of r.cases || []) for (const k of c.checks) if (!k.ok) failedChecks.push("- " + r.engine + " / " + c.id + ": " + k.name + " (" + k.detail + ")");
  if (failedChecks.length) lines.push("", "Failed checks:", ...failedChecks.slice(0, 50));
  fs.appendFileSync(file, lines.join("\n") + "\n");
}

async function orchestrate(o) {
  if (o.merge) return merge(o);
  let runContext = null;
  if (o.runContext) {
    try { runContext = readContextFile(o.runContext, "--run-context"); }
    catch (e) { console.log("FAIL: " + e.message); return 1; }
  }
  printMatrix(o);
  if (o.list) return 0;
  if (o.shard && !selectedSpecs(o).length) {
    console.log("PASS: shard " + o.shard.k + "/" + o.shard.n + " has none of the selected specs; no browser was run");
    return 0;
  }
  // The min build is a fresh build of the current source unless --min names a file.
  if (!o.overrides.min) await require("./test-build").prepare();
  console.log("\n== Analysis self-test");
  const st = analysis.selfTest();
  for (const r of st) console.log("  " + (r.ok ? "ok  " : "FAIL") + " " + r.name + " (" + r.detail + ")");
  if (st.some((r) => !r.ok)) {
    console.log("FAIL: the analysis self-test failed; no browser was run");
    return 1;
  }
  const engines = o.engines || MATRIX.engines;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tinysynth-matrix-"));
  if (o.out) fs.mkdirSync(o.out, { recursive: true });
  // Workers run with cwd = repository root, so pass them the values already
  // normalized here (absolute paths), never the caller's raw arguments.
  const forward = ["--mode=" + o.mode, "--seed=" + o.seed];
  if (o.specs) forward.push("--specs=" + o.specs.join(","));
  if (o.shard) forward.push("--shard=" + o.shard.k + "/" + o.shard.n);
  if (o.observe) forward.push("--observe");
  if (o.overrides.source) forward.push("--source=" + o.overrides.source);
  if (o.overrides.min) forward.push("--min=" + o.overrides.min);
  if (o.out) forward.push("--out=" + o.out);
  const all = {};
  let failed = 0;
  for (const engine of engines) {
    const resultsFile = path.join(tmp, engine + ".json");
    console.log("\n== Worker " + engine);
    const r = await runWithDeadline("node", [__filename, "--engine=" + engine, "--results=" + resultsFile, ...forward], MATRIX.engineDeadline, { cwd: ROOT });
    const failure = describeFailure(r, MATRIX.engineDeadline);
    let res;
    try { res = JSON.parse(fs.readFileSync(resultsFile, "utf8")); } catch { res = { engine, version: null, cases: [] }; }
    if (failure) { ++failed; res.failure = failure; console.log("-- worker " + engine + ": FAILED, " + failure); }
    if (o.shard) res.shard = o.shard.k + "/" + o.shard.n;
    all[engine] = res;
  }
  const cross = crossEngine(all, o.mode, { expectedSeed: o.seed, requireSaved: !!o.out });
  if (o.out) {
    const report = Object.assign({ matrixRun: reportProvenance(o, engines, runContext) }, all, { crossEngine: cross });
    fs.writeFileSync(path.join(o.out, "results.json"), JSON.stringify(report, null, 1));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  summarize(all, o);
  if (cross.length) {
    console.log("\n== Cross-engine comparison (" + Object.keys(all).join(", ") + ")");
    for (const c of cross) console.log("  " + (c.ok ? "ok  " : "FAIL") + " " + c.name + " (" + c.detail + ")");
    if (cross.some((c) => !c.ok)) ++failed;
  }
  const launched = Object.values(all).filter((r) => r.version).length;
  const cases = Object.values(all).reduce((a, r) => a + r.cases.length, 0);
  const failedCases = Object.values(all).reduce((a, r) => a + r.cases.filter((c) => c.status === "fail").length, 0);
  if (o.out) console.log("results: " + path.join(o.out, "results.json"));
  if (failed || launched !== engines.length || !engines.length || !cases) {
    const msg = "browser matrix: " + launched + " of " + engines.length + " engines launched, " + failedCases + " of " + cases + " cases failed";
    stepSummary(all, cross, o, "FAIL (" + msg + ")");
    console.log("FAIL: " + msg);
    return 1;
  }
  stepSummary(all, cross, o, "PASS (" + cases + " cases)");
  console.log("PASS: browser matrix: " + engines.join(", ") + "; " + cases + " cases");
  return 0;
}

/* ---------------- merge: the shards of a CI run, checked together ---------------- */

function expectedContextForMerge(o) {
  if (o.expectedContext === "github") return validateContext(githubContext(), "GitHub expected context");
  return readContextFile(o.expectedContext, "--expected-context");
}

function expectedShardSteps(index, mode = "core") {
  if (mode === "full-mix-qualification")
    return index === 1 ? { "browser-matrix": QUALIFICATION_SPECS, "browser-observe": [] }
      : { "browser-matrix": [], "browser-observe": [] };
  const assigned = new Set(shardLayout(MATRIX.shards)[index - 1].specs.filter((spec) => spec !== "full-mix"));
  const specs = Object.keys(MATRIX.specs).filter((spec) => assigned.has(spec));
  return {
    "browser-matrix": specs.filter((s) => MATRIX.specs[s].kind === "assert"),
    "browser-observe": specs.filter((s) => MATRIX.specs[s].kind === "observe"),
  };
}

function expectedResultPaths(mode = "core") {
  const paths = new Map();
  const shards = mode === "full-mix-qualification" ? 1 : MATRIX.shards;
  for (const engine of MATRIX.engines) for (let index = 1; index <= shards; ++index) {
    for (const [step, specs] of Object.entries(expectedShardSteps(index, mode))) {
      if (!specs.length) continue;
      const artifact = mode === "full-mix-qualification" ? "full-mix-qualification-" + engine : "browser-results-" + engine + "-" + index;
      const rel = path.posix.join(artifact, step, "results.json");
      paths.set(rel, { engine, index, total: shards, step, specs, mode });
    }
  }
  return paths;
}

function validateFiniteNumbers(value, where, problems) {
  if (typeof value === "number" && !Number.isFinite(value)) problems.push(where + " contains a non-finite number");
  else if (Array.isArray(value)) value.forEach((x, i) => validateFiniteNumbers(x, where + "[" + i + "]", problems));
  else if (value && typeof value === "object")
    for (const [key, x] of Object.entries(value)) validateFiniteNumbers(x, where + "." + key, problems);
}

function finiteNumber(value) { return typeof value === "number" && Number.isFinite(value); }

function sampleRoundedOnsetMatches(actualSec, expectedSec, sampleRate) {
  return finiteNumber(actualSec) && finiteNumber(expectedSec) && Number.isSafeInteger(sampleRate) && sampleRate > 0 &&
    Math.round(actualSec * sampleRate) === Math.round(expectedSec * sampleRate);
}

function nativeNoteEvidenceComplete(evidence, fixture, sampleRate) {
  if (!evidence || evidence.complete !== true || evidence.expectedCount !== fixture.notes.length ||
      evidence.createdCount !== fixture.notes.length || !Array.isArray(evidence.rows) ||
      evidence.rows.length !== fixture.notes.length || !Array.isArray(evidence.extras) || evidence.extras.length !== 0 ||
      !Array.isArray(evidence.prunedInstances) || evidence.prunedInstances.length !== 0) return false;
  return fixture.notes.every((want, i) => {
    const row = evidence.rows[i];
    return row && row.id === want.id && row.status === "created" && row.channel === want.channel &&
      row.pitch === want.pitch && row.velocity === want.velocity && row.program === want.program &&
      row.actualProgram === want.program && sampleRoundedOnsetMatches(row.onsetSec, want.onsetSec, sampleRate) &&
      Number.isSafeInteger(row.sourceCount) && row.sourceCount > 0 && row.percussion === (want.channel === 9) && row.pruned === false;
  });
}

function nativeProbeEvidenceComplete(evidence, fixture, sampleRate) {
  if (!evidence || evidence.complete !== true || evidence.expectedCount !== fixture.probes.length ||
      evidence.createdCount !== fixture.probes.length || !Array.isArray(evidence.rows) ||
      evidence.rows.length !== fixture.probes.length || !Array.isArray(evidence.prunedInstances) ||
      evidence.prunedInstances.length !== 0) return false;
  return fixture.probes.every((want, i) => {
    const row = evidence.rows[i];
    return row && row.id === want.id && row.status === "created" && row.channel === want.channel &&
      row.pitch === want.pitch && row.velocity === want.velocity && row.program === want.program &&
      row.actualProgram === want.program && sampleRoundedOnsetMatches(row.onsetSec, want.startSec, sampleRate) &&
      Number.isSafeInteger(row.sourceCount) && row.sourceCount > 0 && row.pruned === false;
  });
}

function firstAttemptPageClean(row, caseChecks, build) {
  const pageCheckName = build + " first attempt completed without scheduler, rejection, page error or network request";
  const pageChecks = Array.isArray(caseChecks) ? caseChecks.filter((check) => check && check.name === pageCheckName) : [];
  return row && row.intervalCount === 1 && Array.isArray(row.rejections) && row.rejections.length === 0 &&
    Array.isArray(row.pageErrors) && row.pageErrors.length === 0 && row.pageErrors.every((x) => typeof x === "string") &&
    Array.isArray(row.aborted) && row.aborted.length === 0 && row.aborted.every((x) => typeof x === "string") &&
    pageChecks.length === 1 && pageChecks[0].ok === true;
}

function parseFloatStereoWav(bytes, expectedSampleRate, expectedFrames) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError("raw WAV bytes must be a Buffer");
  if (!Number.isSafeInteger(expectedFrames) || expectedFrames < 1 || bytes.length !== 44 + expectedFrames * 8)
    throw new Error("raw WAV byte length does not match the exact expected frame count");
  if (bytes.length < 52 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE" ||
      bytes.readUInt32LE(4) !== bytes.length - 8 || bytes.toString("ascii", 12, 16) !== "fmt " ||
      bytes.readUInt32LE(16) !== 16 || bytes.readUInt16LE(20) !== 3 || bytes.readUInt16LE(22) !== 2 ||
      bytes.readUInt32LE(24) !== expectedSampleRate || bytes.readUInt32LE(28) !== expectedSampleRate * 8 ||
      bytes.readUInt16LE(32) !== 8 ||
      bytes.readUInt16LE(34) !== 32 || bytes.toString("ascii", 36, 40) !== "data" ||
      bytes.readUInt32LE(40) !== bytes.length - 44 || (bytes.length - 44) % 8 !== 0 ||
      (bytes.length - 44) / 8 !== expectedFrames)
    throw new Error("raw artifact is not a complete IEEE-float stereo WAV at the required sample rate");
  const frames = (bytes.length - 44) / 8;
  const channels = [new Float32Array(frames), new Float32Array(frames)];
  for (let i = 0; i < frames; ++i) {
    channels[0][i] = bytes.readFloatLE(44 + i * 8);
    channels[1][i] = bytes.readFloatLE(48 + i * 8);
  }
  return { bytes, channels };
}

function readFloatStereoWav(file, expectedSampleRate, expectedFrames) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("raw WAV must be a regular file");
  if (!Number.isSafeInteger(expectedFrames) || expectedFrames < 1 || stat.size !== 44 + expectedFrames * 8)
    throw new Error("raw WAV byte length does not match the exact expected frame count");
  return parseFloatStereoWav(fs.readFileSync(file), expectedSampleRate, expectedFrames);
}

function validateFullMixCase(engine, browserVersion, platform, currentBundle, rel, resultFile, c, expected, problems) {
  const where = rel + ": " + engine + " / " + (c && c.id || "<malformed full-mix case>");
  const obs = c && c.observations && c.observations.fullMix;
  if (!obs || typeof obs !== "object" || Array.isArray(obs)) { problems.push(where + " is missing fullMix evidence"); return; }
  if (!expected) { problems.push(where + " is not in the declared full-mix manifest"); return; }
  const fixture = fullMixSpec.FIXTURE_BY_ID[expected.fixtureId];
  const expectedTop = {
    schemaVersion: 2, scope: "fixture", qualification: "fixture-only-no-production-approval",
    fixtureId: expected.fixtureId, profileKind: expected.profileKind, sampleRate: expected.sampleRate,
    quality: 1, seed: MATRIX.seed, engine, browserVersion, platform, browserBundle: currentBundle, midiSha256: expected.midiSha256,
    setupSha256: expected.setupSha256, settingsSha256: expected.settingsSha256,
    probePlanSha256: expected.probePlanSha256, methodSha256: expected.methodSha256,
    toleranceSha256: expected.toleranceSha256,
    referenceProvenance: fullMixSpec.referenceProvenance(),
    referenceToleranceSha256: fullMixSpec.referenceProvenance().referenceToleranceSha256,
    playbackOriginSec: fullMixSpec.ORIGIN,
    firstAttempt: true,
  };
  for (const [key, value] of Object.entries(expectedTop))
    if (value && typeof value === "object" ? stableJson(obs[key]) !== stableJson(value) : obs[key] !== value)
      problems.push(where + " fullMix " + key + " is missing or mismatched");
  if (!fixture) { problems.push(where + " has an unknown full-mix fixture"); return; }
  if (c.status !== "pass") problems.push(where + " full-mix case status is not pass");
  if (typeof obs.captureEligiblePreBaseline !== "boolean" || !["pass", "fail", "incomplete"].includes(obs.status))
    problems.push(where + " fullMix status/eligibility fields are malformed");
  if (!obs.noteTiming || obs.noteTiming.complete !== fixture.timingComplete ||
      obs.noteTiming.unmatchedNoteOffs !== fixture.unmatchedNoteOffs ||
      obs.noteTiming.unpitchedOneShotCount !== fixture.unpitchedOneShotCount ||
      obs.noteTiming.ambiguousPairings !== fixture.notes.filter((n) => n.pairingAmbiguous).length ||
      obs.noteTiming.durationUnknown !== fixture.notes.filter((n) => n.durationSec === null).length)
    problems.push(where + " note timing provenance differs from independent MIDI decoding");
  const demand = obs.voiceDemand;
  if (!demand || demand.noteOnCount !== fixture.notes.length || demand.maxKnownSimultaneousNotes !== fixture.maxKnownSimultaneous ||
      demand.liveBudget !== fixture.liveVoices || demand.offlineCeiling !== fixture.offlineVoices ||
      demand.offlineCeilingDerivation !== "all independently parsed fixture note-ons (including drums) + two appended probe note-ons + one spare; not the live/realtime budget")
    problems.push(where + " offline/live voice demand does not match independent fixture demand");
  const builds = obs.builds;
  if (!builds || typeof builds !== "object" || Array.isArray(builds) || stableJson(Object.keys(builds).sort()) !== stableJson(["min", "source"])) {
    problems.push(where + " fullMix must contain source and min first-attempt subresults");
    return;
  }
  const refTolerances = fullMixSpec.REFERENCE && fullMixSpec.REFERENCE.tolerances;
  const referenceIdentity = {
    scope: "fixture", fixtureId: expected.fixtureId, profileKind: expected.profileKind, quality: 1, seed: obs.seed,
    engine, browserVersion, platform, sampleRate: expected.sampleRate, browserBundle: currentBundle,
    midiSha256: expected.midiSha256, setupSha256: expected.setupSha256,
    settingsSha256: expected.settingsSha256, probePlanSha256: expected.probePlanSha256,
    methodSha256: expected.methodSha256, toleranceSha256: expected.toleranceSha256,
    playbackOriginSec: fullMixSpec.ORIGIN,
  };
  const selectedReferences = Object.fromEntries(["source", "min"].map((build) => [build,
    fullMixSpec.selectReference(fullMixSpec.REFERENCE, referenceIdentity, build)]));
  const expectedNotes = new Map(fixture.notes.map((n) => [n.id, n]));
  const parsedBuilds = {};
  const buildEligibility = {};

  const readArtifact = (artifact, build, attempt, row, label, diagnosticOnly = false) => {
    const at = where + " " + build + " " + label;
    const suffix = attempt === 1 ? "first" : "diagnostic-repeat";
    const expectedRel = path.posix.join("full-mix", expected.fixtureId + "-q1-" + expected.sampleRate + "-" + build + "-" + suffix + ".wav");
    if (!artifact || artifact.path !== expectedRel || artifact.saved !== true ||
        typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(artifact.sha256) ||
        typeof artifact.pcmSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(artifact.pcmSha256) ||
        !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 52 || artifact.sampleRate !== expected.sampleRate ||
        artifact.channels !== 2 || artifact.encoding !== "WAVE_FORMAT_IEEE_FLOAT") {
      problems.push(at + " raw float32 stereo artifact reference is missing or mismatched");
      return null;
    }
    let rawBytes;
    const expectedFrames = Math.ceil(fixture.renderDurationSec * expected.sampleRate);
    try { rawBytes = readArtifactUnderShard(path.dirname(resultFile), path.join(engine, artifact.path), 44 + expectedFrames * 8); }
    catch (e) { problems.push(at + " raw audio artifact is missing or invalid: " + e.message); return null; }
    let raw;
    try {
      raw = parseFloatStereoWav(rawBytes, expected.sampleRate, expectedFrames);
    }
    catch (e) { problems.push(at + " raw audio artifact is missing or invalid: " + e.message); return null; }
    let artifactValid = true;
    if (raw.bytes.length !== artifact.bytes || sha256(raw.bytes) !== artifact.sha256) {
      problems.push(at + " raw audio artifact byte count/hash differs");
      artifactValid = false;
    }
    const pcmSha256 = sha256(Buffer.concat(raw.channels.map((x) => Buffer.from(x.buffer, x.byteOffset, x.byteLength))));
    if (pcmSha256 !== artifact.pcmSha256) {
      problems.push(at + " raw planar-channel PCM hash does not match the recorded float samples");
      artifactValid = false;
    }
    const pcmChannelsSha256 = raw.channels.map((x) => sha256(Buffer.from(x.buffer, x.byteOffset, x.byteLength)));
    if (Array.isArray(row.pcmSha256) && stableJson(row.pcmSha256) !== stableJson(pcmChannelsSha256)) {
      problems.push(at + " per-channel PCM hashes do not match the raw WAV");
      artifactValid = false;
    }
    const finite = raw.channels.map((x) => analysis.nonFinite(x));
    if (!diagnosticOnly && finite.some((x) => x.nan || x.inf)) {
      problems.push(at + " raw Float32 PCM contains a non-finite sample");
      artifactValid = false;
    }
    const withinFullScale = raw.channels.every((x) => analysis.peak(x) <= 1);
    if (!diagnosticOnly && !withinFullScale) {
      problems.push(at + " raw Float32 PCM contains an over-full-scale sample");
      artifactValid = false;
    }
    let recomputed;
    try { recomputed = fullMixSpec.analyzeChannels(raw.channels, expected.sampleRate, fixture); }
    catch (e) { problems.push(at + " native measurement recomputation failed: " + e.message); return { channels: raw.channels, metrics: null, artifactValid: false, finite: false, withinFullScale: false }; }
    const metricsMatch = !!row.metrics && stableJson(row.metrics) === stableJson(recomputed);
    if (!metricsMatch) {
      problems.push(at + " report measurements differ from analysis recomputed from the raw artifact");
      artifactValid = false;
    }
    return { channels: raw.channels, metrics: recomputed, artifactValid,
      finite: finite.every((x) => !x.nan && !x.inf), withinFullScale, metricsMatch };
  };

  for (const build of ["source", "min"]) {
    const row = builds[build], at = where + " " + build;
    const selectedReference = selectedReferences[build];
    buildEligibility[build] = false;
    if (!row || typeof row !== "object" || Array.isArray(row) || row.firstAttempt !== true || row.attempt !== 1 ||
        !["pass", "fail", "incomplete"].includes(row.result) || typeof row.preBaselineEligible !== "boolean") {
      problems.push(at + " first-attempt status or eligibility is malformed");
    }
    if (!row || row.referenceStatus !== selectedReference.status)
      problems.push(at + " producer reference status differs from the aggregate's exact identity selection");
    const artifact = row && row.artifact;
    const parsed = readArtifact(artifact, build, 1, row || {}, "first attempt");
    if (parsed) parsedBuilds[build] = parsed;
    if (!row || !row.metrics || typeof row.metrics !== "object" || Array.isArray(row.metrics)) {
      problems.push(at + " metrics are missing");
      buildEligibility[build] = false;
      continue;
    }
    if (parsed && parsed.metrics) {
      const metrics = parsed.metrics;
      for (const side of ["left", "right"]) {
        const ch = metrics.channels[side];
        if (ch.finite !== true || ch.nan !== 0 || ch.inf !== 0 || !finiteNumber(ch.fullRenderPeak) || ch.fullRenderPeak <= 0 ||
            !finiteNumber(ch.fullRenderRms) || ch.fullRenderRms <= 0 || !finiteNumber(ch.songPeak) || ch.songPeak <= 0 ||
            !finiteNumber(ch.songRms) || ch.songRms <= 0 || !Array.isArray(ch.windowLevels) || !ch.windowLevels.length)
          problems.push(at + " has missing, non-finite, or silent " + side + " channel data");
        for (const [i, w] of (ch.windowLevels || []).entries())
          if (!w || !finiteNumber(w.startSec) || !finiteNumber(w.durationSec) || !finiteNumber(w.rms) || w.rms < 0 || !finiteNumber(w.levelDb))
            problems.push(at + " " + side + " window " + i + " is malformed");
      }
      const overall = metrics.overall;
      if (!overall || !finiteNumber(overall.rms) || overall.rms <= 0 || !finiteNumber(overall.rawRenderRms) || overall.rawRenderRms <= 0 ||
          !finiteNumber(overall.peak) || overall.peak <= 0 || !Number.isSafeInteger(overall.overFullScaleSamples) || overall.overFullScaleSamples < 0 ||
          !finiteNumber(overall.channelBalanceDb) || !finiteNumber(overall.rawRenderBalanceDb))
        problems.push(at + " has missing, null, or malformed full-mix metrics");
      else if (overall.overFullScaleSamples !== 0 || overall.peak > 1) problems.push(at + " contains an over-full-scale sample");

      if (!Array.isArray(metrics.notes) || metrics.notes.length !== expected.expectedNoteIds.length ||
          stableJson(metrics.notes.map((n) => n && n.id)) !== stableJson(expected.expectedNoteIds)) {
        problems.push(at + " local mixed-bus feature rows differ from the independent MIDI manifest");
      } else for (const note of metrics.notes) {
        const want = note && expectedNotes.get(note.id);
        if (!note || !want || note.channel !== want.channel || note.pitch !== want.pitch || note.program !== want.program ||
            note.onsetSec !== want.onsetSec || note.durationSec !== want.durationSec || note.unpitched !== want.unpitched ||
            note.overlapFeatureOnly !== true || !finiteNumber(note.windowRms) || note.windowRms < 0 || !finiteNumber(note.localPeak) || note.localPeak < 0 ||
            !finiteNumber(note.windowStartSec) || !finiteNumber(note.windowDurationSec) || note.windowDurationSec <= 0)
          problems.push(at + " local note-window feature is missing or mismatched: " + String(note && note.id));
      }
      const voiceRows = row.noteInstances;
      const voicesComplete = nativeNoteEvidenceComplete(voiceRows, fixture, expected.sampleRate);
      if (!voicesComplete)
        problems.push(at + " actual native voice/source creation, prune, or event mapping is incomplete");
      const probeRows = row.probeInstances;
      const probesCreated = nativeProbeEvidenceComplete(probeRows, fixture, expected.sampleRate);
      if (!probesCreated)
        problems.push(at + " actual isolated-probe voice/source creation or prune evidence is incomplete");

      const downbeat = metrics.downbeat;
      if (!downbeat || downbeat.status !== "measured" || downbeat.noteId !== expected.downbeatNoteId ||
          downbeat.expectedPitch !== expected.downbeatExpectedPitch || !finiteNumber(downbeat.targetHz) || downbeat.targetHz <= 0 ||
          !finiteNumber(downbeat.bandRms) || downbeat.bandRms <= 0 || !finiteNumber(downbeat.leftBandRms) || downbeat.leftBandRms <= 0 ||
          !finiteNumber(downbeat.rightBandRms) || downbeat.rightBandRms <= 0 || downbeat.channel !== "stereo")
        problems.push(at + " fixed-target mixed-bus downbeat frequency-projection observation is missing or malformed");
      const probes = metrics.probes;
      let probeMetricsComplete = Array.isArray(probes) && probes.length === expected.expectedPitchProbeIds.length &&
        stableJson(probes.map((x) => x && x.id)) === stableJson(expected.expectedPitchProbeIds) &&
        probes.every((x) => x && x.status === "measured");
      if (!Array.isArray(probes) || probes.length !== expected.expectedPitchProbeIds.length ||
          stableJson(probes.map((x) => x && x.id)) !== stableJson(expected.expectedPitchProbeIds))
        problems.push(at + " isolated fixture-timbre probe list is incomplete or reordered");
      else for (const probe of probes) {
        if (!probe || probe.status !== "measured" || !finiteNumber(probe.expectedPitch) || !finiteNumber(probe.pitchCents) ||
            Math.abs(probe.pitchCents) > fullMixSpec.PROBE_PITCH_LIMIT_CENTS ||
            !finiteNumber(probe.spectralPeakToGlobalDb) || probe.spectralPeakToGlobalDb < -36 ||
            !finiteNumber(probe.toneFractionDb) || probe.toneFractionDb < -12 || !finiteNumber(probe.onsetMs) ||
            !finiteNumber(probe.levelRms) || probe.levelRms <= 0 || !Array.isArray(probe.envelope) || probe.envelope.length !== 40 ||
            probe.envelope.some((x) => !finiteNumber(x) || x < 0))
          problems.push(at + " isolated pitch/envelope probe is incomplete: " + String(probe && probe.id));
      }
      const isolationComplete = Array.isArray(metrics.isolation) && metrics.isolation.length === fixture.probes.length &&
        fixture.probes.every((want, i) => metrics.isolation[i] && metrics.isolation[i].id === want.id &&
          metrics.isolation[i].startSec === want.startSec && finiteNumber(metrics.isolation[i].preProbeRms) &&
          metrics.isolation[i].preProbeRms <= 1e-5);
      if (!finiteNumber(metrics.relativeProbeLevelDb) || !isolationComplete)
        problems.push(at + " relative-level or post-song quiet-separation evidence is incomplete");
      if (!metrics.transient || metrics.transient.noteId !== fixture.notes[0].id ||
          !Array.isArray(metrics.transient.left) || !Array.isArray(metrics.transient.right) ||
          metrics.transient.left.length !== metrics.transient.right.length ||
          metrics.transient.left.some((x) => !finiteNumber(x) || x < 0) || metrics.transient.right.some((x) => !finiteNumber(x) || x < 0))
        problems.push(at + " first-downbeat 1 ms onset/envelope evidence is missing");
      const pageClean = firstAttemptPageClean(row, c.checks, build);
      if (!pageClean)
        problems.push(at + " first-attempt scheduler, rejection, page-error or network-abort evidence is not clean");
      let faultSensitivityComplete = false;
      if (parsed && Array.isArray(voiceRows && voiceRows.rows)) {
        try {
          const independentlyRecomputedFault = fullMixSpec.faultSensitivity(parsed.channels, expected.sampleRate, fixture, metrics, voiceRows);
          const faultSensitivityMatches = stableJson(row.faultSensitivity) === stableJson(independentlyRecomputedFault);
          faultSensitivityComplete = faultSensitivityMatches && independentlyRecomputedFault.checksPass === true;
          if (!faultSensitivityMatches)
            problems.push(at + " retained fault-sensitivity schema or verdict differs from first-attempt PCM/native evidence");
          else if (!independentlyRecomputedFault.checksPass)
            problems.push(at + " first-attempt fault-sensitivity checks did not pass");
        } catch (e) {
          problems.push(at + " retained fault-sensitivity evidence cannot be recomputed: " + e.message);
        }
      } else problems.push(at + " retained fault-sensitivity evidence cannot be recomputed without first-attempt PCM/native rows");
      const timingComplete = fixture.timingComplete === true && obs.noteTiming && obs.noteTiming.complete === true;
      const finiteBoth = !!parsed && parsed.finite && Object.values(metrics.channels || {}).length === 2 &&
        Object.values(metrics.channels || {}).every((x) => x && x.finite === true && x.nan === 0 && x.inf === 0);
      const fullScale = !!parsed && parsed.withinFullScale && metrics.overall && metrics.overall.overFullScaleSamples === 0 &&
        finiteNumber(metrics.overall.peak) && metrics.overall.peak <= 1;
      const artifactRetained = !!(artifact && artifact.saved === true && parsed && parsed.artifactValid);
      buildEligibility[build] = finiteBoth && fullScale && voicesComplete && probesCreated && probeMetricsComplete &&
        isolationComplete && pageClean && timingComplete && faultSensitivityComplete && artifactRetained;
    }

    const diagnostic = row && row.diagnosticRepeat;
    if (!diagnostic || diagnostic.attempt !== 2 || diagnostic.role !== "diagnostic-only" ||
        diagnostic.neverPromotesFirstAttempt !== true || diagnostic.firstVerdict !== row.result ||
        !["captured", "incomplete"].includes(diagnostic.result)) {
      problems.push(at + " diagnostic repeat record is malformed or could promote/replace the first attempt");
    } else if (diagnostic.result === "incomplete") {
      if (typeof diagnostic.error !== "string" || !diagnostic.error)
        problems.push(at + " incomplete diagnostic repeat must retain its error separately");
    } else if (!diagnostic.sameEnginePcm || typeof diagnostic.sameEnginePcm !== "object" || Array.isArray(diagnostic.sameEnginePcm) ||
        typeof diagnostic.sameEnginePcm.ok !== "boolean" ||
        !["identical", "summation", "mismatch"].includes(diagnostic.sameEnginePcm.category) ||
        !(finiteNumber(diagnostic.sameEnginePcm.maxDiff) || diagnostic.sameEnginePcm.maxDiff === null) ||
        !finiteNumber(diagnostic.sameEnginePcm.tolerance) ||
        !Number.isSafeInteger(diagnostic.sameEnginePcm.firstDifferingSample) || !Array.isArray(diagnostic.sameEnginePcm.reasons) ||
        diagnostic.sameEnginePcm.reasons.some((x) => typeof x !== "string") || !diagnostic.metrics) {
      problems.push(at + " captured diagnostic repeat evidence is malformed");
    } else {
      const diagnosticParsed = readArtifact(diagnostic.artifact, build, 2, diagnostic, "diagnostic repeat", true);
      if (diagnosticParsed && diagnosticParsed.metrics && parsed && parsed.metrics) {
        if (stableJson(diagnostic.metrics) !== stableJson(diagnosticParsed.metrics))
          problems.push(at + " diagnostic metrics differ from raw diagnostic PCM");
        const repeatDiff = fullMixSpec.sameEnginePcm(parsed.channels, diagnosticParsed.channels, engine);
        if (stableJson(diagnostic.sameEnginePcm) !== stableJson(repeatDiff))
          problems.push(at + " diagnostic PCM comparison differs from raw first/repeat samples");
      }
    }
  }

  let sourceMin = null;
  if (parsedBuilds.source && parsedBuilds.min && builds.source && builds.min) {
    sourceMin = fullMixSpec.sameEnginePcm(parsedBuilds.source.channels, parsedBuilds.min.channels, engine);
    if (!sourceMin.ok || stableJson(obs.sourceMinPcmComparison) !== stableJson(sourceMin) ||
        stableJson(builds.source.sourceMinPcmComparison) !== stableJson(sourceMin) ||
        stableJson(builds.min.sourceMinPcmComparison) !== stableJson(sourceMin))
      problems.push(where + " source/min first-attempt PCM differs beyond the measured same-engine tolerance or report");
  }
  const derivedBuilds = {};
  for (const build of ["source", "min"]) {
    const row = builds[build], at = where + " " + build;
    const eligible = buildEligibility[build] === true && !!(sourceMin && sourceMin.ok);
    const selectedReference = selectedReferences[build];
    const metrics = parsedBuilds[build] && parsedBuilds[build].metrics;
    const comparisonProblems = selectedReference.status === "measured" && metrics
      ? fullMixSpec.compareBuildToReference(metrics, selectedReference.reference.metrics, refTolerances)
      : selectedReference.problems;
    const expectedResult = !eligible ? "fail"
      : selectedReference.status !== "measured" ? "incomplete"
        : comparisonProblems.length ? "fail" : "pass";
    if (!row || row.preBaselineEligible !== eligible)
      problems.push(at + " producer eligibility differs from independently validated first-attempt evidence");
    if (!row || row.result !== expectedResult)
      problems.push(at + " producer first-attempt result differs from aggregate derivation (expected " + expectedResult + ")");
    if (row && row.result !== "pass") problems.push(at + " first-attempt result is " + row.result);
    if (row && stableJson(row.comparisonProblems) !== stableJson(comparisonProblems))
      problems.push(at + " producer comparison diagnostics differ from aggregate reference selection/recomputation");
    if (row) derivedBuilds[build] = { ...row, preBaselineEligible: eligible, result: expectedResult };
  }
  if (builds.source && stableJson(obs.faultSensitivity) !== stableJson(builds.source.faultSensitivity))
    problems.push(where + " aggregate fault-sensitivity summary differs from the independently validated source build row");
  const derivedStatus = fullMixSpec.deriveFullMixStatus(derivedBuilds, !!(sourceMin && sourceMin.ok));
  if (obs.captureEligiblePreBaseline !== derivedStatus.captureEligiblePreBaseline || obs.status !== derivedStatus.status)
    problems.push(where + " producer fullMix status/eligibility differs from aggregate first-attempt derivation");
  if (!builds.source || !builds.min || !obs.rawArtifacts ||
      stableJson(obs.rawArtifacts) !== stableJson({ source: builds.source.artifact, min: builds.min.artifact }))
    problems.push(where + " raw first-attempt artifact references do not match the build subresults");
  if (!obs.setupProvenance || stableJson(obs.setupProvenance) !== stableJson(expected.setupProvenance))
    problems.push(where + " fixture setup provenance is missing or mismatched");
}

function validateCases(engine, rel, resultFile, actual, expected, mode, problems) {
  if (!Array.isArray(actual)) {
    problems.push(rel + ": " + engine + " cases must be an array");
    return;
  }
  const expectedById = new Map(expected.map((c) => [c.id, c]));
  const seen = new Set();
  for (const c of actual) {
    if (!c || typeof c !== "object" || typeof c.id !== "string" || !c.id) {
      problems.push(rel + ": " + engine + " contains a malformed case record");
      continue;
    }
    const where = rel + ": " + engine + " / " + c.id;
    if (seen.has(c.id)) problems.push(where + " is duplicated");
    seen.add(c.id);
    const want = expectedById.get(c.id);
    if (!want) {
      problems.push(where + " is not declared by the current spec");
      continue;
    }
    if (c.spec !== want.spec || c.kind !== want.kind || stableJson(c.dims || {}) !== stableJson(want.dims))
      problems.push(where + " has a spec, kind or dimension mismatch");
    if (!c.dims || typeof c.dims !== "object" || Array.isArray(c.dims))
      problems.push(where + " dimensions must be an object");
    if (typeof c.seconds !== "number" || !Number.isFinite(c.seconds) || c.seconds < 0)
      problems.push(where + " seconds must be a finite non-negative number");
    const statuses = want.kind === "assert" ? ["pass"] : ["pass", "observed"];
    if (!statuses.includes(c.status)) problems.push(where + " has invalid status " + String(c.status));
    if (!Array.isArray(c.checks)) problems.push(where + " checks must be an array");
    else {
      if (want.kind === "assert" && !c.checks.length) problems.push(where + " has no asserted checks");
      for (const [i, check] of c.checks.entries()) {
        if (!check || typeof check.name !== "string" || typeof check.ok !== "boolean" || typeof check.detail !== "string")
          problems.push(where + " check " + i + " is malformed");
        else if (!check.ok) problems.push(where + " failed check: " + check.name);
      }
    }
    if (!c.observations || typeof c.observations !== "object" || Array.isArray(c.observations))
      problems.push(where + " observations must be an object");
    if (want.spec === "render") {
      const observations = c.observations && typeof c.observations === "object" ? c.observations : {};
      problems.push(...renderBufferShaProblems(c, observations[RENDER_BUFFER_SHA_OBSERVATION], engine + " " + c.id));
      generatedBufferArtifactProblems(engine, rel, resultFile, c, want, problems);
      const m = observations.measurements;
      const groups = ["gm-programs-0-31", "gm-programs-32-63", "gm-programs-64-95", "gm-programs-96-127", "gm-drums"];
      if (!m || typeof m !== "object" || Array.isArray(m)) problems.push(where + " is missing render measurements");
      else {
        for (const [i, group] of groups.entries()) {
          const row = m[group];
          const count = i === groups.length - 1 ? 47 : 32;
          const validRms = (xs) => Array.isArray(xs) && xs.length === count &&
            xs.every((v) => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1);
          const validPeaks = (xs) => Array.isArray(xs) && xs.length === count &&
            xs.every((v) => typeof v === "number" && Number.isFinite(v) && v > 0);
          if (!row || !validRms(row.rms)) problems.push(where + " has missing, null or malformed " + group + " RMS observations");
          if (!row || !validPeaks(row.peaks)) problems.push(where + " has missing, null or malformed " + group + " peak observations");
          else if (mode === "full-mix-qualification") row.peaks.forEach((value, slot) => {
            if (value > 1) problems.push(engine + " " + c.id + " has over-full-scale peak for " + group + " slot " + slot + " = " + value);
          });
        }
        const linearity = m.linearity;
        if (!linearity || typeof linearity !== "object" || ![linearity.ratio, linearity.makeup].every((v) => typeof v === "number" && Number.isFinite(v) && v > 0))
          problems.push(where + " has missing, null or malformed linearity observations");
      }
    }
    validateFiniteNumbers(c, where, problems);
  }
  for (const want of expected) if (!seen.has(want.id)) problems.push(rel + ": " + engine + " is missing case " + want.id);
}

function merge(o) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name === "results.json") files.push(p);
    }
  };
  if (fs.existsSync(o.merge)) walk(o.merge);
  files.sort();
  const problems = [];
  let expectedContext = null, expectedConfig = null, expectedBuilds = null, expectedBrowserToolchain = null;
  if (o.mode === "full-mix-qualification") for (const issue of fullMixSpec.referenceCoverageProblems())
    problems.push("full-mix reference: " + issue);
  try { expectedContext = expectedContextForMerge(o); } catch (e) { problems.push(e.message); }
  try { expectedConfig = matrixConfigSha256(); } catch (e) { problems.push("cannot fingerprint current browser configuration: " + e.message); }
  try { expectedBuilds = buildSha256(); } catch (e) { problems.push("cannot identify current source/min builds: " + e.message); }
  try { expectedBrowserToolchain = resolveBrowserToolchain(); } catch (e) { problems.push("cannot independently resolve current browser toolchain: " + e.message); }
  const all = {};
  const shards = [], expectedPaths = expectedResultPaths(o.mode), foundPaths = new Map(), seenCases = new Map();
  const versions = {}, platforms = {};
  for (const file of files) {
    const rel = path.relative(o.merge, file);
    const parts = rel.split(path.sep);
    const coreRootMatch = /^browser-results-(chromium|firefox|webkit)-(\d+)$/.exec(parts[0] || "");
    const qualificationRootMatch = /^full-mix-qualification-(chromium|firefox|webkit)$/.exec(parts[0] || "");
    const rootMatch = coreRootMatch || qualificationRootMatch;
    const index = coreRootMatch ? Number(coreRootMatch[2]) : qualificationRootMatch ? 1 : NaN;
    const artifactEngine = coreRootMatch ? coreRootMatch[1] : qualificationRootMatch && qualificationRootMatch[1];
    const expectedPath = expectedPaths.get(rel.split(path.sep).join(path.posix.sep));
    if (!rootMatch || parts.length !== 3 || !expectedPath || !["browser-matrix", "browser-observe"].includes(parts[1])) {
      problems.push(rel + ": unexpected result path");
    } else {
      const key = artifactEngine + "/" + index + "/" + parts[1];
      if (foundPaths.has(key)) problems.push(rel + ": duplicate result for " + key + " also in " + foundPaths.get(key));
      foundPaths.set(key, rel);
    }
    let data;
    try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { problems.push(rel + ": unreadable (" + e.message + ")"); continue; }
    if (!data || typeof data !== "object" || Array.isArray(data)) { problems.push(rel + ": result must be a JSON object"); continue; }
    const meta = data.matrixRun;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) problems.push(rel + ": missing matrixRun provenance");
    else {
      if (meta.schemaVersion !== PROVENANCE_SCHEMA) problems.push(rel + ": unsupported provenance schema " + String(meta.schemaVersion));
      if (expectedContext) for (const key of PROVENANCE_CONTEXT_FIELDS)
        if (meta[key] !== expectedContext[key]) problems.push(rel + ": stale or forged " + key + " (expected " + expectedContext[key] + ")");
      if (expectedConfig && meta.matrixConfigSha256 !== expectedConfig) problems.push(rel + ": browser configuration fingerprint differs from the aggregate checkout");
      if (stableJson(meta.fullMixReference) !== stableJson(fullMixSpec.referenceProvenance()))
        problems.push(rel + ": full-mix reference provenance differs from the aggregate checkout");
      if (expectedBuilds && stableJson(meta.buildSha256) !== stableJson(expectedBuilds)) problems.push(rel + ": source/min build hashes differ from the aggregate checkout");
      if (expectedBrowserToolchain && stableJson(meta.browserToolchain) !== stableJson(expectedBrowserToolchain))
        problems.push(rel + ": Playwright/browser bundle identity differs from the aggregate checkout");
      if (rootMatch) {
        if (meta.engine !== artifactEngine) problems.push(rel + ": provenance engine does not match artifact identity");
        const expectedTotal = expectedPath ? expectedPath.total : o.mode === "full-mix-qualification" ? 1 : MATRIX.shards;
        if (!meta.shard || meta.shard.index !== index || meta.shard.total !== expectedTotal)
          problems.push(rel + ": provenance shard does not match artifact identity");
        if (!expectedPath || expectedPath.mode !== o.mode || !meta.selection || meta.selection.mode !== o.mode ||
            meta.selection.kind !== (parts[1] === "browser-matrix" ? "assert" : "observe") ||
            stableJson(meta.selection.specs) !== stableJson(expectedPath.specs) || meta.selection.seed !== MATRIX.seed)
          problems.push(rel + ": declared selection does not match the required shard configuration");
      }
    }
    const engineKeys = Object.keys(data).filter((key) => key !== "matrixRun" && key !== "crossEngine");
    if (engineKeys.length !== 1) {
      problems.push(rel + ": expected exactly one engine result, found " + engineKeys.join(", "));
      continue;
    }
    const reportEngine = engineKeys[0];
    if (!MATRIX.engines.includes(reportEngine)) { problems.push(rel + ": undeclared engine " + reportEngine); continue; }
    if (artifactEngine && reportEngine !== artifactEngine) problems.push(rel + ": result engine does not match artifact identity");
    const r = data[reportEngine];
    if (!r || typeof r !== "object" || Array.isArray(r)) { problems.push(rel + ": " + reportEngine + " result must be an object"); continue; }
    if (r.engine !== reportEngine) problems.push(rel + ": " + reportEngine + " result engine identity is missing or mismatched");
    let currentBundle = null;
    if (expectedBrowserToolchain) {
      try { currentBundle = browserBundle(expectedBrowserToolchain, reportEngine); } catch (e) { problems.push(rel + ": " + e.message); }
      const pinned = currentBundle && currentBundle.engine === reportEngine &&
        browserToolchainSpec.isPinnedBrowserBundle(currentBundle, process.env, ROOT);
      if (!pinned || stableJson(r.browserBundle) !== stableJson(currentBundle))
        problems.push(rel + ": " + reportEngine + " Playwright/browser revision bundle differs from the aggregate checkout");
    }
    const expectedSpecs = expectedPath ? expectedPath.specs : [];
    const manifest = caseManifest(reportEngine, expectedSpecs);
    validateCases(reportEngine, rel, file, r && r.cases, manifest, o.mode, problems);
    if (Array.isArray(r.cases)) for (const c of r.cases) if (c && c.spec === "full-mix" && typeof c.id === "string")
      validateFullMixCase(reportEngine, r.version, r.platform, currentBundle, rel, file, c, FULL_MIX_CASES.get(c.id), problems);
    if (typeof r.version !== "string" || !r.version) problems.push(rel + ": " + reportEngine + " did not launch: " + String(r.launchError || "no browser version").split("\n")[0]);
    if (currentBundle && r.version && !browserToolchainSpec.matchesBrowserVersion(currentBundle, r.version))
      problems.push(rel + ": " + reportEngine + " reported browser version differs from its pinned revision bundle");
    if (r.failure) problems.push(rel + ": " + reportEngine + " worker failed: " + String(r.failure).split("\n")[0]);
    if (r.fatal) problems.push(rel + ": " + reportEngine + " stopped early: " + String(r.fatal).split("\n")[0]);
    if (r.launchError) problems.push(rel + ": " + reportEngine + " launch failed: " + String(r.launchError).split("\n")[0]);
    if (typeof r.platform !== "string" || !r.platform) problems.push(rel + ": " + reportEngine + " is missing its platform identity");
    if (r.version && versions[reportEngine] && versions[reportEngine] !== r.version)
      problems.push(rel + ": " + reportEngine + " browser version differs from another shard");
    if (r.version) versions[reportEngine] = r.version;
    if (r.platform && platforms[reportEngine] && platforms[reportEngine] !== r.platform)
      problems.push(rel + ": " + reportEngine + " platform differs from another shard");
    if (r.platform) platforms[reportEngine] = r.platform;
    const resultVersion = typeof r.version === "string" && r.version ? r.version : null;
    const resultPlatform = typeof r.platform === "string" && r.platform ? r.platform : null;
    const entry = all[reportEngine] || (all[reportEngine] = { engine: reportEngine, version: resultVersion, platform: resultPlatform, cases: [] });
    const safeCases = Array.isArray(r.cases) ? r.cases.filter((c) => c && typeof c === "object" && typeof c.id === "string" &&
      typeof c.seconds === "number" && Number.isFinite(c.seconds) && c.seconds >= 0 && Array.isArray(c.checks) &&
      c.checks.every((k) => k && typeof k === "object" && typeof k.ok === "boolean" && typeof k.name === "string" && typeof k.detail === "string")) : [];
    entry.cases.push(...safeCases);
    for (const c of safeCases) {
      if (c && typeof c.id === "string") {
        const key = reportEngine + "/" + c.id;
        if (seenCases.has(key)) problems.push(key + " appears in more than one result (" + seenCases.get(key) + ", " + rel + ")");
        else seenCases.set(key, rel);
      }
    }
    const specs = [...new Set(safeCases.map((c) => c.spec).filter((s) => typeof s === "string"))];
    shards.push({ engine: reportEngine, shard: index ? index + "/" + (expectedPath ? expectedPath.total : MATRIX.shards) : "?", file: rel, specs,
      seconds: safeCases.reduce((a, c) => a + c.seconds, 0) });
  }
  for (const [rel] of expectedPaths) if (!files.some((file) => path.relative(o.merge, file).split(path.sep).join(path.posix.sep) === rel))
    problems.push(rel + ": required shard result is missing");
  for (const engine of MATRIX.engines) {
    if (!all[engine]) problems.push(engine + ": no valid shard results");
    else if (!all[engine].cases.length) problems.push(engine + ": no cases were reported");
  }
  const cross = crossEngine(all, o.mode, { expectedSeed: MATRIX.seed, requireSaved: true });
  for (const c of cross) if (!c.ok) problems.push("cross-engine: " + c.name + " (" + c.detail + ")");
  const declared = Object.keys(MATRIX.specs);
  const view = { mode: o.mode, specs: selectedSpecs(o), engines: null, overrides: {}, seed: MATRIX.seed };
  summarize(all, view);
  console.log("\n== Shards (case time; each job also spends ~1 min on setup and launches)");
  for (const x of shards) console.log("  " + (x.engine + " " + x.shard).padEnd(16) + Math.round(x.seconds).toString().padStart(5) + " s  " + x.specs.join(", ") + "  (" + x.file + ")");
  console.log("\n== Measured seconds per spec (sum of case times) vs declared in tests/browser/matrix.js");
  const timeRows = [];
  for (const spec of declared) {
    const per = MATRIX.engines.map((e) => (all[e] ? all[e].cases.filter((c) => c.spec === spec).reduce((a, c) => a + (c.seconds || 0), 0) : 0));
    timeRows.push("| " + spec + " | " + MATRIX.specs[spec].seconds + " | " + per.map((v) => v.toFixed(0)).join(" | ") + " |");
    console.log("  " + spec.padEnd(12) + String(MATRIX.specs[spec].seconds).padStart(5) + " declared  " + MATRIX.engines.map((e, i) => e + " " + per[i].toFixed(0)).join(", "));
  }
  console.log("\n== Cross-engine comparison (merged shards)");
  for (const c of cross) console.log("  " + (c.ok ? "ok  " : "FAIL") + " " + c.name + " (" + c.detail + ")");
  const status = problems.length ? "FAIL (" + problems.length + " problems)" : "PASS (" + Object.values(all).reduce((a, r) => a + r.cases.length, 0) + " cases, " + files.length + " result files)";
  stepSummary(all, cross, view, status);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = ["", "| engine | shard | case seconds | specs |", "| --- | --- | ---: | --- |",
      ...shards.map((x) => "| " + x.engine + " | " + x.shard + " | " + Math.round(x.seconds) + " | " + x.specs.join(", ") + " |"),
      "", "| spec | declared s | " + MATRIX.engines.join(" s | ") + " s |", "| --- | ---: |" + MATRIX.engines.map(() => " ---: |").join(""), ...timeRows];
    if (problems.length) lines.push("", "Problems:", ...problems.slice(0, 50).map((p) => "- " + p));
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  }
  if (problems.length) {
    console.log("\nProblems:");
    for (const p of problems) console.log("  " + p);
    console.log("FAIL: browser matrix shards: " + problems.length + " problems in " + files.length + " result files");
    return 1;
  }
  console.log("PASS: browser matrix shards: every declared spec ran once per engine (" + MATRIX.engines.join(", ") + ") and every case passed");
  return 0;
}

/* ---------------- launcher ---------------- */

/*
 * The command-line process only launches the orchestrator (this script with
 * --orchestrator, over IPC) and exits with the status it reports. The
 * orchestrator reports its status after printing its last line. If it has not
 * exited EXIT_GRACE seconds later, the launcher kills it and exits with that
 * status anyway. A full local run printed its final "PASS:" line and then never
 * exited: 0% CPU for 42 minutes, holding the shared browser lock. No exit
 * listener or open handle can keep process.exit() from returning, so the
 * process stalled in Node's own teardown; the cause was not isolated. The
 * launcher holds no browsers, results or children other than the
 * orchestrator. SIGINT and SIGTERM are passed on to the orchestrator, which
 * stops its engine workers' process groups (run-with-deadline.js).
 */
const EXIT_GRACE = 30;

function launch(argv) {
  const { fork } = require("child_process");
  const child = fork(__filename, ["--orchestrator", ...argv], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  let reported = null, grace = null;
  child.on("message", (m) => {
    if (!m || typeof m.status !== "number" || reported !== null) return;
    reported = m.status;
    grace = setTimeout(() => {
      // stderr: the orchestrator's PASS:/FAIL: line stays the last line on stdout.
      console.error("note: the orchestrator did not exit within " + EXIT_GRACE + " s of reporting its result; it was killed (exit status " + reported + " kept)");
      child.kill("SIGKILL");
      process.exit(reported);
    }, EXIT_GRACE * 1000);
  });
  child.on("exit", (code, signal) => {
    clearTimeout(grace);
    if (reported === null && signal) console.log("FAIL: the orchestrator was ended by " + signal);
    process.exit(reported !== null ? reported : code === null ? 1 : code);
  });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
}

if (require.main === module) {
  let o;
  const argv = process.argv.slice(2);
  try {
    o = parseArgs(argv);
  } catch (e) {
    console.log("FAIL: " + e.message);
    process.exit(2);
  }
  if (!o.engine && !o.orchestrator) launch(argv);
  else {
    // The orchestrator reports its status to the launcher before exiting.
    const done = (status) => (process.send ? process.send({ status }, () => process.exit(status)) : process.exit(status));
    (o.engine ? worker(o) : orchestrate(o)).then(done, (e) => {
      console.log("FAIL: " + (e && e.stack ? e.stack : e));
      done(1);
    });
  }
}

module.exports = {
  parseArgs,
  worker,
  shardLayout,
  selectedSpecs,
  expectedResultPaths,
  caseManifest,
  reportProvenance,
  resolveBrowserToolchain,
  browserBundle,
  matrixConfigSha256,
  buildSha256,
  readFloatStereoWav,
  parseFloatStereoWav,
  readArtifactUnderShard,
  sampleRoundedOnsetMatches,
  nativeNoteEvidenceComplete,
  nativeProbeEvidenceComplete,
  firstAttemptPageClean,
  validateFullMixCase,
  crossEngine,
  renderBufferShaProblems,
  generatedBufferArtifactProblems,
  merge,
};
