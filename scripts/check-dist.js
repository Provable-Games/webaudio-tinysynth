#!/usr/bin/env node
/*
 * The pull request rule for the generated files, webaudio-tinysynth.min.js
 * and webaudio-tinysynth.min.js.map (CI's build-verify job).
 *
 * After each merge into improve/integration, .github/workflows/dist.yml
 * rebuilds the generated files with the pinned build and commits them. main
 * is not automated: there they change only in a manual release pull request
 * (a release/* branch), followed by a tag and a GitHub Release, and between
 * releases main's committed copy may be older than its source. So, on a pull
 * request:
 *
 *   - both files unchanged from the base: pass. With --github this compares
 *     the checked-out merge commit with its first parent (the base tip).
 *     Locally, --unchanged-from=REF passes when HEAD's copy equals REF's or
 *     the merge base's (the branch did not touch it), and the working tree
 *     has no uncommitted change to either file;
 *   - changed, from this repository's improve/integration (CI's rebuild) or a
 *     release/* branch: pass only if both equal a fresh pinned build;
 *   - any other change: fail, with the command that restores them.
 *
 * Pushes and manual runs check no committed copy (--inline-only). Whatever the
 * rule, it builds the current source (scripts/test-build.js) and requires that
 * build and the source to be safe to inline in a <script> element.
 *
 * Usage: node scripts/check-dist.js --github           (in GitHub Actions)
 *        node scripts/check-dist.js --unchanged-from=origin/improve/integration
 *        node scripts/check-dist.js --fresh            (npm run verify: committed equals fresh)
 *        node scripts/check-dist.js --inline-only      (only the inline-safety checks)
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const INTEGRATION_BRANCH = "improve/integration";
const RELEASE_BRANCH = /^release\//;
const GENERATED = ["webaudio-tinysynth.min.js", "webaudio-tinysynth.min.js.map"];

/*
 * Which rule applies. `pr` describes a pull_request event: {headRef,
 * headRepo, baseRef}; `repo` is the repository the workflow runs in. Only
 * this repository's improve/integration and release/* branches may carry a
 * build; a fork's branch of the same name is a feature branch.
 */
function decide({ eventName, repo, pr }) {
  if (eventName === "pull_request") {
    const mayCarryBuild = pr.headRepo === repo && (pr.headRef === INTEGRATION_BRANCH || RELEASE_BRANCH.test(pr.headRef));
    return {
      rule: "pull-request", base: "HEAD^1", fixRef: "origin/" + pr.baseRef, mayCarryBuild,
      reason: "pull request " + pr.headRef + " -> " + pr.baseRef + ": " + (mayCarryBuild
        ? "the files may change, but only to a fresh build"
        : "the files must stay as the base has them"),
    };
  }
  return { rule: "inline-only", reason: eventName + " event: the committed files are not compared (main's may lag the source between releases)" };
}

/* decide()'s input from the GitHub Actions environment and event payload. */
function fromGithub(env) {
  const out = { eventName: env.GITHUB_EVENT_NAME, repo: env.GITHUB_REPOSITORY, pr: null };
  if (!out.eventName || !out.repo) throw new Error("--github needs GITHUB_EVENT_NAME and GITHUB_REPOSITORY (GitHub Actions)");
  if (out.eventName === "pull_request") {
    const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    const pr = event.pull_request;
    out.pr = { headRef: pr.head.ref, headRepo: pr.head.repo && pr.head.repo.full_name, baseRef: pr.base.ref };
  }
  return out;
}

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

/* The blob id of `file` at `rev`, or null if it does not exist there. */
function blobAt(rev, file, cwd) {
  const r = git(["rev-parse", "--verify", "--quiet", rev + ":" + file], cwd);
  return r.status === 0 ? r.out : null;
}

/*
 * The generated files are unchanged relative to `base`: for each one, HEAD's
 * copy equals `base`'s copy or the merge base's copy (what a merge into
 * `base` would leave as `base` has it), and the working tree has no
 * uncommitted change. In a pull request's merge commit with base HEAD^1 the
 * merge base is HEAD^1 itself, so this is "HEAD's copy equals the base tip's".
 * Returns a list of problems (empty when the rule holds).
 */
function checkUnchanged(base, { cwd = ROOT, files = GENERATED } = {}) {
  if (git(["rev-parse", "--verify", "--quiet", base + "^{commit}"], cwd).status !== 0)
    return ["base " + base + " is not a commit here (fetch it, or check out with full history)"];
  const mb = git(["merge-base", "HEAD", base], cwd);
  const mergeBase = mb.status === 0 ? mb.out : null;
  const problems = [];
  for (const file of files) {
    const head = blobAt("HEAD", file, cwd);
    const want = blobAt(base, file, cwd);
    const forkPoint = mergeBase ? blobAt(mergeBase, file, cwd) : null;
    if (head === null) problems.push(file + " is missing at HEAD (" + (want ? "deleted" : "and at " + base) + ")");
    else if (head !== want && head !== forkPoint)
      problems.push(file + " differs from " + base + (forkPoint && forkPoint !== want ? " and from the merge base" : "") +
        " (HEAD blob " + head.slice(0, 12) + ", " + base + " blob " + (want ? want.slice(0, 12) : "missing") + ")");
    if (head !== null) {
      if (!fs.existsSync(path.join(cwd, file))) problems.push(file + " is deleted in the working tree");
      else if (git(["hash-object", "--", file], cwd).out !== head) problems.push(file + " has uncommitted changes in the working tree");
    }
  }
  return problems;
}

