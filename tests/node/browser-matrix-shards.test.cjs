/*
 * Sharding of the browser matrix (scripts/browser-matrix.js, T1B): the layout
 * covers every declared spec exactly once and is balanced by measured seconds,
 * --shard=K/N selects its part, and --merge fails unless every engine ran
 * every declared spec exactly once with every case passing. No browser runs.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const H = require("../harness");
const MATRIX = require("../browser/matrix").MATRIX;
const { shardLayout, selectedSpecs, parseArgs } = require("../../scripts/browser-matrix");

const SCRIPT = path.join(H.ROOT, "scripts", "browser-matrix.js");
const SPECS = Object.keys(MATRIX.specs);

function node(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: H.ROOT, encoding: "utf8", timeout: 60000, killSignal: "SIGKILL" });
  assert.equal(r.error, undefined, "child did not finish");
  return { status: r.status, out: r.stdout + r.stderr };
}

test("every spec belongs to exactly one shard, for several shard counts", () => {
  for (const n of [1, 2, 3, 4, 5]) {
    const layout = shardLayout(n);
    assert.equal(layout.length, n);
    const all = layout.flatMap((s) => s.specs);
    assert.deepEqual([...all].sort(), [...SPECS].sort(), "n=" + n);
    for (const s of layout) assert.ok(s.specs.length > 0, "empty shard at n=" + n);
  }
});

test("the layout is balanced: the longest shard is within the longest spec of the average", () => {
  for (const n of [2, 3, 4]) {
    const layout = shardLayout(n);
    const total = SPECS.reduce((a, s) => a + MATRIX.specs[s].seconds, 0);
    const longestSpec = Math.max(...SPECS.map((s) => MATRIX.specs[s].seconds));
    const longest = Math.max(...layout.map((s) => s.seconds));
    assert.ok(longest <= total / n + longestSpec, "n=" + n + ": " + longest + " s vs " + total / n);
  }
});

test("the layout is deterministic and every spec has a measured duration", () => {
  assert.deepEqual(shardLayout(3), shardLayout(3));
  for (const s of SPECS) assert.ok(MATRIX.specs[s].seconds > 0, s);
});

test("--shard selects the spec part of both the assert and the observe selection", () => {
  const layout = shardLayout(3);
  for (let k = 1; k <= 3; ++k) {
    const mine = new Set(layout[k - 1].specs);
    const assertSpecs = selectedSpecs(parseArgs(["--shard=" + k + "/3"]));
    assert.ok(assertSpecs.length > 0 && assertSpecs.every((s) => mine.has(s) && MATRIX.specs[s].kind === "assert"));
    const observe = selectedSpecs(parseArgs(["--specs=hang,variation", "--shard=" + k + "/3"]));
    assert.deepEqual(observe, ["hang", "variation"].filter((s) => mine.has(s)));
  }
  const union = [1, 2, 3].flatMap((k) => selectedSpecs(parseArgs(["--observe", "--shard=" + k + "/3"])));
  assert.deepEqual([...union].sort(), [...SPECS].sort());
});

test("bad --shard values are refused", () => {
  for (const bad of ["0/3", "4/3", "1/0", "x"]) assert.throws(() => parseArgs(["--shard=" + bad]), undefined, bad);
  assert.throws(() => shardLayout(SPECS.length + 1), /empty/);
});

test("--list --shard prints the layout without launching a browser", () => {
  const r = node(["--list", "--shard=2/3"]);
  assert.equal(r.status, 0, r.out);
  for (const k of [1, 2, 3]) assert.match(r.out, new RegExp("shard " + k + "/3"));
});

/* ---- --merge ---- */

function caseOf(spec, status = "pass") {
  return { spec, id: spec + "/case", status, seconds: 2, checks: [{ name: "check", ok: status === "pass", detail: "" }] };
}

/* A results.json of one job: the engines' cases for the given specs. */
function results(engines, specs, shard, mutate) {
  const o = {};
  for (const engine of engines) {
    o[engine] = { engine, version: "1.0", platform: "linux", shard, cases: specs.map((s) => caseOf(s)) };
  }
  if (mutate) mutate(o);
  return o;
}

