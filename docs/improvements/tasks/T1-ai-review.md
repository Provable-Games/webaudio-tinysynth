# T1 AI review: Codex and Claude review workflows (#25)

| Item | Value |
| --- | --- |
| Task | T1-ai-review: review workflows, helpers, configuration and helper tests for #25 |
| Governing issue | #25, updatedAt 2026-10-03T00:44:05Z, sha256(body)[:16] `3e13f34c17fb3f73`, no comments (rechecked live at completion) |
| Base | `1e6184c37c0d2cdb8b493d59718c9c7281787a9e` on `improve/integration` |
| Branch / worktree | `t1/ai-review` in `/workspace/webaudio-tinysynth-worktrees/t1-ai-review` |
| Commits (GPG-signed) | `ef00de2` implementation, `f429489` this record, then a follow-up adding the Claude tool-set check (see `git log`) |
| Large evidence | `/workspace/webaudio-tinysynth-worktrees/_evidence/t1-ai-review/` |
| Setup documentation | `.github/scripts/README.md` |

No real provider run has happened. The supervisor pushes the branch and opens
the pull request; section 6 lists what that run must confirm.

## 1. Files

| File | Role |
| --- | --- |
| `.github/review-agents.json` | One `tinysynth` reviewer with scope `"."`, blocking severities `CRITICAL` and `HIGH`, provider variable names, pin locations, and the pinned Claude CLI's accepted effort vocabulary |
| `.github/prompts/review-policy.md` | Shared policy and output contract: exactly `lgtm`, or findings with severity, `file:line`, Evidence/trigger, Impact and Recommended action |
| `.github/prompts/tinysynth-review.md` | Short role prompt, #25's suggested text plus the inline `animation_url` constraint |
| `.github/scripts/review_lib.py`, `review.py` | Configuration and settings validation, change detection, prompt building, result parsing, credential guard, comment rendering, upsert and gate |
| `.github/scripts/run-codex-review.sh` | Runs the pinned Codex CLI with a minimal environment |
| `.github/scripts/codex-cli/package.json`, `package-lock.json` | Codex CLI pin `@openai/codex` 0.160.0 with integrity hashes. The root `.gitignore` matches `package-lock.json`, so the lockfile was added with `git add -f`; once T1 tooling removes that entry, nothing changes. |
| `.github/scripts/test_review.py` | 45 `unittest` tests |
| `.github/scripts/.gitignore` | Ignores `__pycache__/` |
| `.github/workflows/codex-review.yml`, `claude-review.yml` | Jobs `prepare` → `review` (matrix) → `publish` → `gate` per provider |
| `.github/workflows/review-helpers.yml` | Runs the tests, shellcheck and a pinned, checksum-verified actionlint on the review workflows |

No file outside `.github/` and this record changed.

## 2. #25 acceptance criteria

