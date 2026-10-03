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