/* Every engine's shards as a CI download would lay them out; `change` edits the files before writing. */
function merged(change) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shards-"));
  const layout = shardLayout(3);
  const files = {};
  layout.forEach((s, i) => {
    for (const engine of MATRIX.engines) {
      const assertSpecs = s.specs.filter((x) => MATRIX.specs[x].kind === "assert");
      const observeSpecs = s.specs.filter((x) => MATRIX.specs[x].kind === "observe");
      const base = path.join("browser-results-" + engine + "-" + (i + 1));
      if (assertSpecs.length) files[path.join(base, "browser-matrix", "results.json")] = results([engine], assertSpecs, s.shard);
      if (observeSpecs.length) files[path.join(base, "browser-observe", "results.json")] = results([engine], observeSpecs, s.shard);
    }
  });
  if (change) change(files);
  for (const [rel, data] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
  }
  const r = node(["--merge=" + dir]);
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

const first = (files, engine, spec) => Object.entries(files).find(([k, v]) => k.includes(engine) && v[engine] && v[engine].cases.some((c) => c.spec === spec));

test("merge passes when every engine ran every declared spec once and every case passed", () => {
  const r = merged();
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /PASS: browser matrix shards/);
});

test("merge fails when a shard's results are missing", () => {
  const r = merged((files) => { delete files[Object.keys(files).find((k) => k.includes("webkit-2"))]; });
  assert.equal(r.status, 1);
  assert.match(r.out, /webkit: no results for /);
});

test("merge fails when no results exist at all", () => {
  const r = merged((files) => { for (const k of Object.keys(files)) delete files[k]; });
  assert.equal(r.status, 1);
  assert.match(r.out, /FAIL: browser matrix shards/);
});

test("merge fails on a failed case", () => {
  const r = merged((files) => {
    const [k, v] = first(files, "firefox", "render");
    v.firefox.cases.find((c) => c.spec === "render").status = "fail";
    files[k] = v;
  });
  assert.equal(r.status, 1);
  assert.match(r.out, /firefox \/ render\/case: failed/);
});

test("merge fails when a spec ran in two shards", () => {
  const r = merged((files) => {
    const [k, v] = first(files, "chromium", "render");
    files[k.replace("results.json", "other/results.json")] = v;
  });
  assert.equal(r.status, 1);
  assert.match(r.out, /chromium ran render in two shards/);
});

test("merge fails when an engine did not launch or a worker failed", () => {
  const r = merged((files) => {
    const [k, v] = first(files, "webkit", "embed");
    v.webkit.version = null;
    v.webkit.launchError = "no browser";
    files[k] = v;
  });
  assert.equal(r.status, 1);
  assert.match(r.out, /webkit did not launch: no browser/);
});

test("merge fails on an unreadable file and on an undeclared engine", () => {
  let r = merged((files) => { files[path.join("browser-results-chromium-1", "bad", "results.json")] = "{not json"; });
  assert.equal(r.status, 1);
  assert.match(r.out, /unreadable/);
  r = merged((files) => { files[path.join("browser-results-chromium-1", "extra", "results.json")] = { opera: { cases: [] } }; });
  assert.equal(r.status, 1);
  assert.match(r.out, /undeclared engine opera/);
});

test("merge fails on a missing directory", () => {
  const r = node(["--merge=" + path.join(os.tmpdir(), "no-such-shard-results-" + process.pid)]);
  assert.equal(r.status, 1);
});

test("the workflow's shard list, SHARD and job name agree on the shard count", () => {
  const yml = fs.readFileSync(path.join(H.ROOT, ".github", "workflows", "browser-matrix.yml"), "utf8");
  const list = /^\s+shard: \[([\d, ]+)\]$/m.exec(yml);
  assert.ok(list, "no shard list");
  const shards = list[1].split(",").map((x) => Number(x.trim()));
  const n = shards.length;
  assert.deepEqual(shards, Array.from({ length: n }, (_, i) => i + 1));
  assert.ok(yml.includes("SHARD: ${{ matrix.shard }}/" + n), "SHARD");
  assert.ok(yml.includes("name: browser (${{ matrix.engine }}, ${{ matrix.shard }}/" + n + ")"), "job name");
  assert.ok(n <= SPECS.length);
});
