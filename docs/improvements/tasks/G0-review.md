# G0 initial CI gate: independent review

| Item | Value |
| --- | --- |
| Reviewer task | G0 independent review of the integrated T1 candidate (#5, #15, #16 initial scope, #22, #23, #24, #25) |
| Candidate | `g0/candidate` at `1eff7bae074918e2d278f3a932f0803e9921191e` = `improve/integration` `a841564` + `t1/tooling` `f40de89` + `t1/ai-review` `e9e31e6` |
| Diff reviewed | `a841564..1eff7ba` (50 files) |
| Branch / worktree | `g0/review` in `/workspace/webaudio-tinysynth-worktrees/g0-review` |
| Raw evidence | `/workspace/webaudio-tinysynth-worktrees/_evidence/g0-review/` (`commands.tsv`, `logs/`, `remote/`, `scratch/`) |
| Toolchain and run results | [validation.md, "G0 initial CI gate"](../validation.md) |

I did not write this code. I changed no implementation file. Every breakage below was made in a scratch clone under `_evidence/g0-review/scratch/` and then discarded.

## 1. Verdict

| Issue | Verdict | Reason |
| --- | --- | --- |
| #5 reproducible, verifiable build and CI | **Accept with follow-ups** | Two clean clones and a second build all give `782e9b92…`/`e8c2c34d…`, byte-identical to the committed files. `verify` enforces the build and inline-safety on both the source and min.js. CI detects drift. Pins and the lockfile are correct, and CI passed on ARM. Follow-up: M4, because `test:node` can pass with zero tests. Release hashes and tags are separate release actions. |
| #15 remove node-minify | **Accept** | node-minify is removed. `npm audit` reports 0 findings for the root lock (146 entries) and for the Codex CLI lock. The Babel and notifier subtree is gone. Terser is pinned to exactly 5.51.2. |
| #16, initial scope | **Accept** | CI runs the Chromium offline smoke test for both builds on `ubuntu-24.04-arm` (run 37091311660). A missing browser fails the test. The autoplay-bypass limitation is recorded in the script, the README and the workflow. |
| #22 ESLint | **Accept** | The configuration is a flat `@eslint/js` recommended config with explicit library globals. The lint fixes preserve behavior (§2, "Checked and found correct"). The lint step is a stable CI job. |
| #23 Vitest | **Accept** | The configuration is explicit (Node environment, include pattern, `vitest run`). The tests check public behavior against independent expectations, and my unit-level mutations brk1 and brk6 failed them (§3). A file with no tests, or a test that calls `process.exit`, fails Vitest. |
| #24 native Node tests | **Accept with follow-ups** | The exports, equivalence and runner tests are meaningful. Deadlines kill process groups. A missing upstream reference fails. Follow-up: M4, because a native-test glob that matches nothing, or a test file that calls `process.exit(0)`, passes silently. |
| #25 AI reviews | **Reject at `1eff7ba`** | **H1:** a pull request on a branch of this repository can run its own code with `CLAUDE_CODE_OAUTH_TOKEN`, through Bun's `bunfig.toml` preload or `.env` file in the checkout. I reproduced this with the pinned Bun 1.3.14. **M1:** a Claude transcript with no init message skips the read-only check and can approve. The rest of the design is sound and the real runs behaved as specified (§5). Fixing H1 and M1 (M1 is already fixed on `t1/ai-review` at `848bae6`) and re-reviewing is enough for acceptance with follow-ups M2, M3 and the LOW items. |

Two items must be fixed before the Claude gate is made a required check: **H1** and **M1**. **M4** should land before the CI checks become required.

## 2. Findings

Line numbers refer to the candidate `1eff7ba`.

### H1 [HIGH] `.github/workflows/claude-review.yml:164-172` (`CLAUDE_WORKING_DIR` at :168): Bun runs PR-controlled configuration with the Claude credential

- **Evidence.** The pinned base action (`base-action/action.yml` at `ed670b4`, step `run_claude`) runs `cd "$CLAUDE_WORKING_DIR"`, then `bun run ${GITHUB_ACTION_PATH}/src/index.ts`, with `CLAUDE_CODE_OAUTH_TOKEN` in its environment. The workflow sets `CLAUDE_WORKING_DIR` to the pull request checkout `src/`. I reproduced this with the pinned Bun 1.3.14 (release zip; sha256 `951ee2ae…` matches the release `SHASUMS256.txt`). I ran an absolute-path entry script from a directory that contained `bunfig.toml` with `preload = ["./evil.ts"]` and a `.env` file (`logs/bun-probe-1.log`, files in `logs/bun-probe-files/`):
  - The PR-controlled preload ran first and read the token: `PR-CONTROLLED PRELOAD ran; sees CLAUDE_CODE_OAUTH_TOKEN=yes`.
  - `.env` filled in variables that were not already set (`HTTPS_PROXY`, a marker variable). It did not override a variable that was set but empty (`ANTHROPIC_BASE_URL=""`).
  - The control run from a directory without those files loaded neither (`logs/bun-probe-control.log`).
- **More of the same class, from code reading at `ed670b4` (inferred, not executed).**
  - `run-claude-sdk.ts:279` passes `{...process.env}` to Claude Code, so variables from `.env` reach the CLI.
  - The step does not preset `ANTHROPIC_MODEL`. `index.ts:56` takes it as `options.model`, and `parse-sdk-options.ts` gives it precedence over `--model` from `claude_args` (`model: options.model || modelFromClaudeArgs`). A PR `.env` can therefore replace the centrally configured model. `review.py:377-379` only warns about the mismatch (L3).
  - The step does not preset `CLAUDE_CONFIG_DIR`, `HTTPS_PROXY` or `NODE_EXTRA_CA_CERTS` either. These could move the `user` setting source, which is the one allowed source, to a PR directory, or route traffic through a proxy.
  - This all happens in base-configuration mode too, not only in bootstrap mode, and needs no workflow edit.
  - Code running in that step can also rewrite `trusted/.github/scripts/*` and `$RUNNER_TEMP/claude-execution-output.json` before the "Record the review result" step. The forged `result.json` then reaches the publish and gate jobs as an artifact, so the gate can be made green.
- **Remote evidence.** The real Codex review of `t1/ai-review` at `848bae6` (run 37091989339; that commit does not change this workflow) reported this as HIGH, and its gate failed.
- **Impact.** Anyone who can push a branch to this repository can steal the org-level Claude OAuth token or forge an AI approval with an innocuous-looking file, without changing workflow YAML. #25 says: "Do not execute PR-controlled helper code/install hooks with review credentials".
- **Recommended action.** Do not run the action with its working directory inside the checkout. Point `CLAUDE_WORKING_DIR` at a trusted, empty directory (or leave it unset), give Claude the checkout with `--add-dir`, and update `--expected-cwd` and the prompt. That closes every file Bun or Claude Code loads from the working directory (`bunfig.toml`, `.env*`, any future one) at once. Deleting `bunfig.toml` and `.env*` from `src/` beforehand is weaker: it misses future loaders and changes the reviewed data. Add a regression probe in which a checkout containing a `bunfig.toml` preload and a `.env` cannot execute code or change the environment, and make a model mismatch an error (L3).
- **Codex path, checked for the same class.** With the production arguments and a fresh `CODEX_HOME`, Codex 0.160.0 ignored a PR `.env` (`OPENAI_BASE_URL`) and a PR `.codex/config.toml` (`model`, `openai_base_url`): it used the configured model and `api.openai.com` (`logs/codex-env-probe.log`; fake key, 401 as expected). It also ignored `AGENTS.override.md`, nested `AGENTS.md` and repository skills, which it loads by default (§5.4). The credential-bearing Python steps run trusted scripts (`sys.path[0]` = `trusted/.github/scripts`), and the workspace root holds only `src/` and `trusted/`. No `.npmrc` is in scope: the Codex CLI installs in `$RUNNER_TEMP/codex-cli` from trusted files, in a step with no secrets. Git hooks and drivers are not controlled by the pull request. I found no instance of this class outside bootstrap (M3) and the commands Codex itself runs inside its sandbox (M2).

### M1 [MEDIUM] `.github/scripts/review.py:328-341`: a Claude transcript without an init message skips the cwd and tool-set checks

- **Evidence.** `ai-probes` P1: the execution file `[{"type":"result","subtype":"success","is_error":false,"result":"lgtm"}]` with a successful outcome gives `errors: []`, `status: complete`, `verdict: lgtm`. The control (init message with `Bash`) is rejected. The real Codex review at `e9e31e6` (PR #28) found the same thing.
- **Impact.** A change in the transcript format of the action or SDK could approve without verifying that execution was read-only and ran in the right directory. The verification fails open.
- **Recommended action.** Require exactly one init message carrying `cwd` and `tools`. This is already done on `t1/ai-review` at `848bae6`, which is not in this candidate; take it before the gate becomes required.

### M2 [MEDIUM] Codex can read its credential inside the sandbox, and only a literal-match guard stands between the credential and a public comment

- **Locations.** `.github/workflows/codex-review.yml:221-226` (`auth.json` in `CODEX_HOME`); `.github/scripts/run-codex-review.sh:54-55`; `.github/scripts/review_lib.py:333-340` (guard); `review_lib.py:433-435` (fork message).
- **Evidence.**
  - A read-only sandbox blocks writes and network access, not reads. The real run shows Codex running `/bin/bash -lc` commands in `src/` (job 111112400096). Those commands can also run PR-controlled code inside the sandbox, for example an embedded bare repository with `core.fsmonitor`, or `npm test`.
  - The guard detects only the literal value and its JSON-escaped form. `ai-probes` P3: base64, hex, reversed, space-separated and line-split copies of a token are all missed.
  - The comment, including the "Unvalidated review output" block, is public, because the repository is public.
  - The gate's fork message tells maintainers to "re-open it from a branch in this repository", which sends fork-authored content to the credentialed reviewer.
- **Impact.** A successful prompt injection in reviewed content could publish an encoded org-wide ChatGPT credential. T1 §8 accepts this as a residual risk. The github-ci guidance says a read-only sandbox "does not by itself prevent credential reads or data exfiltration".
- **Recommended action.**
  - Extend the guard to sliding substrings (12 characters or more) of each secret leaf, and to their base64, base32, hex and reversed forms, after removing whitespace.
  - Do not publish unvalidated output from failed runs verbatim.
  - Reword the fork message so that maintainers must review untrusted content before re-pushing it.
  - Evaluate an authentication route that the sandbox cannot read.

### M3 [MEDIUM] `.github/workflows/codex-review.yml:55-62` and `claude-review.yml:55-62`: bootstrap runs PR-head helpers with credentials for any base that lacks the configuration

- **Evidence.** When `base.sha` has no `.github/review-agents.json`, `config_sha` becomes `HEAD_SHA`. `trusted/` then holds the PR's own `review.py`, `review_lib.py` and `run-codex-review.sh`, and they run in the result and run steps alongside `CODEX_AUTH_DOT_JSON` or `CLAUDE_CODE_OAUTH_TOKEN`.
- **Labeling.** Bootstrap is clearly labeled and is never a silent pass: a `::warning`, the step summary, `bootstrap: true` in the result, a BOOTSTRAP notice in the comment, and a gate message all say so (verified in the PR #28 runs and comments).
- **Reachability.** The path stays reachable after G0 for any PR whose base lacks the configuration: `main` until the umbrella PR merges, and any older branch. Every real review run so far has been bootstrap.
- **Impact.** #25 forbids running PR-controlled helper code with review credentials. Under `pull_request` a writer can already edit the YAML (I1), but bootstrap makes this possible without touching any workflow file, so the trusted-configuration guarantee covers only bases that already carry it.
- **Recommended action.** Allow bootstrap only for an explicit allowlist: for example, a repository variable naming the one head SHA allowed to bootstrap, or base `main` until it carries the configuration. Fail every other configuration-less base, and remove the path once `main` has the configuration.

### M4 [MEDIUM] `package.json:31` (`test:node`): the native suite passes when no test runs

- **Evidence.**
  - `brk4-zero-node-tests`: I renamed the three `tests/node/*.test.cjs` files to `*.spec.cjs`, and `npm run test:node` exited 0 with `tests 0`.
  - `x-node-test-empty-glob`: with a glob that matches nothing, the result is also exit 0 with `tests 0`.
  - `x-node-test-exit0`: a test file that calls `process.exit(0)` in its second test exited 0. The later failing test never ran, and the run reported `pass 1`.
  - Vitest, by contrast, fails on no files (`x-vitest-nofiles`, exit 1) and on `process.exit` (`x-vitest-exit0`, exit 1).
  - The CI step "Native Node tests" uses the same command, so it would be green.
- **Impact.** This is a false-pass path in a required suite, which #5 and #24 ask the gate to exclude. It becomes likely during the T7 source split (#17) or any rename.
- **Recommended action.** List the native test files explicitly, or check that the glob is non-empty. Make the runner assert a minimum or exact test count from the summary, or use a reporter that requires every listed file to report its expected tests. Add a regression test for both cases.

### L1 [LOW] `.github/scripts/review_lib.py:29,249-250`: a malformed blocking heading after a valid finding is absorbed as text

- **Evidence.** `ai-probes` P2: a valid `### [LOW] …` finding followed by `### HIGH b.js:2 — remote code execution…`, without fields, parses as `findings` with severities `['LOW']`, and the gate passes. The same happens with `**HIGH** b.js:2 …`. `FINDING_LIKE_RE` only catches bracketed headings. Two deviations are needed (out-of-order severity and a malformed heading). A malformed first finding already fails closed.
- **Recommended action.** Treat any ATX heading outside a fence that is not a valid finding heading as malformed. Add a test.

### L2 [LOW] `codex-review.yml:9`, `claude-review.yml:9`: retargeting a PR, or editing its title or body, does not re-run the review

- **Evidence.** `edited` is not in `types`. Check runs attach to the head SHA, so a gate that was computed for the old base, merge base and configuration stays green after the base changes. The stale check in `evaluate_gate` only compares within one run. Codex (connector, P2) and Claude (848bae6) both reported this.
- **Recommended action.** Add `edited`, filtered to `github.event.changes.base` (and to title and body if intended), without letting unrelated edits cancel a useful run.

### L3 [LOW] `.github/scripts/review.py:377-379`: a model mismatch from Claude is only a warning

- **Evidence.** If the init message reports a model other than `CLAUDE_REVIEW_MODEL`, the result step emits a `::warning`, and the review still counts as complete. Together with H1, PR content could change the model with only a warning. Codex, by contrast, fails on a header mismatch.
- **Recommended action.** Fail unless the reported model equals the configured value, or a documented alias of it.

### L4 [LOW] `.github/scripts/review_lib.py:396-400`: in bootstrap comments the BOOTSTRAP notice comes before the D-012 heading

- **Evidence.** D-012 says that every review comment "starts with a visible heading". In bootstrap mode the first visible line is the BOOTSTRAP blockquote (`ai-probes` P5, and both live PR #28 comments). The heading format itself matches D-012: `**Claude review** · model `claude-opus-5-5` · effort `medium` · head `e9e31e6b7f4a``.
- **Recommended action.** Render the heading first and the notice second, or record the deviation in D-012.

### L5 [LOW] `.github/workflows/codex-review.yml:196`: the network-refusal preflight cannot tell refusal from any other curl failure

- **Evidence.** `2>/dev/null` and a bare exit-status test treat DNS, TLS or timeout failures as refusals. The step passed in runs 37090657860, 37091416897 and 37091989339, but the logs show no reason.
- **Recommended action.** Probe a listener on the runner that is reachable outside the sandbox, compare its result with an unsandboxed control, and log curl's exit code.

### L6 [LOW] `.github/dependabot.yml` together with both review workflows: Dependabot PRs will fail the AI gates

- **Evidence (inferred from GitHub's documented secret isolation; not observed).** Dependabot-triggered `pull_request` runs receive only Dependabot secrets. Dependabot PR heads are in this repository, so `policy=review`, the credential check fails, and both gates fail. The Dependabot configuration that this candidate adds will produce such PRs monthly. The outcome is fail-closed, but no policy for bot PRs is defined.
- **Recommended action.** Define the policy: provision Dependabot secrets, or give a clear gate message and a documented manual path.

### L7 [LOW] `.github/workflows/review-helpers.yml:52`: CI lints only `*review*.yml` with actionlint

- **Evidence.** `ci.yml` is not linted in any workflow. Locally, actionlint 1.7.12 on all four workflows exits 0, and shellcheck 0.11.0 exits 0.
- **Recommended action.** Lint `.github/workflows/*.yml`.

### I1 [informational] `pull_request` executes the PR's workflow YAML and action pins

This comes with the event (T1 §8, D-009): a writer can change the YAML that holds the secrets, and a fork can change a gate job to spoof `Codex review gate` or `Claude review gate`, with no secrets. It does not escalate beyond write access, but it bounds what the trusted-configuration design can promise. Consider CODEOWNERS plus a ruleset requiring review of `.github/**`, or a `workflow_run` split for the credentialed half, and keep approval required for fork workflows.

### Checked and found correct (no finding)

- **Library lint fixes (`webaudio-tinysynth.js`).**
  - `len = Delta(...)` reuses `Msg`'s own hoisted `var len`, not `loadMIDI`'s.
  - `var idx;` is assigned before use.
  - Dropping the unused `xhr.onload` parameter is safe.
  - Empty catches gain comments only.
  - The inline disables are narrow.
  - Differential, tempo and loop-end regressions pass against the upstream reference.
- **Minification.**
  - Locals are mangled. `properties: false`, `toplevel: false`, `keep_classnames: true`.
  - Observer names (`"setMasterVol"`, …) and every property keep their names. Only the internal `WebAudioTinySynthCore` function is renamed (`e`), and nothing reads its name.
  - The license header is kept. There is no `sourceMappingURL`.
  - The `(function(window){…})(this)` wrapper and the CommonJS, AMD and global branches survive (checked in min.js). There is no `"type": "module"`.
  - The README line "renames local variables only" is slightly loose (it also renames internal function names); this is not a defect.
- **Inline embedding.** `verify` checks both the source and min.js. The breakage `brk5` (`<!--` in a source comment) failed `verify` even though min.js was clean.
- **Disjoint discovery.**
  - Vitest uses `tests/unit/**/*.test.mjs`. `node:test` uses `tests/node/**/*.test.cjs`, and its fixtures are `*.cjs`, not `*.test.cjs`.
  - The regressions are an explicit list in `scripts/run-regressions.js`, and the browser test is an explicit script.
  - Vitest loads the harness through `createRequire` and never imports the regression scripts.
- **Missing upstream reference.** In a `--depth 1` clone, `test:node` exits 1 (the reference test fails) and `test:regression` exits 1 (0 of 3 passed).
- **CI workflow.**
  - Every action is pinned to a full SHA that matches its official release tag (§5.3).
  - `permissions: contents: read`; `persist-credentials: false` everywhere.
  - Concurrency is per workflow and PR or ref, and cancels superseded runs only for PRs.
  - Timeouts are 10, 10, 20 and 20 minutes.
  - The npm cache is keyed on `package-lock.json` (cache saved in run 37091311660).
  - `fetch-depth: 0` (needed only by `test`; harmless elsewhere).
  - Triggers are `pull_request`, `push` to `main` and `workflow_dispatch`. Job names are stable.
  - `test` and `browser-smoke` rebuild and diff the distribution before testing it.
- **Gate outcomes** (helper unit tests plus probes).
  - Missing or invalid variables, failed steps, partial `lgtm` after a failure, malformed output, unknown severity, a stale head at publish (live head check, `review.py:491-495`), duplicate results, missing results and a fork PR all fail.
  - A draft PR passes as a stated intentional skip (D-009). No-changes passes only when Git and GitHub both report an empty change set.
  - The gate job is `if: always()` and never skipped. A failed `prepare` fails it explicitly.
- **Comment upsert.** Ownership requires `github-actions[bot]` with type `Bot` and a first line exactly equal to the marker. The live PR #28 has exactly one bot comment per provider, updated in place across three runs.
- **Model and effort.**
  - Each value comes only from `${{ vars.* }}`; there are no literals in YAML, prompts or helpers.
  - `accepted_effort_levels` is justified. The pinned CLI's help (`claude-2.1.288-help.txt:84-85`) lists exactly `low, medium, high, xhigh, max`, and T1 observed that an unknown value is ignored with only a warning.
  - Codex has no vocabulary list. Instead the CLI header is compared with the configured values.

## 3. Test meaningfulness (#23, #24)

The unit tests drive only public API (`send`, `setTimbre`, `loadMIDI`, `playMIDI`, `getPlayStatus`, `setQuality`). They read the WebAudio calls the synth makes, and they derive expectations independently: `440·2^((n−69)/12)·t+f`, a tick-to-seconds tempo map, and README facts (drum map 35–81, one oscillator per note in quality 0). Comparing the velocity-0 trace with the note-off trace is relational, but it is anchored by an absolute release-time assertion.

The native tests check loading paths (global, CommonJS, AMD, `require`), the documented methods and defaults, detached calls, and min.js-versus-source equivalence on a generated song with a seek. The equivalence test reads internals (`notetab`, `_note` captures), but only to compare the two builds, which is what #24 asks.

Weak spots that are not defects: the quality-1 oscillator count only checks program 0, and `setQuality()` reinstallation only checks the absence of the custom timbre.

My own mutations (different from the implementers'):

| Experiment | Change (scratch clone `clone-c`) | Result |
| --- | --- | --- |
| brk1: wrong program selection | `send` 0xC0 → `setProgram(0, …)` | `test:unit` exit 1: 4 failures, "a program change applies to its own channel only", both builds and both quality modes |
| brk2: broken AMD export | `define.amd` → `define.AMD`, rebuilt | `test:node` exit 1 (2 failures, AMD case for both builds). `pack:check` still exits 0, because it only tests CommonJS (expected) |
| brk3: unsafe mangling | `keep_classnames: false`, rebuilt | `test:node` exit 1 (4 failures, `'s'` ≠ `'WebAudioTinySynth'`); `pack:check` exit 1 |
| brk4: zero native tests | `tests/node/*.test.cjs` → `*.spec.cjs` | **`test:node` exit 0 with `tests 0`** (M4) |
| brk5: inline-unsafe source comment | `// <!--` in the source, rebuilt (min.js clean) | `verify` exit 1: "webaudio-tinysynth.js is not safe to inline … `<!--` at byte 398" |
| brk6: mid-song tempo change ignored | `tick2Time` uses a fixed 120 BPM on 0xFF51 | `test:unit` exit 1: fractional tempo map, `expected 0.24999999999999997 to be close to 0.2275` |
| AI P1: no init message | probe of `claude_execution` | complete `lgtm`, no errors (M1) |
| AI P2: malformed HIGH after a LOW | probe of `parse_review` and `evaluate_gate` | the gate passes with one advisory finding (L1) |
| AI P3: encoded credential | probe of `contains_credential` | only the literal form is detected (M2) |
| Bun cwd configuration | Bun 1.3.14, `bunfig.toml` preload + `.env` | the preload ran with the token; `.env` filled unset variables (H1) |

## 4. Checks run (exit codes)

Full list with durations: `_evidence/g0-review/commands.tsv`. Logs: `_evidence/g0-review/logs/<label>.log`.

| Check | Where | Exit |
| --- | --- | ---: |
| `npm ci` | clean clone A at `1eff7ba` | 0 |
| `npm run lint` | A | 0 |
| `npm run verify` (on the committed artifacts, before any build) | A | 0 |
| `npm run build`, then `git diff --exit-code` on min.js and map | A | 0, 0 |
| `npm run verify` (after the build) | A | 0 |
| `npm run pack:check` | A | 0 |
| `npm run size` | A | 0 |
| `npm run test:unit` (30 tests) | A | 0 |
| `npm run test:node` (24 tests, 5 suites) | A | 0 |
| `npm run test:regression` (3 of 3) | A | 0 |
| `npm run test:browser` (36 of 36 checks: 2 builds × 2 fixtures × 9) | A | 0 |
| `npm test` | A | 0 |
| `python3 -m unittest discover -s .github/scripts -p 'test_*.py'` (52 tests) | A | 0 |
| `npm ci`; delete the distribution; `npm run build` | clean clone B | 0, 0 |
| `node scripts/build.js <dir>` (second build) | A | 0 |
| byte comparison: A, B, second build and the committed files (min.js and map) | | identical |
| `npm audit` (root), `npm audit --package-lock-only` (Codex CLI lock) | A | 0, 0 (0 vulnerabilities) |
| `npm pack --dry-run` (7 files, 46.4 kB) | A | 0 |
| `test:node`, `test:regression` in a `--depth 1` clone (missing upstream reference) | shallow | 1, 1 (expected) |
| actionlint 1.7.12 on all workflows; shellcheck 0.11.0 on `.github/scripts/*.sh` | worktree | 0, 0 |
| Codex 0.160.0 `debug prompt-input`, default vs production flags | probe repo | 0, 0 |
| Codex 0.160.0 `exec` with production flags, PR `.env` + `.codex/config.toml` | probe repo | 1 (401 from `api.openai.com` with the configured model, as expected) |
| Bun 1.3.14 preload / `.env` probe | probe dir | 0 (preload executed) |
| Breakages brk1–brk6 and AI probes P1–P5 | `clone-c`, `ai-probes` | see §3 |
| Action pin and release check (`gh api …/git/ref/tags`, `…/releases/tags`) | GitHub | all match (§5.3) |

## 5. Remote evidence (read-only)

### 5.1 Runs

| Run | Workflow | Head | Conclusion | Notes |
| --- | --- | --- | --- | --- |
| 37091100129 | CI | `t1/tooling` `c76bb81` | success | |
| 37091311660 | CI | `t1/tooling` `f40de89` | success | `ubuntu-24.04-arm` image 20260927.135.1; Node 24.21.0 arm64 from the tool cache; npm cache saved; verify PASS with `782e9b92…`; 30 unit, 24 native, 3 of 3 regressions; smoke 9 of 9 for each build and fixture |
| 37090657860 / 37090657871 / 37090657872 | Codex / Claude / helpers | `t1/ai-review` `1f17527` | success ×3 | bootstrap |
| 37091416897 | Codex Review | `e9e31e6` | success | header `model: gpt-6.1-sol`, `reasoning effort: high`; sandbox preflight passed; one MEDIUM finding (M1) |
| 37091416840 | Claude Review | `e9e31e6` | success | `INPUT_CLAUDE_ARGS` carries `--model claude-opus-5-5 --effort medium … --setting-sources user …`; SDK options `"settingSources": ["user"]`; init model `claude-opus-5-5`; one MEDIUM finding (Codex credential lifetime) |
| 37091416786 | Review Helpers | `e9e31e6` | success | |
| 37091989339 | Codex Review | `848bae6` (after the candidate) | **failure** | blocking HIGH = H1 |
| 37091989349 | Claude Review | `848bae6` | **failure** | output "text outside findings at line 1" → incomplete; the gate failed closed |
| 37091989341 | Review Helpers | `848bae6` | success | |

No run has exercised the integrated tree `1eff7ba`. CI has run only on `t1/tooling`, and the reviews only on `t1/ai-review`. PR #28's base at those runs was `7e863b7`, an ancestor of `a841564`.

### 5.2 Secrets and logs

- Secrets appear only as `***`. GitHub masks each line of the multi-line `CODEX_AUTH_DOT_JSON`, so every `{` and `}` in the Codex logs is masked; this is cosmetic.
- The Codex log is printed only after the guard check.
- The base action strips `extraArgs` from its log, so the arrival of `--effort` at the CLI is verified from code, not from the log.
- The repository tracks no `AGENTS.md` or `CLAUDE.md`, so the real runs cannot show instruction-file suppression. §5.4 is the independent evidence.

### 5.3 Action pins

Each pinned SHA equals the commit of its official release tag (`gh api`):

- `actions/checkout` v7.0.1 `3d3c42e5…`
- `actions/setup-node` v7.0.0 `82076278…`
- `actions/upload-artifact` v7.0.1 `043fb46d…`
- `actions/download-artifact` v8.0.1 `3e5f45b2…`
- `anthropics/claude-code-action` v1.0.240: annotated tag `c2f4d169…` → commit `ed670b4c…`

All are non-draft, non-prerelease releases and the latest of their lines. The actionlint arm64 checksum in `review-helpers.yml` matches the release `checksums.txt`. The Codex CLI lock integrity equals `npm view @openai/codex@0.160.0 dist.integrity`.

### 5.4 Instruction loading (independent probe)

Probe repository: `AGENTS.md`, `AGENTS.override.md`, `sub/AGENTS.md` and `.agents/skills/evil/SKILL.md`, each carrying a marker.

- Codex 0.160.0 `debug prompt-input` with a fresh `CODEX_HOME` included the override and skill markers.
- With `-c project_doc_max_bytes=0 -c skills.include_instructions=false`, which `review_lib.codex_argv` emits, it included none, from both the root and `sub/`.

## 6. Limitations

- No real run of the integrated candidate. The first PR whose base contains the configuration will also be the first remote exercise of the base-configuration (non-bootstrap) path.
- I verified Claude-side instruction suppression and effort delivery only from the real run's SDK options, the action source and T1's local captures. I did not run Claude Code myself.
- I did not observe Dependabot (L6) or artifact re-run behavior (re-running a job that already uploaded `codex-review-*` may conflict, because `overwrite` is false). The Codex ChatGPT-credential refresh and rotation risk reported by the Claude review at `e9e31e6` cannot be verified offline. It fails closed, and `848bae6` adds an explicit message for it.
- The gates are not required checks. That needs a ruleset change, which D-002 withholds.
- Local runs are x86_64. The ARM facts come from run 37091311660.
- The first eight rows of `commands.tsv` have duration 0.0 because of a bug in my runner script, fixed after those rows. Their exit codes are valid.
