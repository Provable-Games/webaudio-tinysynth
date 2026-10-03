# Validation records

## G0 initial CI gate

Independent reviewer validation of candidate `g0/candidate` `1eff7bae074918e2d278f3a932f0803e9921191e`. Findings and verdicts are in [tasks/G0-review.md](tasks/G0-review.md). Raw logs are in `/workspace/webaudio-tinysynth-worktrees/_evidence/g0-review/`: `commands.tsv` has every command with its exit status, `logs/` the outputs, `remote/` the downloaded Actions logs and PR #28 comments, and `scratch/` the clean clones and probes.

### Toolchain (local)

| Tool | Version | Source |
| --- | --- | --- |
| Host | Ubuntu 24.04.2 LTS, x86_64 | |
| Node / npm | 24.21.0 / 11.19.0 | nodejs.org tarball in `_evidence/t1-tooling/tools`; sha256 `fd8e59d5…` matches the live `nodejs.org/dist/v24.21.0/SHASUMS256.txt` |
| Terser, ESLint, Vitest, playwright-core | 5.51.2, 10.12.0, 5.0.3, 1.63.0 | `npm ci` from the committed lockfile |
| Chromium headless shell | revision 1243 (153.0.8010.12) | `_evidence/t1-tooling/ms-playwright`, with T0's extracted libraries |
| Python, git, GNU gzip | 3.12.3, 2.43.0, 1.12 | system |
| actionlint, shellcheck | 1.7.12 (checksum matches the release), 0.11.0 | `_evidence/t1-tooling/tools` |
| Codex CLI | 0.160.0 | `npm ci --ignore-scripts` of `.github/scripts/codex-cli` into scratch, probes only |
| Bun | 1.3.14 | release zip, sha256 `951ee2ae…` matches the release `SHASUMS256.txt`, probe only |

Nothing was installed system-wide.

### Commands and results

| Command | Result |
| --- | --- |
| Clean clone A at `1eff7ba`: `npm ci`, `lint`, `verify` (before building), `build` + `git diff --exit-code`, `verify`, `pack:check`, `size` | all exit 0 |
| `test:unit` / `test:node` / `test:regression` / `test:browser` / `npm test` | exit 0: 30 Vitest tests; 24 `node:test` tests in 5 suites; 3 of 3 regressions; 36 of 36 smoke checks (2 builds × 2 fixtures × 9); `npm test` 62.8 s |
| Helper unit tests (`python3 -m unittest discover -s .github/scripts -p 'test_*.py'`) | 52 tests OK, exit 0 |
| Clean clone B: `npm ci`, delete the distribution, `npm run build`; a second build of A into a separate directory | min.js and map byte-identical across A, B, the second build and the commit |
| `npm audit` (root lock), `npm audit --package-lock-only` (Codex CLI lock) | 0 vulnerabilities, exit 0 |
| `npm pack --dry-run` | 7 files (`LICENSE`, `NOTICE`, `README.md`, `package.json`, source, min.js, map), 46.4 kB packed, 186.0 kB unpacked |
| `--depth 1` clone: `test:node`, `test:regression` | exit 1, 1: the missing upstream reference fails, as required |
| actionlint on all four workflows; shellcheck on `.github/scripts/*.sh` | exit 0, 0 |
| Breakages and probes | see G0-review §3 and §4; M4 (`test:node` passes with zero tests) and H1 (Bun cwd configuration) reproduced |

### Artifact identity and size against T0

gzip is GNU `gzip -9 -n`, as in T0.

| File | T0 baseline (bytes / gzip / sha256) | Candidate (bytes / gzip / sha256) | Change |
| --- | --- | --- | --- |
| `webaudio-tinysynth.min.js` | 37,060 / 9,444 / `5aa3edbc13371694…` | **36,372 / 9,422 / `782e9b92a8f26f383fc0f8830a6a1e5d4e7dce2d0ab23bf29ab48e06814301b2`** | −688 raw (−1.86 %), −22 gzip (−0.23 %) |
| `webaudio-tinysynth.min.js.map` | 59,637 / 11,423 / `fd7f64190db21526…` | 59,671 / 11,478 / `e8c2c34dc27bf51611d932f6521b77092a4ff1636f2e10fb0a42dc846cc8f62d` | +34 raw |
| `webaudio-tinysynth.js` | 54,000 / 11,765 / `abb2d0fb828ada86…` | 54,398 / 11,944 / `ae367b90699b51b2fc88e7e63e4b64201bed88b65a943767af779a3d88935e3f` | +398 raw (lint comments) |

