#!/usr/bin/env node
/*
 * The pull request rule for the generated files, webaudio-tinysynth.min.js
 * and webaudio-tinysynth.min.js.map (CI's build-verify job).
 *
 * Pull requests do not carry the generated files. After each merge into
 * improve/integration, .github/workflows/dist.yml rebuilds them with the
 * pinned build and commits them. So:
 *
 *   unchanged  A feature pull request must leave both files as they are on
 *              its base branch. With --github this compares the checked-out
 *              merge commit with its first parent (the base tip). Locally,
 *              --unchanged-from=REF passes when HEAD's copy equals REF's or
 *              the merge base's (the branch did not touch it), and the
 *              working tree has no uncommitted change to either file.
 *   fresh      The committed files must equal a fresh pinned build:
 *              scripts/verify-dist.js (`npm run verify`). For the
 *              improve/integration -> main pull request, pushes to main and
 *              manual runs.
 *
 * Either way it also builds the current source (scripts/test-build.js) and
 * requires that build and the source to be safe to inline in a <script>
 * element, so a pull request cannot break inlining before CI commits the build.
 *
 * Usage: node scripts/check-dist.js --github           (in GitHub Actions)
 *        node scripts/check-dist.js --unchanged-from=origin/improve/integration
 *        node scripts/check-dist.js --fresh
 *        node scripts/check-dist.js --inline-only      (only the inline-safety checks)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const INTEGRATION_BRANCH = "improve/integration";
const GENERATED = ["webaudio-tinysynth.min.js", "webaudio-tinysynth.min.js.map"];

/*
 * Which rule applies. `pr` describes a pull_request event: {headRef,
 * headRepo, baseRef}; `repo` is the repository the workflow runs in. Only the
 * improve/integration branch of this repository carries CI's rebuild; a
 * fork's branch of the same name is a feature branch.
 */
function decide({ eventName, repo, pr }) {
  if (eventName === "pull_request") {
    if (pr.headRef === INTEGRATION_BRANCH && pr.headRepo === repo)
      return { rule: "fresh", reason: "pull request from " + INTEGRATION_BRANCH + ": it carries CI's rebuild, which must equal a fresh build" };
    return {
      rule: "unchanged", base: "HEAD^1", fixRef: "origin/" + pr.baseRef,
      reason: "feature pull request into " + pr.baseRef + ": CI regenerates these files after merging, so the pull request must not change them",
    };
  }
  return { rule: "fresh", reason: eventName + " event: the committed files must equal a fresh build" };
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
    if (head !== null && fs.existsSync(path.join(cwd, file))) {
      const work = git(["hash-object", "--", file], cwd).out;
      if (work !== head) problems.push(file + " has uncommitted changes in the working tree");
    }
  }
  return problems;
}

function fixCommand(ref) {
  return "git checkout " + ref + " -- " + GENERATED.join(" ");
}

async function main(argv) {
  let rule = null;
  for (const a of argv) {
    let m;
    if (a === "--github") rule = decide(fromGithub(process.env));
    else if ((m = /^--unchanged-from=(.+)$/.exec(a))) rule = { rule: "unchanged", base: m[1], fixRef: m[1], reason: "--unchanged-from=" + m[1] };
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

  if (rule.rule === "unchanged") {
    const problems = checkUnchanged(rule.base);
    if (problems.length) {
      failures.push("this pull request changes the generated files. CI rebuilds them on " + INTEGRATION_BRANCH +
        " after merging (.github/workflows/dist.yml), so pull requests must leave them as the base branch has them:\n" +
        problems.map((p) => "       " + p).join("\n") + "\n" +
        "     Restore them, then commit:\n       " + fixCommand(rule.fixRef));
    } else {
      console.log("ok   " + GENERATED.join(" and ") + " unchanged from " + rule.base);
    }
  } else if (rule.rule === "fresh") {
    const r = spawnSync(process.execPath, [path.join(__dirname, "verify-dist.js")], { cwd: ROOT, stdio: "inherit" });
    if (r.status !== 0) failures.push("the committed files do not match a fresh build (npm run verify, above). On " + INTEGRATION_BRANCH +
      ", CI's rebuild commit (dist.yml) brings them up to date after each merge");
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

module.exports = { INTEGRATION_BRANCH, GENERATED, decide, fromGithub, checkUnchanged, fixCommand };

if (require.main === module) {
  main(process.argv.slice(2)).then((status) => process.exit(status), (e) => {
    console.error("FAIL: " + (e && e.message || e));
    process.exit(1);
  });
}