| Criterion | Status | Evidence |
| --- | --- | --- |
| One TinySynth reviewer per provider, shared output policy, whole-repository coverage including docs and workflows | Met | `review-agents.json` (`diff_paths: ["."]`); `PolicyTests.test_change_detection_covers_the_whole_repository_and_renames`; dry run in `_evidence/t1-ai-review/dry-run/` |
| Role and scope centralized in `review-agents.json` and a short role prompt; provider execution separate | Met | prompts contain no provider details; `PromptTests` checks that both providers receive the policy and role exactly once |
| Model and effort only from the four Actions variables; no literals or defaults | Met, with one documented exception | Workflows assign each variable only `${{ vars.NAME }}` and helpers read env (`test_no_defaults_or_vocabulary_outside_central_configuration`). The exception is the Claude effort *vocabulary* in `review-agents.json`, which is required because the pinned CLI silently ignores unknown values (section 4). It is a capability list tied to the pin, not a selected value or a default. |
| Settings passed to each provider's supported controls, verified; nothing silently dropped | Met | Section 4; propagation tests `test_settings_propagate_to_the_codex_command_line` and `..._claude_arguments`; Codex header assertion `test_codex_failures_are_never_complete[effort not applied]` |
| Changing a variable changes execution without file edits; missing settings identified | Met | Propagation tests run two different value pairs per provider; `test_missing_and_invalid_settings_name_the_variable` covers missing, empty and invalid for all four variables |
| Credential names verified, used by name only | Met | `gh api …/actions/organization-secrets` lists `CODEX_AUTH_DOT_JSON` and `CLAUDE_CODE_OAUTH_TOKEN`; `test_least_privilege_and_trust_boundary` allows no other secret |
| opened, synchronize, reopened, ready_for_review; draft, fork and missing-secret behavior; merge-base comparison | Met | Workflow `on:`; `PolicyTests`; README policy table; `test_detection_failure_is_not_an_empty_diff` |
| Read-only execution, final-response capture, per-provider concurrency, bot comment upserts, stale rejection, failures not approvals | Met locally | `ResultTests`, `PublishTests`, `GateTests`; concurrency groups `codex-review-<PR>` and `claude-review-<PR>` |
| Trusted execution and configuration for credential jobs; separate publishing; no PR helpers or hooks with credentials | Met locally | Section 5; `BootstrapTests`; `test_least_privilege_and_trust_boundary`; local trust probes (section 4) |
| Exactly `lgtm` or validated findings; HIGH and CRITICAL fail the gate; MEDIUM and LOW advisory | Met | `OutputContractTests`, `GateTests` |
| Tests: lgtm, each severity, malformed and missing output, partial lgtm after failure, missing settings, fork and draft, stale heads, repeated comment updates, propagation for both providers | Met | `test_review.py` (all named in section 3) |
| Versions from official sources, compatible pins, no `@latest` | Met | Section 4; `test_codex_cli_is_pinned_exactly`, `test_actions_are_pinned_to_commit_shas` |
| Stable check names and required variables and secrets documented | Met | `.github/scripts/README.md` "Checks" and "Configuration" |
| Real authorized Actions run | **Not done** | Requires the supervisor's push; see section 6 |
| Ruleset and credential changes reported separately | Met | Section 7 (recommendations only) |

## 3. Validation

| Command | Result |
| --- | --- |
| `python3 -m unittest discover -s .github/scripts -p 'test_*.py' -v` (Python 3.12.3) | 45 tests OK (`_evidence/t1-ai-review/unittest.log`) |
| `actionlint` 1.7.12 linux_amd64 (sha256 `8aca8db9…` verified against the release `checksums.txt`) on `.github/workflows/*review*.yml`, with shellcheck on PATH | exit 0 |
| `shellcheck` 0.11.0 (asset digest `sha256:8c3be12b…` verified against the GitHub release) on `.github/scripts/*.sh` | exit 0 |
| Mutation checks on a scratch copy: removing fence tracking, the bot identity match, the Claude `--effort` flag, the stale check, the partial-output rule, the fork failure, the Codex header check, the credential guard or the Claude tool-set check | each made the suite fail |
| Local end-to-end with the real pinned CLIs, no credentials (`_evidence/t1-ai-review/local-e2e/`) | Codex 0.160.0 through `run-codex-review.sh`: header `model: fixture-model-xyz` / `reasoning effort: low` parsed; 401 exit recorded as failed. Claude Code 2.1.288 with the generated `claude_args`: init shows the configured model, `cwd` = checkout, `permissionMode: dontAsk`, tools `[Glob, Grep, Read]`; the `is_error: true` result is classified failed |
| Dry run of setup and prompt for this pull request (base `1e6184c` → head `ef00de2`, `_evidence/t1-ai-review/dry-run/`) | Bootstrap selected with a warning; 14 paths; prompts about 7 KB; diff 154 KB in the context directory |