- The min.js hash equals the value recorded in T1-tooling (`782e9b92…`) and the hash CI printed on ARM in run 37091311660.
- There is no growth that would need supervisor review (the threshold is 5 %).
- The hash changes from T0's `5aa3edbc…`, which affects ledger L-13; the consumer's pin must follow at release.
- The minified file starts with the license header, has no `sourceMappingURL`, and contains no `</script`, `<script`, `<!--` or non-ASCII byte.

### Remote runs (read-only)

| Run | Workflow | Head | Conclusion |
| --- | --- | --- | --- |
| 37091100129 | CI | `t1/tooling` `c76bb81` | success |
| 37091311660 | CI | `t1/tooling` `f40de89` | success (lint, build-verify, test and browser-smoke on `ubuntu-24.04-arm`, Node 24.21.0 arm64) |
| 37090657860, 37090657871, 37090657872 | Codex, Claude, Review Helpers | `t1/ai-review` `1f17527` | success, success, success (bootstrap) |
| 37091416897, 37091416840, 37091416786 | Codex, Claude, Review Helpers | `t1/ai-review` `e9e31e6` (in the candidate) | success, success, success (bootstrap; one MEDIUM each) |
| 37091989339, 37091989349, 37091989341 | Codex, Claude, Review Helpers | `t1/ai-review` `848bae6` (after the candidate) | **failure** (blocking HIGH = H1), **failure** (incomplete output, failed closed), success |

What the real review runs at `e9e31e6` showed:

- **Configured model and effort.**
  - Codex printed `model: gpt-6.1-sol` and `reasoning effort: high`, and the result step requires both to match the variables.
  - Claude's `INPUT_CLAUDE_ARGS` carried `--model claude-opus-5-5 --effort medium --restricted --setting-sources user --strict-mcp-config --permission-mode dontAsk --tools Read,Glob,Grep`. The SDK options showed `"settingSources": ["user"]`, and the init message reported model `claude-opus-5-5`.
- **Preflight and checkout.** The Codex sandbox preflight passed. The PR head was checked out with `persist-credentials: false`.
- **Secrets.** No secret material appeared in the logs (secrets masked as `***`).
- **Comments.** Each provider had one bot comment, updated in place, carrying the D-012 heading and the BOOTSTRAP notice.

### Limitations and pending remote facts

