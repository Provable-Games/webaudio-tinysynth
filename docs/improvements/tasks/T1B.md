# T1B: later CI extensions

| Item | Value |
| --- | --- |
| Task | T1B: restore headroom in the browser matrix by sharding it, retry malformed AI-review output once, run the demos spec in CI, and evaluate checks on the bot's rebuild commit at #31's head |
| Base | `improve/integration` `2f82ec7` |
| Branch / worktree | `t1/ci-ext` in `/workspace/webaudio-tinysynth-worktrees/t1-ci-ext`; PR #62 |
| Assignment | `_evidence/assignments/T1B.md` and `CONCURRENCY.md` (rules 1-13) |
| Records read | `decisions.md` D-009, D-012, D-032, D-036, D-037, D-041; `T1-ai-review.md`, `T1-dist.md`, `T9.md` (T9-11) |
| Evidence outside the repo | `/workspace/webaudio-tinysynth-worktrees/_evidence/t1-ci-ext/` |
| Toolchain | actionlint 1.7.12, shellcheck 0.11.0, Python 3 `unittest`, Node 24 |

Files changed: `.github/workflows/{browser-matrix,claude-review,codex-review}.yml`, `.github/scripts/{review.py,review_lib.py,test_review.py,README.md}`, `scripts/browser-matrix.js`, `tests/browser/matrix.js` (a `seconds` field per spec), `tests/node/browser-matrix-shards.test.cjs`, `package.json` (node floors 14 files, 170 tests), `README.md`. The engine, NOTICE, rulesets and settings are untouched.

## 1. Browser matrix sharding

**Problem.** On PR #61 the per-engine assert steps took 695 s (Chromium), 736 s (Firefox) and 796 s (WebKit) of the 1,200 s engine deadline (`MATRIX.engineDeadline`), and each new spec adds to that. All three engines ran in separate jobs, but each job ran every spec in series.

**Design.**

- `tests/browser/matrix.js` declares `seconds` for every spec: the slowest engine's measured time in run 37273741105 (`28fba52`), rounded up. It is used only to balance shards.
- `shardLayout(n)` in `scripts/browser-matrix.js` splits all declared specs, assert and observe, across `n` shards: longest first, each to the shard with the least total so far. It depends only on the declaration, so every job computes the same layout. A spec without `seconds` fails the run with a message naming it.
- `--shard=K/N` keeps the selected specs that belong to shard K. A shard none of whose specs are selected by a step (for example the observe step in shard 1) passes without launching a browser. `--list --shard=K/N` prints every shard's specs and measured total.
- Layout for 3 shards: shard 1 `render, filters, embed, url` (392 s declared); shard 2 `variation, dispose, start, seek, parser, hang` (389 s: the two observe specs are 289 s of it, the assert specs 100 s); shard 3 `short-notes, transport, offline, waves, gesture, seed, lifecycle, api-url` (391 s).
- Workflow jobs. `browser (ENGINE, K/3)` runs its shard's assert specs, then its observe specs (`if: !cancelled()`), then uploads both `results.json` files as `browser-results-ENGINE-K`. `demos (ENGINE)` runs `npm run test:browser:demos` (section 3). `browser matrix` (needs both) downloads every result and runs `node scripts/browser-matrix.js --merge=DIR`, which fails unless each declared engine ran each declared spec exactly once, every case passed, no engine failed to launch or stopped early, every shard saw the same browser version, and no file is unreadable or names an undeclared engine. It also fails if any shard or demos job did not succeed. Its summary lists the measured times per shard and per spec against the declared ones, so `seconds` can be refreshed from it.
- Required checks. `gh api repos/Provable-Games/webaudio-tinysynth/rulesets` shows `protect main` requires `test`, `lint`, `build-verify`, `browser-smoke`, `Claude review gate` and `Codex review gate`. None is renamed. The browser matrix was never required; its jobs were `browser (chromium|firefox|webkit)` and are now `browser (ENGINE, K/3)`. `browser matrix` is the single name to require if the user wants the matrix required (a ruleset change, not made here).
- Changing the shard count: edit the shard list, `SHARD` and the job name together. `tests/node/browser-matrix-shards.test.cjs` fails if they disagree.