Tests named by #25: lgtm (`test_exact_lgtm_is_a_clean_review`, `test_codex_lgtm_findings_and_identity`); each severity (`test_each_severity_parses_into_a_validated_record`, `test_blocking_severities_fail`, `test_clean_and_advisory_reviews_pass`); malformed and missing output (`test_unknown_severity_and_malformed_findings_are_incomplete`, `test_review_incomplete_and_missing_output`, `test_codex_failures_are_never_complete`); partial lgtm after failure (`test_partial_lgtm_after_execution_failure_is_never_approval`, Codex `partial lgtm after failure`, Claude `is_error with lgtm` using the real 2.1.288 not-logged-in shape); missing settings (`test_missing_and_invalid_settings_name_the_variable`); fork and draft (`test_fork_pull_requests_fail_the_gate_explicitly`, `test_draft_pull_requests_skip_intentionally`); stale heads (`test_stale_head_publishes_nothing`, gate `stale head`); repeated comment updates (`test_repeated_updates_touch_only_the_bot_comment`, `test_duplicate_bot_comments_collapse_to_one`, `test_failed_review_replaces_an_earlier_lgtm`); mixed providers (`test_mixed_providers_one_clean_one_high_fails`); unknown severity and HIGH in a code example (`test_high_inside_a_code_example_is_not_a_finding`); propagation (`test_settings_propagate_to_the_codex_command_line`, `test_settings_propagate_to_the_claude_arguments`); policy template (`test_policy_template_parses_as_a_finding`).

## 4. Pins and verified provider interfaces