- **No remote run of the integrated tree `1eff7ba`.** CI ran only on `t1/tooling`, and the review workflows only on `t1/ai-review`.
- **Base-configuration path never run remotely.** Every real review was bootstrap, so the first PR into a base that carries the configuration is the first remote exercise of that path.
- **#25 is rejected at this candidate.** H1 is confirmed. M1 is fixed on `848bae6`, which is not in the candidate. A re-run after the implementer's fix is needed: the Claude review at `848bae6` was incomplete, and the Codex gate failed on H1.
- **Claude effort delivery is verified only from code.** `--effort` reaches the action input, but the action strips `extraArgs` from its log.
- **Instruction-file suppression cannot be observed in the real runs**, because the repository has no `AGENTS.md` or `CLAUDE.md`. My Codex `prompt-input` probe and T1's Claude API captures are the evidence.
- **The network-refusal preflight passes without logging a reason** (L5).
- **Not exercised:**
  - Dependabot PR behavior (L6) and artifact re-runs.
  - Codex ChatGPT-credential rotation over time.
  - Windows checkouts.
  - Normal user-gesture audio startup (#16 later scope, T6).
- **The gates are not required checks.** The ruleset change needs user authorization (D-002).
- **Release items are not done.** README release hashes and tags (#5) are release-time actions.
- **Local runs are x86_64.** The ARM results come from run 37091311660 only.
- **`commands.tsv` durations.** Its first eight rows show a duration of 0.0 because of a bug in my runner script. Their exit codes are valid.

### Candidate 2 (`5cdeb49`)

Re-review of `g0/candidate2` `5cdeb498496027505f88f35001206e6fbcc93b7f`. Findings and verdicts are in [tasks/G0-review.md, "Candidate 2"](tasks/G0-review.md#candidate-2-5cdeb49). Logs: `_evidence/g0-review/logs/c2-*`.

**Toolchain.** As above, plus Claude Code 2.1.288, the pinned version, already present in `~/.local/share/claude/versions`. It ran with an isolated `HOME` and `CLAUDE_CONFIG_DIR` against a local API stub, with a fake credential and no network.

| Command | Result |
| --- | --- |
| Two clean clones at `5cdeb49`: `npm ci`, `lint`, `verify`, `build` (twice, with the distribution deleted in clone B), `git diff --exit-code`, `pack:check`, `npm audit` | all exit 0; 0 vulnerabilities |
| `test:unit`, `test:node`, `test:regression`, `test:browser`, `npm test` | exit 0: unit 3 files / 30 tests (floor 30), node 3 files / 33 tests (floor 33), regressions 3 of 3, smoke 2 of 2 |
| Helper unit tests (`python3 -I -B`); opt-in Bun test with the pinned Bun 1.3.14 | 69 OK (1 opt-in skipped); the Bun test OK |
| actionlint on all workflows; shellcheck | 0, 0 |
| Bun probe in the runner layout; Claude read-scope probes (Read, Grep, Glob, `/proc/self/environ`) | nothing loaded from the checkout or the parents of the working directory; every read outside the working and added directories refused |
| False-pass attempts | all failed closed except a renamed-fixture case in `tests/differential.js` (C2-L2, exit 0 with 1 file compared) |

**Artifact identity.** Unchanged from candidate 1:

| File | Bytes | gzip -9 -n | sha256 |
| --- | --- | --- | --- |
| `webaudio-tinysynth.min.js` | 36,372 | 9,422 | `782e9b92a8f26f383fc0f8830a6a1e5d4e7dce2d0ab23bf29ab48e06814301b2` |
| `webaudio-tinysynth.min.js.map` | — | — | `e8c2c34d…` |

Against T0 (37,060 / 9,444, `5aa3edbc…`), min.js is −688 bytes raw and −22 bytes gzip. The library source, the build configuration and the distribution are byte-unchanged since `1eff7ba`.

**Remote runs.**

| Run | Workflow | Head | Conclusion |
| --- | --- | --- | --- |
| 37093471789 | CI | `8a127dd` | success on `ubuntu-24.04-arm` |
| 37093930879, 37093930887 | Codex, Claude Review | `d5b9d95` | failure by design: bootstrap refused for base `improve/integration`, as M3 requires |
| 37093930878 | Review Helpers | `d5b9d95` | success |

**Limitations (candidate 2).**
- **No remote run of the integrated tree.** None of these has run remotely:
  - the trusted (non-bootstrap) review path;
  - the empty Claude working directory with the environment presets and the fingerprint check;
  - the new Codex network control probe on ARM;
  - an `edited` event, including the rendered name of a skipped gate.

  The supervisor will verify these after integration.
- **Claude probes were local.** They used the pinned CLI directly with the production arguments, not the base action's SDK path. On that CLI path, the configured effort now has independent evidence: requests carried `output_config.effort: "medium"` (`logs/c2-effort-probe.log`). Delivery through the SDK remains verified from code only.
- **Unchanged limitations.** The gates are still not required checks (D-002), and the local host is x86_64.

### Final remote verification (`f01ca19`, PR #30)

Details: [tasks/G0-review.md, "Final remote verification"](tasks/G0-review.md#final-remote-verification-improveintegration-f01ca19-pr-30). Logs: `_evidence/g0-review/final/`.

| Run | Workflow | Head | Event | Conclusion |
| --- | --- | --- | --- | --- |
| 37095012463 | CI | `4fd9218` (base `f01ca19`) | pull_request | success: lint, build-verify (`782e9b92…`), test (30/30, 33/33, 3/3), browser-smoke (2/2) on `ubuntu-24.04-arm` |
| 37095012467 | Review Helpers | `4fd9218` | pull_request | success |
| 37095012532 | Claude Review | `4fd9218` | pull_request | success: trusted base configuration (`bootstrap=false`), empty working directory, presets, fingerprint verified, `lgtm` |
| 37095012496 | Codex Review | `4fd9218` | pull_request | success: trusted base configuration; network probe "unsandboxed curl exit 0, sandboxed curl exit 6"; `lgtm` |
| 37095314202 | Claude Review | `4fd9218` | pull_request (title-only edit) | skipped; the skipped gate is named by the raw expression; `Claude review gate` keeps its earlier `success` |
| 37095314174 | Codex Review | `4fd9218` | pull_request (title-only edit) | skipped; same, for `Codex review gate` |

**Secrets.** Only masked values (`***`) appear. A token-pattern scan of all final run and job logs found 0 matches.

**Local re-check at `f01ca19`.**
- `npm ci`, `verify` and `test:regression`: exit 0.
- Helper tests: 71 OK (1 opt-in skipped).
- C2-L2 breakage (one fixture renamed): now exit 1.
- C2-L1 probes: now `incomplete`, and the gate fails.

**Artifact.** `webaudio-tinysynth.min.js` is 36,372 bytes / 9,422 gzip, sha256 `782e9b92a8f26f383fc0f8830a6a1e5d4e7dce2d0ab23bf29ab48e06814301b2`. Against T0 (37,060 / 9,444, `5aa3edbc…`) that is −688 bytes raw and −22 bytes gzip.

**Remaining limitations after G0.**
- **Base-change retarget not exercised live.** A real `edited` event with `changes.base` has not run, so the full re-review against a new base is verified from the workflow text and helper tests only.
- **No live cancellation test.** The title edit happened after the reviews finished, so the guarantee that a metadata edit cannot cancel a running review rests on the separate `-metadata` concurrency group in the workflow text.
- **Dependabot not exercised.** No Dependabot PR has run; the explicit gate failure is covered by helper tests only.
- **Codex token rotation not tested.** Expiry or rotation of the ChatGPT-mode credential over time is untested. A failure is fail-closed, with an actionable message.
- **Gates not required.** `Codex review gate`, `Claude review gate` and the CI jobs are not required checks yet. That ruleset change needs user authorization (D-002); until then a red gate does not block merging.
- **M2 residual (accepted).** Codex's read-only sandbox can read `auth.json`. The output guard covers literal, escaped, reversed, hex and base64 forms, but not partial, base32 or split copies.
- **Lightweight trusted-path review.** The trusted-path review was of a records-only diff (2 files). No trusted-path run has yet reviewed a code change.

## T6 browser and audio validation

Phase A of T6 on `t6/validation` (base `25d2a3d`). Record: [tasks/T6.md](tasks/T6.md). Raw logs, `results.json` files and WAV renders are in `/workspace/webaudio-tinysynth-worktrees/_evidence/t6-validation/`.

### Declared matrix

`tests/browser/matrix.js`: Chromium, Firefox and WebKit × the source and minified builds × quality 0 and 1 × 44.1 and 48 kHz, Math.random seed `0x5eed0001` in the test pages only. A browser that cannot launch fails the run. Assert specs: `embed`, `render`, `gesture`, `url`, `lifecycle`. Observe specs: `hang`, `variation`. Every case has a Node-side deadline, and every engine runs in a worker under `run-with-deadline.js`.

### Local results (linux-x64, Playwright 1.63.0)

| Command | Result |
| --- | --- |
| `npm run test:browser:matrix` | PASS: 42 cases, 1,590 checks; Chromium 153.0.8010.12, Firefox 155.0 and WebKit 26.6 each pass 530 of 530; the cross-engine comparison passes (after the review round) |
| `npm run test:browser:observe` | PASS: 39 cases (hangs detected and recovered; variation evidence) |
| `npm run lint`, `npm test`, `npm run test:browser`, `npm run verify` | exit 0 |
| actionlint 1.7.12 with shellcheck 0.11.0 on `browser-matrix.yml` | exit 0 |
| Failure demonstrations | an empty browser path, and a path without WebKit, both exit 1 ("NOT LAUNCHED"); a mutant source with a +3.93-cent pitch error, and one with `releaseRatio` 2.5, both exit 1 |

### Rendered-audio contract (measured)

- Pitch is within 0.0065 cents of 12-TET in every engine (tolerance 0.05). RPN, Universal and GS tuning, bend, vibrato, CC7, CC11, pan, the envelope, the sustain pedal, drum length, silence and reverb are all within the tolerances in `tests/browser/tolerances.js`.
- The DynamicsCompressor adds 6.0 ms of latency in all three engines.
- Generated buffers are deterministic data: the same seed and sample rate give identical hashes in every engine.
- Same-engine renders are bit-identical in Firefox. In Chromium they differ by up to 5.45e-5 because input summation order varies (engine behavior). In WebKit they differ by up to 9.3e-8 in percussion renders.
- Across engines, at the default master volume, Firefox's compressor makes loud drums up to 5.5 dB quieter.

### CI and review (PR #33)

- **arm64 CI.** The first Browser matrix run (37101462236, `e8f1d7c`) passed on `ubuntu-24.04-arm` for Chromium, Firefox and WebKit. Its same-engine differences fit the declared tolerances.
- **Review fixes.** The six Codex findings were accepted and fixed, each with an old-versus-fixed demonstration ([tasks/T6.md §15](tasks/T6.md#15-review-round-1-pr-33)):
  - lifecycle tracking now counts buffer sources;
  - each GM program and drum is rendered alone;
  - the reverb tail needs measured energy;
  - empty `--engines`/`--specs` selections fail;
  - workers get normalized paths;
  - URL readings wait for the page's `loadend`.
- **New baseline finding.** With a 0.3 s note, GM 119 (and 125 in quality 1) are silent: the release cancels the pending attack ramp.
- **Round 2.** Four more Codex findings are fixed:
  - non-finite alternate-seed renders now fail;
  - a slow page setup is no longer reported as a hang;
  - the URL hang case waits for the response;
  - `--seed=0` is kept.
- **WebKit glitches.** Occasional non-reproducible WebKit render differences (up to 0.56; cause not isolated) are reconciled by re-render and recorded, while a reproducible difference still fails ([tasks/T6.md §15](tasks/T6.md#15-review-round-1-pr-33)).

### Pending

- **Manual listening is pending.** The steps are in [tasks/T6.md §12](tasks/T6.md#12-manual-listening). No automated listening is claimed.
