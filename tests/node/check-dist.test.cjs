/*
 * The pull request rule for the generated files (scripts/check-dist.js):
 * which rule each event gets, and the "unchanged" check on scratch git
 * repositories (a feature branch, a base that CI rebuilt later, and the merge
 * commit a pull_request workflow checks out).
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const D = require("../../scripts/check-dist");

const REPO = "Provable-Games/webaudio-tinysynth";
const [MIN, MAP] = D.GENERATED;

test.describe("decide()", () => {
  const pr = (headRef, baseRef, headRepo = REPO) => ({ eventName: "pull_request", repo: REPO, pr: { headRef, baseRef, headRepo } });

  test("a feature pull request may not change the files, into any base", () => {
    for (const [head, base] of [["t5/api", "improve/integration"], ["docs/agents-skills", "main"], ["t5/api-part2", "t5/api"]]) {
      const d = D.decide(pr(head, base));
      assert.deepEqual([d.rule, d.base, d.fixRef, d.mayCarryBuild], ["pull-request", "HEAD^1", "origin/" + base, false], head);
    }
  });

  test("improve/integration and release/* may carry a build", () => {
    assert.equal(D.decide(pr("improve/integration", "main")).mayCarryBuild, true);
    assert.equal(D.decide(pr("release/v1.2.0", "main")).mayCarryBuild, true);
    assert.equal(D.decide(pr("releases/v1.2.0", "main")).mayCarryBuild, false);
  });

  test("a fork's branch named improve/integration or release/* is a feature branch", () => {
    for (const head of ["improve/integration", "release/v1.2.0"]) assert.equal(D.decide(pr(head, "main", "someone/webaudio-tinysynth")).mayCarryBuild, false, head);
  });

  test("pushes and manual runs compare no committed copy: main may lag its source between releases", () => {
    for (const eventName of ["push", "workflow_dispatch"]) assert.equal(D.decide({ eventName, repo: REPO, pr: null }).rule, "inline-only", eventName);
  });

  test("fromGithub() reads the head repository from the event payload", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tinysynth-check-dist-event-"));
    try {
      const file = path.join(dir, "event.json");
      fs.writeFileSync(file, JSON.stringify({ pull_request: { head: { ref: "improve/integration", repo: { full_name: REPO } }, base: { ref: "main" } } }));
      const input = D.fromGithub({ GITHUB_EVENT_NAME: "pull_request", GITHUB_REPOSITORY: REPO, GITHUB_EVENT_PATH: file });
      assert.deepEqual(input, { eventName: "pull_request", repo: REPO, pr: { headRef: "improve/integration", headRepo: REPO, baseRef: "main" } });
      assert.equal(D.decide(input).mayCarryBuild, true);
      assert.equal(D.fromGithub({ GITHUB_EVENT_NAME: "push", GITHUB_REPOSITORY: REPO }).pr, null);
      assert.throws(() => D.fromGithub({}), /GITHUB_EVENT_NAME/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe("checkUnchanged()", () => {
  let dir;
  // Isolated from the user's git configuration (signing, hooks, default branch).
  const env = Object.assign({}, process.env, {
    GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
  });
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
    assert.equal(r.status, 0, "git " + args.join(" ") + ": " + r.stderr);
    return r.stdout.trim();
  };
  const write = (file, text) => fs.writeFileSync(path.join(dir, file), text);
  const commit = (msg, files) => {
    for (const [f, t] of Object.entries(files)) write(f, t);
    git("add", "-A");
    git("commit", "-q", "-m", msg);
  };
  const check = (base) => D.checkUnchanged(base, { cwd: dir });

  test.beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tinysynth-check-dist-"));
    git("init", "-q", "-b", "base");
    commit("initial", { "webaudio-tinysynth.js": "source 1\n", [MIN]: "min 1\n", [MAP]: "map 1\n" });
    git("checkout", "-q", "-b", "feature");
  });
  test.afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("passes when the feature branch changes only the source", () => {
    commit("source change", { "webaudio-tinysynth.js": "source 2\n" });
    assert.deepEqual(check("base"), []);
  });

  test("fails when the feature branch commits a regenerated min.js, and names the file", () => {
    commit("source and build", { "webaudio-tinysynth.js": "source 2\n", [MIN]: "min 2\n" });
    const problems = check("base");
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], /^webaudio-tinysynth\.min\.js differs from base/);
  });

  test("passes when the base was rebuilt after the branch started and the branch left the files alone", () => {
    git("checkout", "-q", "base");
    commit("CI rebuild", { [MIN]: "min 0\n", [MAP]: "map 0\n" });
    git("checkout", "-q", "feature");
    commit("source change", { "webaudio-tinysynth.js": "source 2\n" });
    assert.deepEqual(check("base"), []);
  });

  test("the fix command makes a failing branch pass", () => {
    git("checkout", "-q", "base");
    commit("CI rebuild", { [MIN]: "min 0\n", [MAP]: "map 0\n" });
    git("checkout", "-q", "feature");
    commit("source and build", { "webaudio-tinysynth.js": "source 2\n", [MIN]: "min 2\n", [MAP]: "map 2\n" });
    assert.equal(check("base").length, 2);
    const fix = D.fixCommand("base").split(" ");
    assert.deepEqual(fix.slice(0, 2), ["git", "checkout"]);
    git(...fix.slice(1));
    git("commit", "-q", "-m", "restore");
    assert.deepEqual(check("base"), []);
  });

  test("fails on an uncommitted change and on a deleted file", () => {
    write(MIN, "min 2\n");
    assert.deepEqual(check("base"), [MIN + " has uncommitted changes in the working tree"]);
    git("checkout", "-q", "--", MIN);
    fs.rmSync(path.join(dir, MAP));
    assert.deepEqual(check("base"), [MAP + " is deleted in the working tree"], "an unstaged deletion (review finding)");
    git("rm", "-q", "--cached", MIN);
    assert.deepEqual(check("base"), [MAP + " is deleted in the working tree"], "a staged-only removal leaves the file and HEAD intact");
    git("reset", "-q", "--hard");
    git("rm", "-q", MIN);
    assert.deepEqual(check("base"), [MIN + " is deleted in the working tree"], "a staged deletion");
    git("reset", "-q", "--hard");
    git("rm", "-q", MAP);
    git("commit", "-q", "-m", "delete the map");
    assert.deepEqual(check("base"), [MAP + " is missing at HEAD (deleted)"]);
  });

  test("fails when the base is not a commit", () => {
    assert.match(check("no-such-branch")[0], /base no-such-branch is not a commit/);
  });

  test("in a pull request's merge commit, compares with HEAD^1 (the base tip)", () => {
    const mergeOf = (branch) => {
      git("checkout", "-q", "--detach", "base");
      git("merge", "-q", "--no-ff", "--no-edit", branch);
      return check("HEAD^1");
    };
    commit("source change", { "webaudio-tinysynth.js": "source 2\n" });
    git("checkout", "-q", "-b", "carries-build", "feature");
    commit("rebuild", { [MAP]: "map 2\n" });
    const problems = mergeOf("carries-build");
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], /^webaudio-tinysynth\.min\.js\.map differs from HEAD\^1/);

    git("checkout", "-q", "base");
    commit("CI rebuild", { [MIN]: "min 0\n", [MAP]: "map 0\n" });
    assert.deepEqual(mergeOf("feature"), [], "untouched files take the base tip's copy in the merge");
  });
});

test.describe("checkPullRequest()", () => {
  let dir, fresh;
  const env = Object.assign({}, process.env, {
    GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
  });
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
    assert.equal(r.status, 0, "git " + args.join(" ") + ": " + r.stderr);
  };
  const commit = (msg, files) => {
    for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), t);
    git("add", "-A");
    git("commit", "-q", "-m", msg);
  };
  let builds;
  // `fresh` stands in for the pinned build of the branch's source; it is built only when needed.
  const check = (mayCarryBuild) => D.checkPullRequest({ base: "main", mayCarryBuild, cwd: dir, freshDir: () => (++builds, fresh) });

  test.beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tinysynth-check-pr-"));
    fresh = fs.mkdtempSync(path.join(os.tmpdir(), "tinysynth-check-pr-fresh-"));
    fs.writeFileSync(path.join(fresh, MIN), "min 2\n");
    fs.writeFileSync(path.join(fresh, MAP), "map 2\n");
    builds = 0;
    git("init", "-q", "-b", "main");
    commit("release 1", { "webaudio-tinysynth.js": "source 1\n", [MIN]: "min 1\n", [MAP]: "map 1\n" });
    git("checkout", "-q", "-b", "branch");
    commit("source change", { "webaudio-tinysynth.js": "source 2\n" });
  });
  test.afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(fresh, { recursive: true, force: true });
  });

  test("feature, files unchanged: passes without building", () => {
    assert.deepEqual(check(false), { ok: true, via: "unchanged", problems: [] });
    assert.equal(builds, 0);
  });

  test("feature, files changed (even to a fresh build): fails", () => {
    commit("rebuild", { [MIN]: "min 2\n", [MAP]: "map 2\n" });
    const r = check(false);
    assert.deepEqual([r.ok, r.via, builds], [false, "changed", 0]);
    assert.match(r.problems.join("\n"), /webaudio-tinysynth\.min\.js differs from main/);
  });

  test("release/*, files equal to a fresh build: passes", () => {
    commit("rebuild", { [MIN]: "min 2\n", [MAP]: "map 2\n" });
    assert.deepEqual(check(true), { ok: true, via: "fresh", problems: [] });
    assert.equal(builds, 1);
  });

  test("release/*, files changed but stale: fails and names the stale file", () => {
    commit("partial rebuild", { [MIN]: "min 2\n", [MAP]: "map 1.5\n" });
    assert.deepEqual(check(true), { ok: false, via: "fresh", problems: [MAP + " differs from a fresh build of this source"] });
  });

  test("release/*, files unchanged: passes (main may lag its source between releases)", () => {
    assert.deepEqual(check(true), { ok: true, via: "unchanged", problems: [] });
  });
});