**Times** (PR #62 run 37284314035 against PR #61's run 37273741105; GitHub job durations include about one minute of setup, browser install and launches):

| Engine | Assert step before | Slowest assert step after (case time) | Slowest job after |
| --- | --- | --- | --- |
| Chromium | 695 s | 337 s (shard 1) | 6 m 5 s |
| Firefox | 736 s | 321 s (shard 1) | 6 m 45 s |
| WebKit | 796 s | 382 s (shard 1) | 7 m 44 s |

Case time per shard (assert, observe): Chromium 1/3 337, 2/3 63 + 266, 3/3 295; Firefox 1/3 321, 2/3 96 + 247, 3/3 318; WebKit 1/3 382, 2/3 76 + 288, 3/3 339. Every step now has at least 3x headroom to the 1,200 s deadline. The workflow's wall time is the slowest job, `browser (webkit, 1/3)`, 7 m 44 s; `test` (8 m 27 s) is now the longest check on the PR. Declared against measured seconds are in the `browser matrix` job's summary; the declared values are within 10% of the slowest engine for the long specs.

## 2. Bounded retry of malformed AI-review output

Full design: `.github/scripts/README.md`, "Retry". In short:

- The first result step records its result as before and also sets the step output `retry`. It is `true` only when the output is `malformed` and carries no review content (`review_lib.retryable_output`): no finding heading, no line that starts like a finding, no `Review incomplete` line, no severity word and no `path:line` anywhere. The PR #39 output (a sentence, then `lgtm`) qualifies. A failed run, withheld credentials, empty output, valid findings, any text that names a finding and the model's own `Review incomplete:` do not: they fail closed without a retry.
- Claude runs again through the same pinned action from the same verified-empty working directory, with the same prompt file, arguments, model, effort and environment. Codex runs the same trusted script with a fresh `CODEX_HOME` holding only the first attempt's `auth.json`. The trusted configuration is fingerprinted again, and the retry's result is recorded only if nothing changed.
- The retry's result step takes `--previous-out`. It re-validates the first attempt (same provider, reviewer, base and head, status `incomplete`, eligible output, no credential material) and screens the retry's output against every credential source. It never asks for another retry, so the bound is one. The workflow has one retry step; the second result replaces the first and is what the gate reads.
- The comment keeps its heading and is updated in place. A note under the heading says the review was retried and why, and the first attempt's output follows in a collapsed block. The gate's message says the review was retried.
- Trust boundary: the workflow YAML comes from the pull request and the helpers from the base. The first result step's command line is unchanged, so a base whose helper predates the retry sets no `retry` output and the retry steps are skipped.

Tests (`.github/scripts/test_review.py`, 78 tests, `RetryTests` and the workflow checks): retryable and final outputs (including an incomplete declaration after a preamble, found by Codex on this PR), the first attempt's output, the retry's result replacing the first with every check of a normal result, Claude's execution checks on the retry, an invalid first attempt failing closed, both Codex homes screened, and one bounded retry with the same inputs in both workflows. No live flake was used.

## 3. Demos in CI (T9-11)

`demos (ENGINE)` runs `npm run test:browser:demos -- --engines=ENGINE --out=...` on its own `ubuntu-24.04-arm` runner, with a 20-minute job timeout and the spec's own deadlines (per case, and 900 s per engine worker), and with the same install and Firefox audio setup as the matrix jobs. The demo pages load `webaudio-tinysynth.js`, so no build step is needed. The spec is not declared in `tests/browser/matrix.js`: it runs its own worker and server, and the aggregate requires its jobs to pass. Job durations on PR #62: Chromium 1 m 1 s, Firefox 1 m 35 s, WebKit 1 m 58 s. `demos.js` is not changed.

## 4. Checks on the bot's rebuild commit at #31's head (recommendation; not implemented)

D-036: a commit made with `GITHUB_TOKEN` starts no workflow runs, so when #31's head is the rebuild commit, none of its required checks exist.

- **Not enough: dispatching CI.** `ci.yml` has `workflow_dispatch`, and `GITHUB_TOKEN` may start a dispatch (`actions: write` on the Dist workflow, `gh workflow run ci.yml --ref improve/integration`). That would give `lint`, `build-verify`, `test` and `browser-smoke` on the new SHA. The two review gates run only on `pull_request` and read the event payload, so they would still be missing and the pull request would stay blocked. Adding a dispatch path to the review workflows would weaken their trust model for little gain.
- **Recommended (no change): a human re-trigger.** The review workflows and CI run on `reopened` and `synchronize`. After the rebuild lands, the user closes and reopens #31, or pushes one signed human commit, which starts every check on the final head. This costs one click per release and needs no new credentials. D-037 already makes releases manual.
- **If the click becomes a nuisance: a token that triggers workflows.** A GitHub App installation token (or a fine-grained PAT) used for the `createCommitOnBranch` call makes the commit start `pull_request` workflows like any other push. This is the same App D-036 defers for `main`; one App would cover both. It is a setting the user would create.

## 5. Validation

| Check | Result |
| --- | --- |
| `actionlint` 1.7.12 on `.github/workflows/*.yml`, `shellcheck` 0.11.0 on `.github/scripts/*.sh` | clean |
| `npm run lint` | clean |
| `python3 -I -B -m unittest discover -s .github/scripts -p 'test_*.py'` | 78 tests, 1 skipped (the optional Bun test) |
| `npm run test:node` | 14 files, 170 tests (new: `browser-matrix-shards.test.cjs`, 15 tests) |
| `node scripts/browser-matrix.js --engines=chromium --shard=1/3 --specs=embed,url,gesture` | PASS, 6 cases (gesture belongs to shard 3 and did not run) |
| PR #62 CI | every check green: `test`, `lint`, `build-verify`, `browser-smoke`, all nine `browser (ENGINE, K/3)` jobs, three `demos` jobs, `browser matrix`, both review gates |

The merge validation covered a pass, a dropped shard, a failed case, a duplicate spec, no results, an engine that did not launch, an unreadable file, an undeclared engine and a missing directory.

## 6. Settings the user may change

None are needed. Optional: require `browser matrix` in the `protect main` ruleset; use an App token for the rebuild commit (section 4).

## 7. Review rounds

Round 1: Claude `lgtm`. Codex LOW: `retryable_output` accepted a `Review incomplete:` declaration that follows a preamble, contradicting the documented rule. Fixed (any line starting with `Review incomplete` makes the output final), with two regression cases.