| Component | Pin | Official source |
| --- | --- | --- |
| Codex CLI | `@openai/codex` 0.160.0 (npm `latest` dist-tag at 2026-10-03; GitHub release `rust-v0.160.0`, 2026-10-01). Lockfile includes `@openai/codex-linux-arm64` | `npm view @openai/codex dist-tags versions`; https://github.com/openai/codex/releases/tag/rust-v0.160.0 |
| Claude action | `anthropics/claude-code-action/base-action@ed670b4cf9de2a5a570d130d2f6197b9e543cd64 # v1.0.240` (newest versioned release, 2026-10-02; the floating `v1` tag points to the same commit). Installs Claude Code 2.1.288 | `gh api repos/anthropics/claude-code-action/releases`; `base-action/action.yml` and `base-action/src/*.ts` at that SHA |
| `actions/checkout` | `3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1` | releases/latest, `action.yml` (node24) |
| `actions/upload-artifact` | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1` | releases/latest, `action.yml` |
| `actions/download-artifact` | `3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1` | releases/latest, `action.yml` |
| actionlint (CI) | 1.7.12 linux_arm64, sha256 `325e971b…49a3d8` | release `checksums.txt` |

Why the base action: it is the same repository and SHA as the full action, but
it gives Claude no GitHub token, no comment tools and no MCP GitHub server. The
workflow publishes separately.

**Codex 0.160.0** (`codex exec --help`, saved as `codex-0.160.0-exec-help.txt`;
https://learn.chatgpt.com/docs/non-interactive-mode,
https://learn.chatgpt.com/docs/config-file/config-reference,
https://learn.chatgpt.com/docs/sandboxing):

- Model: `-m <MODEL>`. Effort: `-c model_reasoning_effort="<value>"` (TOML; the
  effort format check runs first, so no quoting injection is possible). Read-only:
  `--sandbox read-only`. Final message: `-o <file>`. Prompt from stdin: `-`.
  Also `--ephemeral --ignore-user-config --ignore-rules`.
- The CLI forwards any effort string; locally `reasoning effort: bogus` reached
  the request. The run log header echoes `model:` and `reasoning effort:`, and
  the result step requires both to equal the configured values.
- Trust probe: with a trusted project entry in `CODEX_HOME/config.toml`, a
  checkout's `.codex/config.toml` MCP server command **executed**; with a fresh
  `CODEX_HOME`, it did not. The runner therefore uses a fresh home with only
  `auth.json` and refuses one that contains `*.toml` or `rules`.
- `codex sandbox` exits nonzero when bubblewrap cannot create namespaces (seen
  on this host), so the preflight catches a broken sandbox.

**Claude Code 2.1.288** (`claude --help`, saved as `claude-2.1.288-help.txt`;
https://code.claude.com/docs/en/cli-reference,
https://code.claude.com/docs/en/model-config):

- Model: `--model`. Effort: `--effort` with `low, medium, high, xhigh, max`
  (`ultracode` is a mode, not a level). The base action passes `claude_args`
  through `shell-quote`, maps `--model` to the SDK `model` option and passes the
  rest as CLI flags.
- `claude -p --effort bogus` prints `Warning: Unknown --effort value 'bogus' —
  ignoring it and using the default effort` and continues. The init message has
  no effort field, so an invalid value would be silently dropped. The helper
  therefore validates `CLAUDE_REVIEW_EFFORT` against
  `providers.claude.accepted_effort_levels` before the run. The model docs also
  say an effort that the chosen model does not support falls back to the next
  lower supported level; nothing can observe that offline.
- The base action defaults to loading user, project and local settings and
  forces `enableAllProjectMcpServers`. Probe: without restrictions, a checkout's
  `.claude/settings.json` hooks and `.mcp.json` server **executed** in `-p` mode
  even with no login. With `--restricted --setting-sources user
  --strict-mcp-config --permission-mode dontAsk --tools Read,Glob,Grep`, none ran
  (`local-e2e/trust-probe.txt`).
- The execution file is a JSON array of SDK messages in
  `$RUNNER_TEMP/claude-execution-output.json`. Only a final `type: result` with
  `subtype: success`, `is_error` not true and non-blank `result` counts, together
  with step outcome and `conclusion` success. Locally, when not logged in, the
  CLI emits `subtype: success, is_error: true`; this case is a test fixture.
- The trust probe used the CLI directly, but the action goes through the Agent
  SDK, which rewrites `claude_args`. The result step therefore checks the init
  message from the real run: `cwd` must be `src/`, and `tools` must not contain
  `Bash`, `PowerShell`, `REPL`, `Edit`, `MultiEdit`, `Write`, `NotebookEdit`,
  `WebFetch`, `WebSearch`, `Agent`, `Task` or any `mcp__` tool. It uses a
  denylist because `EndConversation` can survive a `--tools` list.
  `permissionMode` is recorded in the result and comment metadata. The real
  2.1.288 init for the generated arguments (`tools: [Glob, Grep, Read]`,
  `permissionMode: dontAsk`) passes this check.

**Runner.** `ubuntu-24.04-arm` for every job (D-008). The ARM image readme
(`actions/partner-runner-images` `images/Ubuntu2404-Readme.md` at `4ea2a41`)
lists Node 20.20.0, npm 10.8.2, Python 3.12.3, jq 1.7, GitHub CLI 2.86.0, curl
and shellcheck 0.9.0. Codex publishes `linux-arm64`. The Claude installer at
https://claude.ai/install.sh maps `aarch64` to `linux-arm64` (sha256 of the
fetched script `3a68d340…`). The base action pins `oven-sh/setup-bun` and
`actions/setup-node`, both of which support arm64. No x64 exception is needed.

## 5. Trust boundary, bootstrap and gate (summary; details in the README)

- `pull_request` only; `permissions: {}` at the top. Setup, review and gate jobs have
  `contents: read`; only the comment job has `pull-requests: write`, and it runs
  no PR code and holds no secrets.
- Credentials only reach the review job, which requires policy `review` and
  `head.repo.full_name == github.repository`.
- Helpers, prompts and configuration are sparsely checked out from the base
  revision into `trusted/`; the head goes to `src/` with
  `persist-credentials: false` and is read only. No npm install of PR code runs.
- PR title and body come from `$GITHUB_EVENT_PATH` and sit between random
  `BEGIN/END_UNTRUSTED_PR_METADATA_<nonce>` markers.
- The result step withholds output that contains a secret literal or its JSON
  escape, including refreshed Codex tokens re-read from `auth.json`; it prints
  the Codex log only when clean. Artifacts contain only `result.json` and
  `review.md` and expire after one day.
- **Bootstrap:** when `base.sha` lacks `.github/review-agents.json`, the config
  comes from `head.sha`, loudly: `::warning::`, step summary, `bootstrap: true`
  in the result and a BOOTSTRAP notice in the comment. Normal gate rules apply.
  This PR and an umbrella PR into `main` take that path. Partial configuration
  at the base fails setup.
- **Gate:** fork fails ("AI review unavailable for fork PRs"); draft passes as an
  intentional skip; anything other than complete results for this exact base and
  head with successful review and publish jobs fails; any CRITICAL or HIGH
  finding fails after publication; MEDIUM and LOW are reported as advisory.

## 6. What a real Actions run must confirm

1. `ubuntu-24.04-arm` starts all jobs; `npm ci` installs `codex-linux-arm64`, and the version check passes.
2. After the sysctl step, the sandbox preflight passes on ARM: `git` runs, the write is refused, and **network access is refused**. If read-only mode allows network, the job fails by design and the sandbox configuration must change.
3. Codex authenticates with `CODEX_AUTH_DOT_JSON`; the log header shows the organization's `CODEX_REVIEW_MODEL` and `CODEX_REVIEW_EFFORT`; the API accepts them; `-o` captures the final message.
4. Claude installs on ARM; `--restricted` still accepts `CLAUDE_CODE_OAUTH_TOKEN` from the environment (the help text says `--bare` limits auth routes, and the local run cannot distinguish a restriction from "not logged in"); the init message reports the configured model, `cwd` = `src/` (so `CLAUDE_WORKING_DIR` reaches the composite action) and a read-only tool set through the SDK path; `--add-dir` lets Claude read the context directory; the run completes within 45 minutes.
5. Artifacts pass between jobs; `pull-requests: write` is enough to list, create, update and delete issue comments; the comment author is `github-actions[bot]` with type `Bot`.
6. Bootstrap labeling appears on this pull request; a second push updates the same comments; a push during a run cancels it and the older run does not publish.
7. The gates report the expected names. A deliberate invalid variable on a test repository (or a repository-level override) fails with the variable named.
8. Whether the OpenAI API rejects an unsupported `model_reasoning_effort` (expected) rather than ignoring it.
9. The `OUTCOMES` word-split passes each setup step outcome to the result step.
10. If setup fails, the skipped review job's `fromJSON` matrix may show a strategy-evaluation error rather than a clean skip. The gate still fails through `prepare != success`, so this is cosmetic.

## 7. Recommendations (not performed)

- Ruleset: require `Codex review gate` and `Claude review gate` on `improve/integration` and `main` after a real run succeeds. This is a ruleset change that needs user authorization (D-002).
- Dependabot (owned by the tooling agent): add `npm` for `/.github/scripts/codex-cli` and keep `github-actions` updates, so the pins move by pull request. When the Claude action moves, re-verify the flags and update `accepted_effort_levels` in the same pull request.
- Keep "Require approval for fork pull request workflows" enabled. Under `pull_request` a fork's own YAML runs, so a fork can spoof a gate name; maintainer approval and review of workflow changes are the control.

## 8. Residual risks

- Same-repository authors control the executed workflow YAML under `pull_request`; base-revision staging protects the review policy and helpers only while the YAML is unchanged.
- The Codex read-only sandbox can read files on the runner, including `auth.json`. Network refusal, the minimal environment and the output credential guard mitigate exfiltration; the guard detects literal and JSON-escaped values, not other encodings.
- The Claude effort vocabulary must track the pinned CLI by hand.
- Strict output parsing can mark a substantively useful review incomplete if the model deviates from the format. That fails closed and shows the raw text.
- Cross-provider aggregation relies on both gates being required checks.