function fixCommand(ref) {
  return "git checkout " + ref + " -- " + GENERATED.join(" ");
}

/* HEAD's committed copy of each file against the same file in `freshDir`. Returns a list of problems. */
function compareWithFresh(freshDir, { cwd = ROOT, files = GENERATED } = {}) {
  const problems = [];
  for (const file of files) {
    const r = spawnSync("git", ["cat-file", "blob", "HEAD:" + file], { cwd, maxBuffer: 1 << 26 });
    if (r.status !== 0) problems.push(file + " is missing at HEAD");
    else if (!r.stdout.equals(fs.readFileSync(path.join(freshDir, file)))) problems.push(file + " differs from a fresh build of this source");
  }
  return problems;
}

/*
 * The pull request rule: unchanged from `base`, or (only when mayCarryBuild)
 * equal to the fresh build in `freshDir()`, which is called only if needed.
 * Returns {ok, via, problems}.
 */
function checkPullRequest({ base, mayCarryBuild, freshDir, cwd = ROOT, files = GENERATED }) {
  const changed = checkUnchanged(base, { cwd, files });
  if (!changed.length) return { ok: true, via: "unchanged", problems: [] };
  if (!mayCarryBuild) return { ok: false, via: "changed", problems: changed };
  const stale = compareWithFresh(freshDir(), { cwd, files });
  return { ok: !stale.length, via: "fresh", problems: stale };
}

async function main(argv) {
  let rule = null;
  for (const a of argv) {
    let m;
    if (a === "--github") rule = decide(fromGithub(process.env));
    else if ((m = /^--unchanged-from=(.+)$/.exec(a))) rule = { rule: "pull-request", base: m[1], fixRef: m[1], mayCarryBuild: false, reason: "--unchanged-from=" + m[1] };
    else if (a === "--fresh") rule = { rule: "fresh", reason: "--fresh" };
    else if (a === "--inline-only") rule = { rule: "inline-only", reason: "--inline-only: the committed files are not checked" };
    else throw new Error("unknown argument " + a);
  }
  if (!rule) throw new Error("usage: node scripts/check-dist.js --github | --unchanged-from=REF | --fresh | --inline-only");
  console.log("rule: " + rule.rule + " (" + rule.reason + ")");

  const failures = [];
  // A fresh build of the current source must be safe to inline, whatever the rule.
  const { prepare } = require("./test-build");
  const { checkInlineSafe } = require("./verify-dist");
  const built = await prepare();
  checkInlineSafe((built.built ? "fresh " : "") + path.relative(ROOT, built.min), built.min, failures);
  checkInlineSafe("webaudio-tinysynth.js", path.join(ROOT, "webaudio-tinysynth.js"), failures);

  if (rule.rule === "pull-request") {
    // The comparison build goes to its own directory: TINYSYNTH_MIN may name some other file.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tinysynth-check-dist-"));
    let result;
    try {
      const freshDir = () => {
        const b = spawnSync(process.execPath, [path.join(__dirname, "build.js"), tmp], { cwd: ROOT, stdio: "inherit" });
        if (b.status !== 0) throw new Error("the pinned build failed");
        return tmp;
      };
      result = checkPullRequest({ base: rule.base, mayCarryBuild: rule.mayCarryBuild, freshDir });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    const list = result.problems.map((p) => "       " + p).join("\n");
    if (result.ok) console.log("ok   " + GENERATED.join(" and ") + (result.via === "unchanged" ? " unchanged from " + rule.base : " equal a fresh build"));
    else if (result.via === "changed") {
      failures.push("this pull request changes the generated files. Only " + INTEGRATION_BRANCH + " (CI's rebuild, .github/workflows/dist.yml) " +
        "and release/* branches may change them, and only to a fresh build:\n" + list + "\n" +
        "     Restore them, then commit:\n       " + fixCommand(rule.fixRef));
    } else {
      failures.push("this branch may change the generated files, but they must equal a fresh build:\n" + list + "\n" +
        "     On a release/* branch, run `npm run build` and commit both files. On " + INTEGRATION_BRANCH +
        ", CI's rebuild commit (dist.yml) brings them up to date after each merge.");
    }
  } else if (rule.rule === "fresh") {
    const r = spawnSync(process.execPath, [path.join(__dirname, "verify-dist.js")], { cwd: ROOT, stdio: "inherit" });
    if (r.status !== 0) failures.push("the committed files do not match a fresh build (npm run verify, above)");
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, "Generated files: rule **" + rule.rule + "** (" + rule.reason + "): " +
      (failures.length ? "FAIL" : "pass") + "\n\n");
  }
  if (failures.length) {
    console.error("\nFAIL: " + failures.length + " problem(s)");
    for (const f of failures) console.error("  - " + f);
    return 1;
  }
  console.log("\nPASS: " + (rule.rule === "inline-only" ? "the build under test and the source are safe to inline" : "generated files follow the " + rule.rule + " rule"));
  return 0;
}

module.exports = { INTEGRATION_BRANCH, RELEASE_BRANCH, GENERATED, decide, fromGithub, checkUnchanged, compareWithFresh, checkPullRequest, fixCommand };

if (require.main === module) {
  main(process.argv.slice(2)).then((status) => process.exit(status), (e) => {
    console.error("FAIL: " + (e && e.message || e));
    process.exit(1);
  });
}
