# T1-dist: CI generates webaudio-tinysynth.min.js and its map (D-036)

| Item | Value |
| --- | --- |
| Task | T1-dist: pull requests stop carrying `webaudio-tinysynth.min.js` and `webaudio-tinysynth.min.js.map`. After each push to `improve/integration`, CI rebuilds both with the pinned build and commits them with `GITHUB_TOKEN` through GraphQL `createCommitOnBranch`. Feature pull requests must leave the files unchanged; local tests build into an ignored directory. |
| Base commit | `19cb982ca3852b6232f8e46f476c2457b2ffeef6` (`origin/improve/integration`) |
| Branch / worktree | `t1/dist-ci` in `/workspace/webaudio-tinysynth-worktrees/t1-dist` |
| Assignment | `_evidence/assignments/T1-dist.md` and `CONCURRENCY.md` (rules 1–12) |
| Evidence outside the repo | `/workspace/webaudio-tinysynth-worktrees/_evidence/t1-dist/`: `npm-test-*.log`, `test-browser.log`, `matrix-*.log`, `pack-check.log`, `vacuity-loaders.log`, `pr-scenario.log` (and its script `pr-scenario.sh`), `selftest/` (run logs, commit and verification JSON) |
| Toolchain | Node 24.21.0 / npm 11.19.0 (`_evidence/t1-tooling/tools`), actionlint 1.7.12 with shellcheck 0.11.0, Chromium 153 through `_evidence/t6-validation/env.sh` |

## 1. Commits

All GPG-signed (`git log --format='%h %G?'` shows `G`).

| Commit | Subject | Files |
| --- | --- | --- |
| `a37544a` | Test a fresh min.js build in .build instead of the committed copy | `scripts/test-build.js` (new), `tests/harness.js`, `tests/node/{exports,lifecycle,seed}.test.cjs`, `tests/browser/lib/pages.js`, `tests/browser-smoke.js`, `scripts/{browser-server,browser-matrix,run-unit-tests,run-node-tests,run-regressions,size,check-pack}.js`, `.gitignore`, `eslint.config.mjs` (see §8) |
| `0937626` | Require feature pull requests to leave the generated files unchanged | `scripts/check-dist.js` (new), `scripts/verify-dist.js` (exports its inline check), `tests/node/check-dist.test.cjs` (new), `package.json` (node floors), `.github/workflows/ci.yml`, `.github/workflows/browser-matrix.yml`, `.gitattributes` |
| `df1fa8c` | Rebuild the generated files in CI after each push to improve/integration | `.github/workflows/dist.yml` (new) |
| `4545631` | Document that CI generates min.js and which commits to pin | `README.md` (development and verification sections; see §8) |
| `d0e1ed6` | Point a fresh-rule failure at CI's rebuild commit | `scripts/check-dist.js` (message only) |
| `2fa7967`, `91fd11b` | Record T1-dist; paste the README draft verbatim | `docs/improvements/tasks/T1-dist.md` |
| `a8d4e15` | Require a fresh build on every pull request into main (review, §11) | `scripts/check-dist.js`, `tests/node/check-dist.test.cjs`, `package.json` (node floor 140), `.github/workflows/ci.yml` (comments), `README.md` |
| this update | Record the review round | this record |

The committed min.js and map are byte-identical to the base (`git diff 19cb982 -- webaudio-tinysynth.min.js*` is empty), so this pull request passes its own new rule.

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
- `build-verify` runs `node scripts/check-dist.js --github`, then `pack:check` and `size`, both on the fresh build. `check-dist.js` decides from the event:

| Event | Rule |
| --- | --- |
| `pull_request` into `main` (#31, and any hotfix or docs pull request into `main`) | **fresh**: committed equals a fresh build (`npm run verify`). Nothing rebuilds `main`, so whatever merges into it must already carry the build (review finding, §11) |
| `pull_request` from this repository's `improve/integration` into another base | **fresh** |
| any other `pull_request` (feature PRs into `improve/integration`, stacked PRs into feature branches, a fork's branch named `improve/integration`) | **unchanged**: in the merge commit, both files' blobs equal `HEAD^1`'s (the base tip). Failure prints the problem and `git checkout origin/<base> -- webaudio-tinysynth.min.js webaudio-tinysynth.min.js.map` |
| `push` (to `main`), `workflow_dispatch` | **fresh** |
| always | a fresh build and the source are inline-safe |

Locally, `--unchanged-from=REF` applies merge semantics: it passes if HEAD's copy equals REF's or the merge base's (the branch did not touch it), and the working tree has no uncommitted change to or deletion of either file. In the merge-ref checkout both collapse to `HEAD == HEAD^1`. `decide()`, `fromGithub()` and `checkUnchanged()` are exported and tested by `tests/node/check-dist.test.cjs` (14 tests, scratch git repositories with isolated git config).

### 2.3 Local development

Preferred approach, as built. `scripts/test-build.js` is the one place that resolves the min.js under test: `TINYSYNTH_MIN` if set, else `.build/webaudio-tinysynth.min.js`. `prepare()` builds there with the pinned `scripts/build.js` (into a private temp directory under `.build/`, then renames, so concurrent runs in one checkout never read a partial file) and exports `TINYSYNTH_MIN` to child processes. With `TINYSYNTH_MIN` already set it builds nothing. `run-unit-tests`, `run-node-tests`, `run-regressions` (so `test:regression` and `test:browser`), the `browser-matrix` orchestrator (unless `--min=`), `check-pack`, `size` and the `browser-server` CLI call `prepare()` first. The loaders (`harness.forkVariants()` with a new `file` field, `pages.libraryPath()`, `browser-server`'s `/lib/min.js`, `browser-smoke.js`, and the `require()`s in three node tests) read through it. A missing build is an error that names `node scripts/test-build.js`; nothing falls back to the committed copy.

`pack:check` checks the whitelist on the repository (`npm pack --dry-run`), stages those files with the fresh min.js and map, packs and installs the staged copy, and compares the installed files with what was staged. `npm run size` reports the source and the fresh build; `npm run verify` keeps its consumer meaning (committed equals fresh, plus inline safety and sizes of the committed files). `npm run build` still writes to the repository root by default; it is the command CI's build job uses (with an output directory).

`.build/` is in `.gitignore` and in ESLint's ignores; both generated files are `linguist-generated=true` in `.gitattributes`.

## 3. Trust boundary

- Third-party code (`npm ci`: Terser, Vitest, ESLint, Playwright and their dependencies) runs only in `build` and `browser-smoke`, with a read-only token and no persisted credentials.
- The write token exists only in `commit`, which runs two pinned GitHub actions (`download-artifact`, `checkout` with `persist-credentials: false`) and runner-image tools (`bash`, coreutils, `jq`, `gh`). It never runs `npm` or a repository script, and it passes the token only to `gh` through `GH_TOKEN`. Untrusted values are not interpolated into scripts; the branch and SHA come from `GITHUB_*` variables.
- The artifact is data. `commit` writes only the two fixed paths, checks the file list, emptiness and inline safety, and never executes the bytes. It cannot prove the bytes are the true build: a compromised devDependency could change what is committed. That change would be a visible bot commit on `improve/integration`, and #31's `build-verify` (fresh rule) rebuilds independently on another runner before anything reaches `main`. The same lockfile feeds both, so a compromised Terser is the residual risk, as it already was for locally built files.
- `createCommitOnBranch` with `GITHUB_TOKEN` produces a commit authored by `github-actions[bot]` and signed by GitHub (Verified, §5.2). A plain `git push` from the runner would be unsigned.

## 4. Transition and #31

- **Merge order.** #48 (T5) carries a regenerated min.js and map. Pull request workflows run from the merge ref, so once this pull request is on `improve/integration`, #48's next `synchronize` applies the new rule and fails `build-verify`. Merge #48 first (then this branch merges `improve/integration` and recomputes the node floors, rules 5 and 6, since #48 also adds node tests), or have #48 run the fix command (`git checkout origin/improve/integration -- webaudio-tinysynth.min.js webaudio-tinysynth.min.js.map`) and commit. #50 also carried them while open, but merged at `30f1506` with only NOTICE and README changed. `improve/integration` moved to `30f1506` during this work; `git merge-tree` with it is clean, and no rebase was requested. After this pull request merges, `dist.yml`'s first run finds the files up to date, because it changes no source.
- **#31 after each merge.** A human merge into `improve/integration` fires `synchronize` on #31: `build-verify` runs the fresh rule on the not-yet-rebuilt head and fails. CI's rebuild commit, made with `GITHUB_TOKEN`, fires no event, so #31's head is then a bot commit with no checks, and `main`'s ruleset requires `test`, `lint`, `build-verify`, `browser-smoke` and both review gates on the head. Before merging #31: close and reopen it (all four pull request workflows list `reopened`), or push a signed commit on top of the rebuild commit (an empty one is enough; `dist.yml` then finds the files up to date). `workflow_dispatch` of `ci.yml` on `improve/integration` would attach `lint`/`test`/`build-verify`/`browser-smoke` to the head but not the review gates. A re-run of an old run checks the old head, not the bot commit.
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

Logs in `_evidence/t1-dist/`. Node 24.21.0, npm 11.19.0.

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

- Replace "`npm run build`: use Terser to regenerate the minified library and source map. Include both generated files with source changes." with: "`npm run build`: the pinned Terser build of `webaudio-tinysynth.min.js` and its map. Pull requests never commit these two files: CI (`.github/workflows/dist.yml`) rebuilds and commits them on `improve/integration` after each merge, and `build-verify` fails a feature pull request that changes them. Tests build into the ignored `.build/` automatically."
- Replace "Edit the source and regenerate distribution files." with: "Edit only the source; never edit or commit the generated files. If they changed, restore them with `git checkout origin/<base> -- webaudio-tinysynth.min.js webaudio-tinysynth.min.js.map`."

## 8. Deviations and decisions

- **README.md.** The assignment lists the README development section as an allowed file and a deliverable; CONCURRENCY rule 4 says not to edit README. The edit is confined to the "Development" and "Verifying the minified build" sections, in its own commit (`4545631`) so the supervisor can drop it, and the same text is below for integration. NOTICE is unchanged: this is a CI process change, not a library behavior change.
- **`eslint.config.mjs`** (outside the allowed list): one ignore line for `.build/**`. Flat config lints dot-directories, and `npm run lint` after any test run failed with 24 errors on `.build/webaudio-tinysynth.min.js` without it.
- **`.build/` rather than the fallback** (build in place): the loaders already resolved the path in a handful of places, so one helper was not invasive.

### Draft README/NOTICE text (CONCURRENCY rule 4)

Committed in `4545631` and amended by the review fix (§11), so the supervisor can keep or drop those hunks. Verbatim, for pasting if they are dropped. In "Development", the table rows for `npm run build`, `npm run size` and `npm run pack:check` become:

```markdown
| `npm run build` | Minifies `webaudio-tinysynth.js` into `webaudio-tinysynth.min.js` and its source map with the pinned Terser. Every option is in `scripts/build.js`. `npm run build -- DIR` writes them to `DIR` instead of the repository root. CI runs this build after each merge; see below. |
| `npm run size` | Raw size, gzip size and SHA-256 of the source and of a fresh build of it (minified file and map). |
| `npm run pack:check` | Checks the files `npm pack` would publish, then packs them with a fresh build of the minified file and map, installs the tarball in a scratch project outside the repository and `require()`s it there. |
```

The bullet "Never edit `webaudio-tinysynth.min.js` or its map by hand. After changing the source, run `npm run build` and commit both files. CI fails if they differ from a fresh build." becomes these two bullets:

```markdown
- Pull requests do not change `webaudio-tinysynth.min.js` or its map, and nobody edits them by hand. After each merge into `improve/integration`, CI (`.github/workflows/dist.yml`) rebuilds both with the pinned build, runs the tests against the new bytes and commits them as `github-actions[bot]`, titled `Rebuild webaudio-tinysynth.min.js for <commit>`. The `build-verify` check fails a pull request into any branch other than `main` that changes either file; restore them with `git checkout origin/<base branch> -- webaudio-tinysynth.min.js webaudio-tinysynth.min.js.map` and commit. `node scripts/check-dist.js --unchanged-from=origin/<base branch>` runs the same check locally.
- The test commands, `pack:check` and `size` build the current source into the ignored `.build/` directory first and test that, never the committed `webaudio-tinysynth.min.js`, so they leave tracked files unchanged. To test another copy, set `TINYSYNTH_MIN=path/to/file.min.js`. A test file run on its own reads `.build/`; refresh it with `node scripts/test-build.js`.
```

The CI bullet becomes:

```markdown
- CI (`.github/workflows/ci.yml`) runs the `lint`, `build-verify`, `test` and `browser-smoke` jobs on pull requests and on pushes to `main`. Nothing rebuilds them on `main`, so on pull requests into `main` (normally from `improve/integration`, which carries CI's rebuild) and on pushes to `main`, `build-verify` requires the committed files to equal a fresh build (`npm run verify`).
```

In "Verifying the minified build", after step 2 (indented under it):

```markdown
   Pin a commit where it passes, such as a `Rebuild webaudio-tinysynth.min.js for …` commit by `github-actions[bot]` on `improve/integration`, or the head of `main` (CI runs this check on every push to `main`). Right after a merge into `improve/integration`, until CI's rebuild commit lands (about ten minutes), the committed minified file there is older than the source and `npm run verify` fails.
```

No NOTICE text: this changes the CI process, not the library.

## 9. Deferred: automating `main`

`GITHUB_TOKEN` cannot write to `main`: the `protect main` ruleset requires a pull request and the six checks, and its only bypass actor is one user. So `main` only receives generated files through #31, already rebuilt on `improve/integration`, and every push to `main` runs the fresh rule. Automating `main` later needs one of: a GitHub App installation token with a ruleset bypass for that App (commits through `createCommitOnBranch` stay GitHub-signed), or adding the Actions integration as a bypass actor. Either is a settings decision for the user; nothing here depends on it.

## 10. Open risks

- **#31 checks after each merge** (§4): red `build-verify` after each human merge, then an unchecked bot head. Needs a reopen or a human commit before merging into `main`.
- **#48 carries min.js.** It fails the new rule if it updates after this merges, until it restores the files.
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
