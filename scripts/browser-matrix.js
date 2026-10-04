#!/usr/bin/env node
/*
 * Browser and rendered-audio matrix (#16): Chromium, Firefox and WebKit, the
 * source and minified builds, both quality modes and two sample rates. The
 * matrix is declared in tests/browser/matrix.js and printed with the results.
 *
 * Usage: node scripts/browser-matrix.js [options]
 *   --engines=chromium,firefox,webkit   engines to run (default: all declared)
 *   --specs=embed,render,...            specs to run (default: every "assert" spec)
 *   --observe                           also run the observe-only specs (hang, variation)
 *   --seed=N                            Math.random seed for the test pages
 *   --source=PATH --min=PATH            test another copy of a build (for example a
 *                                       deliberately broken scratch copy). Without
 *                                       --min, the min build is a fresh build of the
 *                                       current source (scripts/test-build.js)
 *   --out=DIR                           write results.json, renders (WAV) and logs there
 *   --list                              print the matrix and exit
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
const { runWithDeadline, describeFailure } = require("./run-with-deadline");
const { MATRIX } = require("../tests/browser/matrix");
const analysis = require("../tests/browser/lib/analysis");

const ROOT = path.resolve(__dirname, "..");
const SPEC_DIR = path.join(ROOT, "tests", "browser", "specs");

function parseArgs(argv) {
  const o = { engines: null, specs: null, observe: false, seed: MATRIX.seed, overrides: {}, out: null, list: false, engine: null, results: null, orchestrator: false };
  // A list option must name at least one entry: "--engines=," or "--specs=" would
  // otherwise select nothing and pass without running a browser.
  const list = (name, value) => {
    const items = value.split(",").map((x) => x.trim()).filter(Boolean);
    if (!items.length) throw new Error("--" + name + "= selects nothing; name at least one, or omit the option");
    return items;
  };
  for (const a of argv) {
    let m;
    if ((m = /^--engines=(.*)$/.exec(a))) o.engines = list("engines", m[1]);
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
    else if ((m = /^--engine=(.+)$/.exec(a))) o.engine = m[1];
    else if ((m = /^--results=(.+)$/.exec(a))) o.results = path.resolve(m[1]);
    else if (a === "--orchestrator") o.orchestrator = true;
    else throw new Error("unknown argument " + a);
  }
  for (const e of [...(o.engines || []), ...(o.engine ? [o.engine] : [])]) if (!MATRIX.engines.includes(e)) throw new Error("engine " + e + " is not declared in tests/browser/matrix.js");
  for (const s of o.specs || []) if (!MATRIX.specs[s]) throw new Error("spec " + s + " is not declared in tests/browser/matrix.js");
  return o;
}

function selectedSpecs(o) {
  if (o.specs) return o.specs;
  return Object.keys(MATRIX.specs).filter((s) => MATRIX.specs[s].kind === "assert" || o.observe);
}

function printMatrix(o) {
  console.log("Declared matrix (tests/browser/matrix.js):");
  console.log("  engines:      " + MATRIX.engines.join(", ") + (o.engines ? "   (this run: " + o.engines.join(", ") + ")" : ""));
  console.log("  builds:       " + MATRIX.builds.map((b) => b + (o.overrides[b] ? " = " + o.overrides[b] : "")).join(", "));
  console.log("  qualities:    " + MATRIX.qualities.join(", "));
  console.log("  sample rates: " + MATRIX.sampleRates.join(", "));
  console.log("  seed:         " + o.seed + " (test pages only; Math.random replaced before the library loads)");
  console.log("  deadlines:    " + MATRIX.caseDeadline + " s per case (default), " + MATRIX.engineDeadline + " s per engine");
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
  const results = { engine, version: null, launchError: null, cases: [], relaunches: 0, seed: o.seed, overrides: o.overrides, platform: process.platform + "-" + process.arch };
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
  console.log("== " + engine + " " + session.version + " (" + results.platform + ")");
  const server = await startServer({ overrides: o.overrides });
  const shared = { options: o, server, matrix: MATRIX, engine, version: session.version, out };
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
      console.log(line + "NOT LAUNCHED: " + (r.launchError || r.failure || "no results").split("\n")[0]);
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
function crossEngine(all) {
  const { DEFAULT } = require("../tests/browser/tolerances");
  const engines = Object.keys(all).filter((e) => all[e].version && all[e].cases.some((c) => c.spec === "render"));
  const checks = [];
  if (engines.length < 2) return checks;
  const ids = all[engines[0]].cases.filter((c) => c.spec === "render").map((c) => c.id);
  for (const id of ids) {
    const cs = engines.map((e) => all[e].cases.find((c) => c.id === id)).filter(Boolean);
    if (cs.length !== engines.length) continue;
    const ms = cs.map((c) => c.observations.measurements || {});
    const bufs = cs.map((c) => JSON.stringify(c.observations["generated buffer hashes (convBuf, n0, n1)"]));
    checks.push({ name: id + ": generated buffers identical across engines", ok: new Set(bufs).size === 1, detail: bufs[0] });
    let worst = 0, where = "";
    for (const k of Object.keys(ms[0]).filter((k) => k.startsWith("gm-") && ms.every((m) => m[k] && m[k].rms))) {
      ms[0][k].rms.forEach((_, i) => {
        const v = ms.map((m) => 20 * Math.log10(Number(m[k].rms[i])));
        const d = Math.max(...v) - Math.min(...v);
        if (d > worst) { worst = d; where = k + " slot " + i; }
      });
    }
    checks.push({ name: id + ": GM per-slot energy spread <= " + DEFAULT.crossEngineDb.compressed + " dB (default level)", ok: worst <= DEFAULT.crossEngineDb.compressed, detail: worst.toFixed(3) + " dB at " + where });
    const mk = ms.map((m) => m.linearity && m.linearity.makeup).filter(Number.isFinite);
    if (mk.length === ms.length) {
      const d = 20 * Math.log10(Math.max(...mk) / Math.min(...mk));
      checks.push({ name: id + ": linear-level gain spread <= " + DEFAULT.crossEngineDb.linear + " dB", ok: d <= DEFAULT.crossEngineDb.linear, detail: d.toFixed(4) + " dB" });
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
  printMatrix(o);
  if (o.list) return 0;
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
  const forward = ["--seed=" + o.seed];
  if (o.specs) forward.push("--specs=" + o.specs.join(","));
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
    all[engine] = res;
  }
  const cross = crossEngine(all);
  all.crossEngine = cross;
  if (o.out) fs.writeFileSync(path.join(o.out, "results.json"), JSON.stringify(all, null, 1));
  delete all.crossEngine;
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

module.exports = { parseArgs };
