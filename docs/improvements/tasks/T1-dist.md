# T1-dist: CI generates webaudio-tinysynth.min.js and its map (D-036)

| Item | Value |
| --- | --- |
| Task | T1-dist: pull requests stop carrying `webaudio-tinysynth.min.js` and `webaudio-tinysynth.min.js.map`. After each push to `improve/integration`, CI rebuilds both with the pinned build and commits them with `GITHUB_TOKEN` through GraphQL `createCommitOnBranch`. A pull request may change them only from `improve/integration` or a `release/*` branch, and only to a fresh build; `main` changes them only in manual releases (§12). Local tests build into an ignored directory. |
| Base commit | `197772d` (`origin/improve/integration` after #50 and #48); first based on `19cb982`, rebased in §12 |
| Branch / worktree | `t1/dist-ci` in `/workspace/webaudio-tinysynth-worktrees/t1-dist` |
| Assignment | `_evidence/assignments/T1-dist.md`, `CONCURRENCY.md` (rules 1–12), and the coordinator's base update and design adjustment of 2026-10-04 (§12) |
| Evidence outside the repo | `/workspace/webaudio-tinysynth-worktrees/_evidence/t1-dist/`: `npm-test-*.log`, `test-browser.log`, `matrix-*.log`, `pack-check.log`, `vacuity-loaders.log`, `pr-scenario.log` (and its script `pr-scenario.sh`), `selftest/` (run logs, commit and verification JSON) |
| Toolchain | Node 24.21.0 / npm 11.19.0 (`_evidence/t1-tooling/tools`), actionlint 1.7.12 with shellcheck 0.11.0, Chromium 153 through `_evidence/t6-validation/env.sh` |

## 1. Commits

All GPG-signed (`git log --format='%h %G?'` shows `G`).

| Commit | Subject | Files |
| --- | --- | --- |
| `ac1a667` | Test a fresh min.js build in .build instead of the committed copy | `scripts/test-build.js` (new), `tests/harness.js`, `tests/node/{exports,lifecycle,seed}.test.cjs`, `tests/browser/lib/pages.js`, `tests/browser-smoke.js`, `scripts/{browser-server,browser-matrix,run-unit-tests,run-node-tests,run-regressions,size,check-pack}.js`, `.gitignore`, `eslint.config.mjs` (see §8) |
| `ef90e02` | Require feature pull requests to leave the generated files unchanged | `scripts/check-dist.js` (new), `scripts/verify-dist.js` (exports its inline check), `tests/node/check-dist.test.cjs` (new), `.github/workflows/ci.yml`, `.github/workflows/browser-matrix.yml`, `.gitattributes` |
| `78d3320` | Rebuild the generated files in CI after each push to improve/integration | `.github/workflows/dist.yml` (new) |
| `f46b93e` | Document that CI generates min.js and which commits to pin | `README.md` (see §8) |
| `a95d587` | Point a fresh-rule failure at CI's rebuild commit | `scripts/check-dist.js` (message) |
| `a32712f`, `ab7e897`, `9a1bd9e` | Record T1-dist; README draft; review round | this record |
| `d78078d` | Require a fresh build on every pull request into main (review round 1, §11; superseded by §12) | `scripts/check-dist.js`, its test, `ci.yml` comments, `README.md` |
| `56b1183` | Load the fresh build in the API node test from #48 | `tests/node/api.test.cjs` |
| `758e730` | Let only improve/integration and release/* PRs change the generated files (§12) | `scripts/check-dist.js`, `tests/node/check-dist.test.cjs`, `package.json` (node floors 12/148), `ci.yml` and `dist.yml` comments, `scripts/verify-dist.js` (comment) |
| `eb63c8c` | Document manual releases and which commits npm run verify accepts (§12) | `README.md` |
| this update | Record the base update and the design adjustment | this record |

Commits before §12 were rebased onto `197772d`; their hashes before the rebase were `a37544a`, `0937626`, `df1fa8c`, `4545631`, `d0e1ed6`, `2fa7967`, `91fd11b`, `a8d4e15`, `d0bfff4`. The rebase conflicted only on the `package.json` floors, resolved to the base's values and then set from the runner output (rule 5).

The committed min.js and map are byte-identical to the base (`git diff 197772d -- webaudio-tinysynth.min.js*` is empty), so this pull request passes its own new rule.

## 2. Design as built

### 2.1 `.github/workflows/dist.yml`

Triggers: `push` to `improve/integration`, and `workflow_dispatch` (usable once the file is on `main`). Top-level `permissions: {}`; `concurrency: dist-<ref>` with `cancel-in-progress: true`; `defaults.run.shell: bash`; `ubuntu-24.04-arm`; every action pinned by SHA (the same pins as `ci.yml` and the review workflows).

| Job | Token | What it does |
| --- | --- | --- |
| `build` (25 min) | `contents: read` | Checks out `github.sha` (`fetch-depth: 0`, `persist-credentials: false`), setup-node from `.nvmrc`, `npm ci`, `node scripts/build.js $RUNNER_TEMP/dist`, then sets `TINYSYNTH_MIN` to that file so every later step tests those exact bytes: `check-dist.js --inline-only` (no `</script`, `<script`, `<!--`; ASCII only, for the build and the source), `test:unit`, `test:node`, `test:regression`. Uploads the two files as artifact `dist` (7 days) only if all passed. |
| `browser-smoke` (15 min) | `contents: read` | `npm ci`, Chromium headless shell, `npm run test:browser` on a fresh build. |
| `commit` (10 min) | `contents: write` | `needs: [build, browser-smoke]`, only on `refs/heads/improve/integration`. No npm, no repository code. Downloads the artifact, sparse-checks-out the two committed files at `github.sha` as data, checks the artifact holds exactly the two files, non-empty, and that min.js is inline-safe (coreutils `grep`). Writes sha256, bytes and `gzip -9 -n` bytes to the step summary. If both files equal the committed ones: "up to date", exit 0. Otherwise builds the GraphQL request in a file with `jq --rawfile` (the map's base64 is ~95 KB, close to the 128 KiB single-argument limit) and calls `gh api graphql --input`. `createCommitOnBranch` with `expectedHeadOid: github.sha`, headline `Rebuild webaudio-tinysynth.min.js for <short sha>`, body with the source SHA, both sha256 values and the run URL. On a refusal it reads the branch head: if it moved, a notice and exit 0 (the newer push's run rebuilds); otherwise it fails, naming the "Resource not accessible by integration" case. |

Ordering guarantees:

- **Newest push wins.** A newer push cancels the older run of the same branch. Even when an older run is not cancelled (it already reached its commit step, or the self-test's `cancel-in-progress: false`, §5.4), `expectedHeadOid = github.sha` makes GitHub refuse its commit once the branch has moved, so a build of older source can never land on a newer head.
- **No loop.** A commit made with `GITHUB_TOKEN` starts no workflow run. The explicit guard also skips `build` and `browser-smoke` (and so `commit`) on a push whose head commit is by `github-actions[bot]` with the rebuild headline; §5.5 exercises it.
- **Browser smoke: included.** Recent CI runs: `browser-smoke` 32–42 s, the `test` job ~7.7 min (unit 5 min, node 1 min, regression 1.8 min), the matrix 14–16 min per engine. The smoke runs in parallel with `build`, so it adds no latency and gates the commit on the min.js loading in a real browser. The matrix is not repeated: the pull request ran it on the merge ref.

### 2.2 Pull request checks (`ci.yml`, `browser-matrix.yml`)

Job names are unchanged (`lint`, `build-verify`, `test`, `browser-smoke`, `browser (<engine>)`).

- `test`, `browser-smoke`, and the matrix: the `npm run build && git diff --exit-code` drift steps are gone. Each job runs `node scripts/test-build.js` (the `test` job keeps `id: build` for its `steps.build.outcome` conditions) and the suites test that fresh build.
- `build-verify` runs `node scripts/check-dist.js --github`, then `pack:check` and `size`, both on the fresh build. `check-dist.js` decides from the event (§12 gives the history):

| Event | Rule |
| --- | --- |
| `pull_request`, both files unchanged from the base | **pass**: in the merge commit both files' blobs equal `HEAD^1`'s (the base tip) |
| `pull_request` from this repository's `improve/integration` (#31, CI's rebuild) or a `release/*` branch, files changed | **pass only if** both equal a fresh pinned build (built into a temporary directory, independent of `TINYSYNTH_MIN`) |
| any other `pull_request` that changes either file (feature, docs, hotfix or stacked pull requests; a fork's branch named `improve/integration` or `release/*`) | **fail**, listing the files and `git checkout origin/<base> -- webaudio-tinysynth.min.js webaudio-tinysynth.min.js.map` |
| `push` (to `main`), `workflow_dispatch` | **inline-only**: no committed copy is compared, because between releases `main`'s may lag its source. The `test` and `browser-smoke` jobs build and test the fresh source |
| always | a fresh build and the source are inline-safe |

Locally, `--unchanged-from=REF` applies merge semantics: it passes if HEAD's copy equals REF's or the merge base's (the branch did not touch it), and the working tree has no uncommitted change to or deletion of either file. In the merge-ref checkout both collapse to `HEAD == HEAD^1`. `--fresh` is `npm run verify`. `decide()`, `fromGithub()`, `checkUnchanged()`, `compareWithFresh()` and `checkPullRequest()` are exported and tested by `tests/node/check-dist.test.cjs` (17 tests on scratch git repositories with isolated git config, including the four cases feature unchanged, feature changed, `release/*` fresh and `release/*` stale).

### 2.3 Local development

Preferred approach, as built. `scripts/test-build.js` is the one place that resolves the min.js under test: `TINYSYNTH_MIN` if set, else `.build/webaudio-tinysynth.min.js`. `prepare()` builds there with the pinned `scripts/build.js` (into a private temp directory under `.build/`, then renames, so concurrent runs in one checkout never read a partial file) and exports `TINYSYNTH_MIN` to child processes. With `TINYSYNTH_MIN` already set it builds nothing. `run-unit-tests`, `run-node-tests`, `run-regressions` (so `test:regression` and `test:browser`), the `browser-matrix` orchestrator (unless `--min=`), `check-pack`, `size` and the `browser-server` CLI call `prepare()` first. The loaders (`harness.forkVariants()` with a new `file` field, `pages.libraryPath()`, `browser-server`'s `/lib/min.js`, `browser-smoke.js`, and the `require()`s in three node tests) read through it. A missing build is an error that names `node scripts/test-build.js`; nothing falls back to the committed copy.

`pack:check` checks the whitelist on the repository (`npm pack --dry-run`), stages those files with the fresh min.js and map, packs and installs the staged copy, and compares the installed files with what was staged. `npm run size` reports the source and the fresh build; `npm run verify` keeps its consumer meaning (committed equals fresh, plus inline safety and sizes of the committed files). `npm run build` still writes to the repository root by default; it is the command CI's build job uses (with an output directory).

`.build/` is in `.gitignore` and in ESLint's ignores; both generated files are `linguist-generated=true` in `.gitattributes`.

## 3. Trust boundary

- Third-party code (`npm ci`: Terser, Vitest, ESLint, Playwright and their dependencies) runs only in `build` and `browser-smoke`, with a read-only token and no persisted credentials.
- The write token exists only in `commit`, which runs two pinned GitHub actions (`download-artifact`, `checkout` with `persist-credentials: false`) and runner-image tools (`bash`, coreutils, `jq`, `gh`). It never runs `npm` or a repository script, and it passes the token only to `gh` through `GH_TOKEN`. Untrusted values are not interpolated into scripts; the branch and SHA come from `GITHUB_*` variables.
- The artifact is data. `commit` writes only the two fixed paths, checks the file list, emptiness and inline safety, and never executes the bytes. It cannot prove the bytes are the true build: a compromised devDependency could change what is committed. That change would be a visible bot commit on `improve/integration`, and #31's `build-verify` rebuilds independently on another runner and requires the changed files to equal that build before anything reaches `main`. The same lockfile feeds both, so a compromised Terser is the residual risk, as it already was for locally built files.
- `createCommitOnBranch` with `GITHUB_TOKEN` produces a commit authored by `github-actions[bot]` and signed by GitHub (Verified, §5.2). A plain `git push` from the runner would be unsigned.

## 4. Transition and #31

- **Merge order.** Done: #50 and #48 (both had carried a regenerated min.js) merged before this pull request, and this branch was rebased onto `197772d` (§12). No open pull request carries the generated files. After this pull request merges, `dist.yml`'s first run finds the files up to date, because it changes no source.
- **#31 after each merge.** A human merge into `improve/integration` fires `synchronize` on #31: `build-verify` compares the changed files with a fresh build and fails on the not-yet-rebuilt head. CI's rebuild commit, made with `GITHUB_TOKEN`, fires no event, so #31's head is then a bot commit with no checks, and `main`'s ruleset requires `test`, `lint`, `build-verify`, `browser-smoke` and both review gates on the head. Before merging #31: push a signed human commit on top of the rebuild commit (an empty one is enough; `dist.yml` then finds the files up to date), or close and reopen #31 (all four pull request workflows list `reopened`). Re-running an old run checks the old head, not the bot commit.
- **AGENTS.md** on `main` still says to include the generated files; CONCURRENCY rule 12 overrides it until T9 updates it. Proposed wording in §7.
- **Review workflows.** `claude-review.yml`, `codex-review.yml`, `review-helpers.yml` and `.github/prompts/**` do not assume pull requests carry the generated files (their prompts mention "generated files" only as in scope for review). No change needed.

## 5. Self-test on GitHub

Throwaway branches with one test-only commit each: the trigger widened to `dist-selftest/**` and the `commit` guard to `refs/heads/dist-selftest/*`, plus a stale `webaudio-tinysynth.min.js` (the build from `b198d6c^`). Nothing else differs from `t1/dist-ci`'s `dist.yml`.

All five runs passed (`_evidence/t1-dist/selftest/`: `runs.txt`, commit-step logs, commit JSON, `verify-85d840e.log`). In run 37225981908, `build` took 7 min 47 s, `browser-smoke` 33 s in parallel, and `commit` 9 s.

| # | Path | Run | Result |
| --- | --- | --- | --- |
| 5.1 | Stale min.js pushed (`dist-selftest/1` at `3c2619e`) | [37225981908](https://github.com/Provable-Games/webaudio-tinysynth/actions/runs/37225981908) | `committed 85d840e7d74508c9b8924c3969520d06e67dd547` |
| 5.3 | Pushed again with no change (empty commit `a4c817d` on top of the rebuild) | [37226544944](https://github.com/Provable-Games/webaudio-tinysynth/actions/runs/37226544944) | `up to date: the committed files at a4c817d… equal the build`; nothing committed |
| 5.4 | Race: run A for `6d81ef3`, then push B (`aa21120`) while A ran; `cancel-in-progress: false` on that branch only, so A reached its commit step | A: [37225990517](https://github.com/Provable-Games/webaudio-tinysynth/actions/runs/37225990517); B: [37226003000](https://github.com/Provable-Games/webaudio-tinysynth/actions/runs/37226003000) | A: `::notice::dist-selftest/2 moved from 6d81ef3 to aa21120 during this run; nothing committed`, job green. B: `committed 88299c82b2506cc0e34dd4146cd146d5b10e50a0` on top of `aa21120` |
| 5.5 | Loop guard: a new branch `dist-selftest/3` pushed at the bot commit `85d840e` (a human push whose head commit is the rebuild) | [37226545843](https://github.com/Provable-Games/webaudio-tinysynth/actions/runs/37226545843) | every job skipped |

5.2, the bot commits (`gh api repos/…/commits/<sha>`):

- `85d840e`: author and login `github-actions[bot]` (`41898282+github-actions[bot]@users.noreply.github.com`), committer `GitHub`, `verification.verified: true`, reason `valid`. Parent `3c2619e`. Headline `Rebuild webaudio-tinysynth.min.js for 3c2619e`; body: source SHA, min.js sha256 `2f764960…`, map sha256 `f33403e4…`, run URL. Only min.js changed (the map was not stale; an identical addition makes no change).
- `88299c8`: the same author, Verified, parent `aa21120`.
- Its files equal a fresh build: `npm run verify` at `85d840e` passes (min.js `2f764960…`, map `f33403e4…`, the hashes of the base's files).
- No further run: `GET /actions/runs?head_sha=` returns `total_count: 0` for both bot commits.
- The token was accepted: the repository's default workflow permission is `read`, and the job-level `contents: write` was enough. No setting was changed.

Afterwards `dist-selftest/1`, `/2` and `/3` were deleted (`git ls-remote origin 'refs/heads/dist-selftest/*'` is empty). The test-only trigger never reached `t1/dist-ci`.

## 6. Validation

Logs in `_evidence/t1-dist/`. Node 24.21.0, npm 11.19.0. This section is the first validation, on base `19cb982` and the first rule; the final validation, after the rebase onto `197772d` and the design adjustment, is in §12.

| Command | Result |
| --- | --- |
| `npm ci` | ok, 0 vulnerabilities |
| `npm run lint` | ok (also after a test run leaves `.build/`) |
| actionlint 1.7.12 + shellcheck 0.11.0 on all workflows | clean |
| `npm test` from no `.build/` (`npm-test-1.log`) | unit 10 files / 716 tests; node 11 files / 139 tests (floors raised from 10/126 to the printed counts); regressions 3 of 3. Each suite printed `min.js under test: .build/webaudio-tinysynth.min.js (fresh build, terser 5.51.2)`. `git status` afterwards: no tracked file modified. |
| `node --test tests/node/check-dist.test.cjs` | 13 of 13 |
| `npm run pack:check` | PASS; 7 files; installed min.js sha256 equals the fresh build's |
| `npm run verify` | PASS (committed equals fresh on this branch) |
| `npm run test:browser` through `heavy-run.sh` | 2 of 2 |
| `node scripts/browser-matrix.js --engines=chromium --specs=embed` | PASS, 4 of 4, min build from `.build/`. The full three-engine matrix is left to this pull request's Browser matrix CI (rule 11); this change touches only path resolution in the matrix. |

Loaders read the fresh build, not the committed copy (`vacuity-loaders.log`): with the committed `webaudio-tinysynth.min.js` moved out of the checkout, `exports` and `equivalence` still pass 14 of 14; with `TINYSYNTH_MIN` pointing at a copy whose class is renamed, `exports` fails.

Pull request rule, locally on simulated merge refs (`pr-scenario.log`, `pr-scenario.sh`): a branch that changes only the source passes `check-dist.js --github` in its merge commit; the same branch with the in-place rebuild committed fails, naming both files and printing `git checkout origin/improve/integration -- webaudio-tinysynth.min.js webaudio-tinysynth.min.js.map`. `--unchanged-from=<base>` fails on that branch and passes after the fix command and a commit. `--fresh` on the source-only branch fails, which is what #31 shows between a merge and CI's rebuild.

## 7. AGENTS.md wording proposal (for T9; AGENTS.md is on `main`)

- Replace "`npm run build`: use Terser to regenerate the minified library and source map. Include both generated files with source changes." with: "`npm run build`: the pinned Terser build of `webaudio-tinysynth.min.js` and its map. Pull requests never commit these two files, except a `release/*` pull request into `main` (README, "Releases"): CI (`.github/workflows/dist.yml`) rebuilds and commits them on `improve/integration` after each merge, and `build-verify` fails any other pull request that changes them. Tests build into the ignored `.build/` automatically."
- Replace "Edit the source and regenerate distribution files." with: "Edit only the source; never edit or commit the generated files. If they changed, restore them with `git checkout origin/<base> -- webaudio-tinysynth.min.js webaudio-tinysynth.min.js.map`."

## 8. Deviations and decisions

- **README.md.** The assignment lists the README development section as an allowed file and a deliverable, and the coordinator's design adjustment (§12) asks for the verification and release text; CONCURRENCY rule 4 says not to edit README. The edits are confined to the "Development" and "Verifying the minified build" sections (with its new "Releases" subsection), in their own commits (`f46b93e`, `eb63c8c`, and a hunk of `d78078d`), and the text is below for integration. NOTICE is unchanged: this is a CI and release process change, not a library behavior change.
- **`eslint.config.mjs`** (outside the allowed list): one ignore line for `.build/**`. Flat config lints dot-directories, and `npm run lint` after any test run failed with 24 errors on `.build/webaudio-tinysynth.min.js` without it.
- **`.build/` rather than the fallback** (build in place): the loaders already resolved the path in a handful of places, so one helper was not invasive.

### Draft README/NOTICE text (CONCURRENCY rule 4)

The README changes as committed, verbatim (`git diff 197772d -- README.md`), for pasting if those commits are dropped:

```diff
@@ -378,10 +378,10 @@ Use Node 24.21.0 (`.nvmrc`), which comes with npm 11.19.0, and install the locke
 | Command | What it does |
 | --- | --- |
 | `npm run lint` | ESLint with the recommended rules (`eslint.config.mjs`). |
-| `npm run build` | Minifies `webaudio-tinysynth.js` into `webaudio-tinysynth.min.js` and its source map with the pinned Terser. Every option is in `scripts/build.js`. |
+| `npm run build` | Minifies `webaudio-tinysynth.js` into `webaudio-tinysynth.min.js` and its source map with the pinned Terser. Every option is in `scripts/build.js`. `npm run build -- DIR` writes them to `DIR` instead of the repository root. CI runs this build after each merge; see below. |
 | `npm run verify` | Rebuilds into a temporary directory and fails if the committed `webaudio-tinysynth.min.js` or its map differ. Also fails if the minified file or the source contains `</script`, `<script` or `<!--` in any letter case, or a non-ASCII byte. Prints sizes and SHA-256. |
-| `npm run size` | Raw size, gzip size and SHA-256 of the source, the minified file and the map. |
-| `npm run pack:check` | Checks the files `npm pack` would publish, installs the tarball in a scratch project outside the repository and `require()`s it there. |
+| `npm run size` | Raw size, gzip size and SHA-256 of the source and of a fresh build of it (minified file and map). |
+| `npm run pack:check` | Checks the files `npm pack` would publish, then packs them with a fresh build of the minified file and map, installs the tarball in a scratch project outside the repository and `require()`s it there. |
 | `npm test` | `test:unit`, `test:node` and `test:regression`, in that order. It stops at the first failing suite. |
 | `npm run test:unit` | Vitest unit tests, `tests/unit/**/*.test.mjs` (`scripts/run-unit-tests.js` runs `vitest run`). |
 | `npm run test:node` | `node:test` tests, `tests/node/**/*.test.cjs` (`scripts/run-node-tests.js`), killed after 600 s. |
@@ -389,21 +389,32 @@ Use Node 24.21.0 (`.nvmrc`), which comes with npm 11.19.0, and install the locke
 | `npm run test:browser` | Offline smoke test of both builds in headless Chromium. Install the browser first with `npx playwright-core install --with-deps --only-shell chromium`. A missing browser fails the test. Chromium runs with autoplay allowed, so the test does not show that audio starts after a user gesture. |
 
 - The regressions compare against upstream commit `3d75aee`, read from git history. Clone with full history (a shallow clone fails), or set `TINYSYNTH_REFERENCE` to upstream's `webaudio-tinysynth.js` at that commit.
-- Never edit `webaudio-tinysynth.min.js` or its map by hand. After changing the source, run `npm run build` and commit both files. CI fails if they differ from a fresh build.
+- Pull requests do not change `webaudio-tinysynth.min.js` or its map, except a release pull request (see "Releases" below), and nobody edits them by hand. After each merge into `improve/integration`, CI (`.github/workflows/dist.yml`) rebuilds both with the pinned build, runs the tests against the new bytes and commits them as `github-actions[bot]`, titled `Rebuild webaudio-tinysynth.min.js for <commit>`. The `build-verify` check fails a pull request that changes either file, unless its branch is `improve/integration` or `release/*` and both equal a fresh build. Restore them with `git checkout origin/<base branch> -- webaudio-tinysynth.min.js webaudio-tinysynth.min.js.map` and commit. `node scripts/check-dist.js --unchanged-from=origin/<base branch>` runs the same check locally.
+- The test commands, `pack:check` and `size` build the current source into the ignored `.build/` directory first and test that, never the committed `webaudio-tinysynth.min.js`, so they leave tracked files unchanged. To test another copy, set `TINYSYNTH_MIN=path/to/file.min.js`. A test file run on its own reads `.build/`; refresh it with `node scripts/test-build.js`.
 - The test commands fail closed. `test:unit` and `test:node` fail when no test file matches, when a file passes no test, when a `node:test` file exits before its tests finish, or when fewer files ran or fewer tests passed than the floors committed in `package.json` (`--min-files`, `--min-tests`). When you add tests, raise the floors to the new counts printed at the end of the run. `test:regression` and `test:browser` require each script to exit 0 and print a final `PASS:` line.
 - The test commands use POSIX process groups to stop hung tests, so they run on Linux and macOS.
-- CI (`.github/workflows/ci.yml`) runs the `lint`, `build-verify`, `test` and `browser-smoke` jobs on pull requests and on pushes to `main`.
+- CI (`.github/workflows/ci.yml`) runs the `lint`, `build-verify`, `test` and `browser-smoke` jobs on pull requests and on pushes to `main`. On pushes to `main` they build and test the current source but do not compare the committed minified file with it: between releases it may be older than the source.
 
 ## Verifying the minified build
 
 The onchain player embeds the exact bytes of `webaudio-tinysynth.min.js` and publishes their SHA-256. To check that a copy was built from this source:
 
-1. Check out the commit with full history and LF line endings (on Windows, `git clone -c core.autocrlf=false`), use the Node version in `.nvmrc`, and run `npm ci`.
+1. Check out a release tag (`vX.Y.Z`) or a `Rebuild webaudio-tinysynth.min.js for …` commit by `github-actions[bot]` on `improve/integration`, with full history and LF line endings (on Windows, `git clone -c core.autocrlf=false`). Use the Node version in `.nvmrc`, and run `npm ci`.
 2. Run `npm run verify`. It rebuilds the minified file and its map with the pinned Terser, requires both to equal the committed files byte for byte, and prints their SHA-256.
 3. Hash your copy (`sha256sum webaudio-tinysynth.min.js`, or `shasum -a 256` on macOS) and compare.
 
+Elsewhere on `main`, the committed minified file may be older than the source, and `npm run verify` fails there. So does `improve/integration` right after a merge, until CI's rebuild commit lands (about ten minutes).
+
 The minified file starts with the source's license header and has no `sourceMappingURL` comment; to debug it, load `webaudio-tinysynth.min.js.map` next to it. Minification renames local variables only: the class, its methods, options and properties keep their names.
 
+### Releases
+
+On `main`, the minified file and its map change only in a release, made by hand:
+
+1. From `main`, create `release/vX.Y.Z`. Bump the version with `npm version X.Y.Z --no-git-tag-version` (it updates `package.json` and `package-lock.json`), run `npm run build`, and commit the version change and both files.
+2. Open a pull request into `main`; `build-verify` requires both files to equal a fresh build. After it is squash-merged, tag the merge commit and push the tag: `git tag -s vX.Y.Z <merge sha>` and `git push origin vX.Y.Z`.
+3. Run `gh release create vX.Y.Z webaudio-tinysynth.min.js webaudio-tinysynth.min.js.map` from a checkout of the tag, with the SHA-256 and sizes from `npm run size` in the notes.
+
 ## License
 
 Licensed under the Apache License, Version 2.0
```

No NOTICE text: this changes the CI and release process, not the library.

## 9. `main`: no automation needed

The user does not want `main` automated (§12). On `main` the generated files change only in a manual release pull request from a `release/*` branch, which `build-verify` requires to carry a fresh build, followed by a signed tag and a GitHub Release (README, "Releases"). Between releases `main`'s committed min.js may be older than its source, and pushes to `main` no longer compare it. So no GitHub App, ruleset bypass or other write access to `main` is needed; this replaces the earlier "automate `main` later" item. `dist.yml` keeps rebuilding `improve/integration` exactly as designed.

## 10. Open risks

- **#31 checks after each merge** (§4): red `build-verify` after each human merge, then an unchecked bot head. Needs a reopen or a human commit before merging into `main`.
- **`main` lags its source between releases.** A consumer who pins an arbitrary `main` commit can get a min.js older than that commit's source; `npm run verify` fails there. The README tells consumers to pin a release tag or a rebuild commit.
- **A release pull request that forgets to rebuild passes** (both files unchanged is always allowed). The release steps in the README include `npm run build`; the tag is still made by hand.
- **Rebuild window.** For about eight to nine minutes after each merge, `improve/integration`'s committed min.js is older than its source and `npm run verify` fails there. If `build` or `browser-smoke` fails, there is no rebuild until the next push or a manual run (`workflow_dispatch`, once `dist.yml` is on `main`), and the failure appears only in the Dist run, not on a pull request.
- **Runner-image tools.** `commit` relies on `gh`, `jq`, `base64`, `gzip` and GNU `find` from the `ubuntu-24.04-arm` image; the self-test used them.
- **Artifact integrity** rests on the build job's dependencies (§3).
- **Direct test runs** (`node tests/tempo.js`, `npx vitest`) read whatever `.build/` holds; they do not rebuild. The npm scripts always rebuild.

## 11. Review round 1 (PR #51, head `91fd11b`)

All CI checks passed on `91fd11b`, including the three-engine Browser matrix (chromium 14 min, firefox 15 min, webkit 16 min) and the first CI run of the new `build-verify` rule. The Codex review gate failed on one HIGH finding, which the Claude review also raised as MEDIUM.

| Finding | Decision | Change |
| --- | --- | --- |
| Codex HIGH, Claude MEDIUM: a pull request into `main` from any branch other than `improve/integration` got the `unchanged` rule. Nothing rebuilds `main`, so a source-changing hotfix into `main` would pass, leave `main`'s min.js stale, and break the README's "pin the head of `main`" guidance. Before this change, the drift checks prevented that. | Accepted | `decide()`: every `pull_request` into `main` gets `fresh`. `unchanged` is kept for every other base, including stacked pull requests into feature branches, because their files reach `improve/integration`, where CI rebuilds them. A docs pull request into a consistent `main` still passes. Test: hotfix, docs and fork pull requests into `main` get `fresh`; a stacked pull request gets `unchanged`. `ci.yml` comments, README CI bullet, §2.2 updated. |
| Codex LOW: an uncommitted deletion of a generated file passed the local `--unchanged-from` check (the working-tree comparison was skipped when the file was missing). | Accepted | Missing working-tree file reported as `… is deleted in the working tree`. Test covers unstaged and staged deletions. |

Both new assertions fail against the previous `check-dist.js` (2 of 14 tests, `_evidence/t1-dist/review-fix-vacuity.log`) and pass with the fix. Node floors are now 11 files and 140 tests, as printed by `npm run test:node`.

The `fresh`-for-every-pull-request-into-`main` rule from this round was replaced by the design adjustment in §12, which addresses the same finding differently: `main` does not promise a current min.js between releases, and only `release/*` (or `improve/integration`) may change the files there, to a fresh build.

## 12. Base update and design adjustment (coordinator, 2026-10-04)

**Base update.** `improve/integration` moved from `19cb982` to `197772d` (#50, #48 squash `8f7b600`, and the supervisor's record commit). `t1/dist-ci` was rebased onto it (conflicts only in the `package.json` floors). #48's new tests: `tests/unit/api.test.mjs` uses `variants` from the harness and `tests/browser/specs/api-url.js` uses `pages.readLibrary()`, so both already read the fresh build; `tests/node/api.test.cjs` required `path.join(H.ROOT, build.name)` and now requires `build.file` (`56b1183`). Floors from the runners' output: unit 11 files / 894 tests (unchanged from the base), node 12 files / 148 tests.

**Design adjustment.** The user does not want `main` automated: on `main`, min.js and its map change only in a manual release pull request, followed by a tag and a GitHub Release. The `improve/integration` rebuild bot is unchanged.

1. Pull request rule (`758e730`): pass if both files are unchanged from the base, or if the head is this repository's `improve/integration` or a `release/*` branch and both equal a fresh build; any other change fails with the fix command. The four required cases are node tests (`checkPullRequest()`: feature unchanged, feature changed, `release/*` fresh, `release/*` stale), plus `release/*` unchanged and the `decide()` cases.
2. Push to `main` (and manual runs): no committed-equals-fresh comparison; `build-verify` builds fresh and runs the inline-safety checks, `pack:check` and the size report on it, and `test`/`browser-smoke` test it.
3. README (`eb63c8c`): a consumer checks out a release tag `vX.Y.Z` or an `improve/integration` rebuild commit and runs `npm run verify`; elsewhere on `main` the committed min.js may be older than the source. A short manual "Releases" subsection: `release/vX.Y.Z` from `main`, `npm version X.Y.Z --no-git-tag-version`, `npm run build`, commit; pull request; after the squash merge `git tag -s vX.Y.Z <merge sha>` and push the tag; `gh release create vX.Y.Z webaudio-tinysynth.min.js webaudio-tinysynth.min.js.map` with the SHA-256 and sizes from `npm run size`. No release workflow.
4. §9 now records that `main` automation is not needed. The #31 note in §4 stands.

**Validation after both changes** (logs `_evidence/t1-dist/rebase-*.log`, `pr-scenario.log`): `npm ci`, lint and actionlint clean; `test:unit` 11/894, `test:node` 12/148 (with `check-dist.test.cjs` 17 of 17), `test:regression` 3 of 3, each on `.build/`; `pack:check` PASS; `test:browser` (heavy-run) 2 of 2; `browser-matrix --engines=chromium --specs=api-url` 2 of 2 on `.build/`; `npm run verify` PASS on the branch. Simulated merge commits with the real pinned build (`pr-scenario.sh`): feature source-only into `improve/integration` passes; feature carrying its rebuild fails with the fix command; `release/v9.9.9` carrying a fresh build into `main` passes; the same with the source changed after the rebuild fails ("differs from a fresh build of this source"); `improve/integration` with that stale build (as #31 before CI's rebuild) fails; a fork's `improve/integration` changing them fails as a feature; a push event checks inline safety only and passes; `--unchanged-from` fails before and passes after the fix command. `dist.yml` changed only in its header comment, so the §5 self-test still covers it.
