# T1 AI review: Codex and Claude review workflows (#25)

| Item | Value |
| --- | --- |
| Task | T1-ai-review: review workflows, helpers, configuration and helper tests for #25 |
| Governing issue | #25, updatedAt 2026-10-03T00:44:05Z, sha256(body)[:16] `3e13f34c17fb3f73`, no comments (rechecked live at completion) |
| Base | `1e6184c37c0d2cdb8b493d59718c9c7281787a9e` on `improve/integration` |
| Branch / worktree | `t1/ai-review` in `/workspace/webaudio-tinysynth-worktrees/t1-ai-review` |
| Commits (GPG-signed) | `ef00de2` implementation, `f429489` this record, `1f17527` Claude tool-set check, `81f8efd` comment heading, `e9e31e6` instruction files and comment ownership, `848bae6` init requirement and Codex authentication message, then the round-three and G0 fixes (§6d; see `git log`) |
| Large evidence | `/workspace/webaudio-tinysynth-worktrees/_evidence/t1-ai-review/` |
| Setup documentation | `.github/scripts/README.md` |

Real runs: PR #28 (`t1/ai-review` → `improve/integration`) ran three rounds in
bootstrap mode. Round one at `1f17527` passed both gates with two MEDIUM
findings. Round two at `e9e31e6` passed with two MEDIUM findings. Round three at
`848bae6` failed by design: Codex reported a HIGH (Bun in the checkout, fixed in
§6d) and Claude's review was incomplete (a prose preamble, handled in §6d).
Section 6 marks what these runs confirmed. Logs:
`_evidence/t1-ai-review/pr28-runs/`.

## 1. Files

| File | Role |
| --- | --- |
| `.github/review-agents.json` | One `tinysynth` reviewer with scope `"."`, blocking severities `CRITICAL` and `HIGH`, provider variable names, pin locations, and the pinned Claude CLI's accepted effort vocabulary |
| `.github/prompts/review-policy.md` | Shared policy and output contract: exactly `lgtm`, or findings with severity, `file:line`, Evidence/trigger, Impact and Recommended action |
| `.github/prompts/tinysynth-review.md` | Short role prompt, #25's suggested text plus the inline `animation_url` constraint |
| `.github/scripts/review_lib.py`, `review.py` | Configuration and settings validation, change detection, prompt building, result parsing, credential guard, comment rendering, upsert and gate |
| `.github/scripts/run-codex-review.sh` | Runs the pinned Codex CLI with a minimal environment |
| `.github/scripts/codex-cli/package.json`, `package-lock.json` | Codex CLI pin `@openai/codex` 0.160.0 with integrity hashes. The root `.gitignore` matches `package-lock.json`, so the lockfile was added with `git add -f`; once T1 tooling removes that entry, nothing changes. |
| `.github/scripts/test_review.py` | 69 `unittest` tests (one opt-in Bun test) |
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
| Real authorized Actions run | Done for both providers in bootstrap mode (PR #28, three rounds); the round-three fixes still need a run | Section 6; `_evidence/t1-ai-review/pr28-runs/` (`highlights.txt`, `review-job-highlights.txt`, `step-conclusions.txt`, job logs) |
| Ruleset and credential changes reported separately | Met | Section 7 (recommendations only) |

## 3. Validation

| Command | Result |
| --- | --- |
| `python3 -I -B -m unittest discover -s .github/scripts -p 'test_*.py' -v` (Python 3.12.3) | 69 tests OK, 1 skipped without `REVIEW_TEST_BUN` (`_evidence/t1-ai-review/unittest.log`); the Bun test passes with the pinned Bun 1.3.14 |
| `actionlint` 1.7.12 linux_amd64 (sha256 `8aca8db9…` verified against the release `checksums.txt`) on `.github/workflows/*.yml`, with shellcheck on PATH | exit 0 |
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
- The result step withholds output that contains a secret value or a long
  string leaf of it, in literal, JSON-escaped, reversed, hex or base64
  (standard and URL-safe, every alignment) form, also after removing
  whitespace. This includes refreshed Codex tokens re-read from `auth.json`.
  The Codex log is printed only when clean. Artifacts contain only
  `result.json` and `review.md` and expire after one day.
- Claude runs from an empty trusted working directory and reads the checkout
  via `--add-dir`; helpers run as `python3 -I -B`; `trusted/` is fingerprinted
  before and verified after the provider step (§6d).
- **Bootstrap:** only a base `main` without `.github/review-agents.json` takes
  the configuration from `head.sha`, loudly: `::warning::`, step summary,
  `bootstrap: true` in the result and a BOOTSTRAP notice in the comment. Normal
  gate rules apply. Any other base without the configuration fails setup with
  an explicit message. Partial configuration at the base fails setup.
- **Gate:** fork and Dependabot pull requests fail with explicit messages;
  draft passes as an intentional skip; anything other than complete results for
  this exact base and head with successful review and publish jobs fails; any
  CRITICAL or HIGH finding fails after publication; MEDIUM and LOW are
  reported as advisory. A title or body edit runs nothing, and its gate job has
  a different name, so it cannot satisfy the required check.

## 6. What a real Actions run must confirm

Status after PR #28's three rounds (runs 37090657860/71, 37091416897/840,
37091989339/349; job logs in `_evidence/t1-ai-review/pr28-runs/`):

| # | Item | Status |
| --- | --- | --- |
| 1 | `ubuntu-24.04-arm` starts all jobs; `npm ci` installs `codex-linux-arm64`; the version check passes | **Confirmed**: "Image: ubuntu-24.04-arm", "Node v22.23.3, npm 10.9.9, aarch64", install step success in all three Codex runs |
| 2 | After the sysctl step the sandbox preflight passes on ARM: `git` runs, the write is refused, network is refused | **Confirmed** as a passing step in all three runs, but the old probe could not tell refusal from other curl failures (G0 L5). The new probe logs both exit codes against an unsandboxed control; it needs one more run. |
| 3 | Codex authenticates with `CODEX_AUTH_DOT_JSON`; the header shows the configured model and effort; `-o` captures the final message | **Confirmed**: "model: gpt-6.1-sol", "reasoning effort: high", "sandbox: read-only", exit 0, findings captured and published |
| 4 | Claude installs on ARM; `--restricted` accepts `CLAUDE_CODE_OAUTH_TOKEN`; the init message reports the configured model through the SDK path; the run finishes within 45 minutes | **Confirmed**: "Installing Claude Code v2.1.288", `INPUT_CLAUDE_ARGS` and SDK `settingSources: ["user"]`, init model `claude-opus-5-5`, `subtype: success`, `permission_denials_count: 0` |
| 4b | Claude reads the checkout via `--add-dir` from the empty trusted working directory; the init `cwd` is `$RUNNER_TEMP/claude-cwd`; the session and execution-file checks pass | **Open** (new in §6d) |
| 5 | Artifacts pass between jobs; `pull-requests: write` lists, creates and updates comments; the author is `github-actions[bot]` | **Confirmed**: comments 5964792024 (Codex) and 5964758179 (Claude) were created in round one and updated in place in rounds two and three |
| 6 | Bootstrap labeling; a second push updates the same comments; a push during a run cancels it and the older run does not publish | Labeling and in-place updates **confirmed**; cancel-on-push **open** |
| 7 | The gates report the expected names; an invalid variable fails with its name | Names **confirmed** (job list); invalid variable **open** |
| 8 | The OpenAI API rejects an unsupported `model_reasoning_effort` | **Open** |
| 9 | The `OUTCOMES` word-split passes each step outcome to the result step | **Confirmed**: complete results with no spurious setup-step errors |
| 10 | A failed setup makes the skipped review job show a strategy error (cosmetic) | Not exercised |
| 11 | A title edit produces no check named exactly `Codex review gate` or `Claude review gate`; a base change runs a full review | **Open** (new in §6d) |
| 12 | The fingerprint verification passes in a normal run (`-B` writes no bytecode) | **Open** (new in §6d) |
| 13 | PR #28's next run fails setup by design: its base `improve/integration` lacks the configuration and is not on the bootstrap allowlist | Expected; the configuration must land on `improve/integration` first (§6d, M3) |

## 6a. Follow-up: visible provider and model heading

At the user's request (via the supervisor, after PR #28 showed a Claude comment
that read only "lgtm"), every rendered comment now starts with one visible line,
`**<display name> review** · model `<model>` · effort `<effort>` · head
`<12 hex>``, built only from the result record (the requested
`*_REVIEW_MODEL` and `*_REVIEW_EFFORT` values). It appends
`(resolved `<id>`)` when the provider reported a different model. A clean
comment is that heading, a blank line and `lgtm`. This deliberately departs
from the github-ci skill's convention that a clean comment's visible body is
only `lgtm`. The model's output contract is unchanged: a clean review must still
be exactly `lgtm`, and the gate reads `result.json`, never comment text.
Tests: `CommentTests` (heading for both providers on clean, findings and failed
comments; resolved suffix; unknown and hostile values),
`ResultTests.test_changed_variables_change_the_visible_heading` (two variable
pairs per provider produce four distinct headings), and
`GateTests.test_gate_reads_result_records_not_comment_text` ("HIGH" in a model
name, heading or review text does not change the gate).

## 6b. Follow-up: PR-controlled instruction files and comment ownership

PR #28's first real run passed end to end in bootstrap mode. Codex raised two
MEDIUM findings, both fixed here.

**Instruction files.** Evidence is in
`_evidence/t1-ai-review/instruction-loading/`. The probe repository holds
`AGENTS.md`, `AGENTS.override.md`, `sub/AGENTS.md`, `.agents/skills/…`,
`.codex/skills/…`, `CLAUDE.md`, `CLAUDE.local.md` and `.claude/` rules,
commands, skills and agents, each carrying a marker.

- Codex 0.160.0: `codex-rs/core/src/agents_md.rs` at `rust-v0.160.0`
  (`load_project_instructions`) returns early only for an explicitly untrusted
  project; otherwise it reads `AGENTS.override.md`, `AGENTS.md` and configured
  fallbacks until `config.project_doc_max_bytes` is used up, and stops at `0`.
  The key is `project_doc_max_bytes` in `codex-rs/config/src/config_toml.rs`
  (default 32768 in `codex-rs/config/defaults.toml`). Skills are a separate
  channel: `SkillsConfig.include_instructions` in
  `codex-rs/config/src/skills_config.rs` ("Whether turns receive the automatic
  skills instructions block"). Measured by capturing the real `codex exec`
  request with a local stub API (`openai_base_url`, `CODEX_API_KEY`): with a
  fresh `CODEX_HOME` and the old arguments, the request contained
  `AGENTS.override.md` and both repository skills; with
  `-c project_doc_max_bytes=0 -c skills.include_instructions=false` it contained
  only the prompt. `codex debug prompt-input` agrees, including nested
  `sub/AGENTS.md`. `codex exec` accepts both overrides
  (`codex-exec-accepts-overrides.txt`).
- Claude Code 2.1.288: https://code.claude.com/docs/en/agent-sdk/claude-code-features
  states that `"project"` loads project `settings.json`, hooks, `CLAUDE.md`,
  `.claude/rules/*.md`, skills, commands and subagents, `"local"` loads
  `CLAUDE.local.md`, and omitting `settingSources` means all three. The pinned
  base action's `parse-sdk-options.ts` sets `settingSources` from
  `--setting-sources`, and an empty value parses as a valueless flag, which falls
  back to all three. Measured by capturing the real CLI's API request
  (`ANTHROPIC_BASE_URL` stub): a control run sent `CLAUDE.md`,
  `CLAUDE.local.md`, the rule, command, skill and agent; the generated
  arguments sent only the prompt, and so did `--setting-sources user` alone
  and `--restricted` alone. The existing arguments were already safe, so the
  change is documentation and tests that pin `--setting-sources user`.
- Tests: `SettingsTests.test_repository_instruction_files_are_not_loaded` and
  the extended `test_settings_propagate_to_the_codex_command_line`. Removing
  either Codex override, or emptying `--setting-sources`, fails the suite.

**Comment ownership.** `upsert_comment` matched the marker as a substring, so
a Claude comment quoting the Codex marker could be patched or deleted as a
Codex duplicate. `review_lib.owns_comment` now requires `github-actions[bot]`
with type `Bot` and a first line exactly equal to the marker (CRLF tolerated).
Tests: `PublishTests.test_a_comment_quoting_another_marker_is_not_owned` (only
the genuine Codex comment is patched; nothing is deleted) and
`test_ownership_requires_the_exact_first_line`. Reverting to a substring match
fails four tests.

## 6c. Follow-up: Claude init requirement and Codex authentication failures

The rerun at `e9e31e6` passed and updated both comments in place. Two new
MEDIUM findings are fixed here.

- **Claude without init (Codex finding).** A transcript with a successful
  `result` but no `system/init` message skipped the working-directory and
  tool-set checks. `claude_execution` now fails when the init message is
  missing, or when no expected working directory was given. Tests:
  `ResultTests.test_success_without_init_cannot_pass_the_gate` and the
  `success without init` cases in `test_claude_final_result_extraction`. Making
  init optional again fails three tests.
- **Codex credential lifetime (Claude finding).** `CODEX_AUTH_DOT_JSON` is
  ChatGPT-mode auth, and refreshed tokens are discarded after each run. The
  secret is organization-managed and shared, so the workflow neither writes
  secrets nor adds an API-key path. `review_lib.classify_codex_failure` instead
  turns an authentication failure into "Codex authentication failed: the org
  secret CODEX_AUTH_DOT_JSON needs to be refreshed (or switch to an API-key
  credential)". This message reaches the comment and the gate. Signatures: the
  refresh-failure messages in `codex-rs/login/src/auth/manager.rs` at
  `rust-v0.160.0` (`REFRESH_TOKEN_*_MESSAGE`, all "Your access token could not
  be refreshed…", "…sign in again") and HTTP `401 Unauthorized`. The real 0.160.0
  log from an invalid `auth.json` is classified correctly
  (`_evidence/t1-ai-review/auth-errors/`). Other nonzero exits keep the exit
  status and add a hint to check the secret. The log itself is never quoted.
  Test: `ResultTests.test_codex_authentication_failures_are_actionable`, which
  covers each refresh message, the 401 line, non-auth failures, the gate
  message and the absence of secrets. Disabling the classifier fails five
  tests. The README documents the credential-lifetime dependency. Persisting
  refreshed tokens, or an API-key credential, is an organization-level
  decision.

## 6d. Round three and the G0 review

Round three at `848bae6` failed both gates as designed, and the independent G0
review of `1eff7ba` (`/workspace/webaudio-tinysynth-worktrees/g0-review/docs/improvements/tasks/G0-review.md`)
rejected #25 pending H1. Evidence for this section is under
`_evidence/t1-ai-review/` in `bun-cwd/`, `env-presets/`, `npmrc/` and `pr28-runs/`.

| Finding | Fix | Tests and evidence |
| --- | --- | --- |
| Round-three HIGH and G0 H1: Bun ran in the checkout with the Claude token | `CLAUDE_WORKING_DIR` is now `$RUNNER_TEMP/claude-cwd`, created and verified empty. The checkout and the context go in through `--add-dir`. The prompt says the working directory is empty and names the checkout path. The result step requires the init `cwd` (compared by realpath) to be that directory. | `test_claude_runs_from_an_empty_trusted_directory`; `test_bun_does_not_load_checkout_configuration` (opt-in; passes with the pinned Bun 1.3.14, `bun-cwd/unittest-bun.txt`). Probe `bun-cwd/bun-preload-probe.txt`: with the checkout as working directory the preload ran with the token visible and `.env`/`.env.local` were injected; with the empty directory nothing loaded; Bun does not walk up to parent directories. API-stub probe `bun-cwd/claude-addir-probe.txt`: empty working directory plus the hostile checkout as `--add-dir` sends only the prompt, with tools `[Glob, Grep, Read]`. |
| H1 extra, L3: the model could be overridden; a mismatch only warned | A reported model that differs from the variable now fails the review. The action step sets `ANTHROPIC_MODEL` to the validated model; the base action gives it precedence over `--model`. | `test_claude_final_result_extraction` ("model differs from the variable"). `env-presets/summary.txt` shows `CLAUDE_CODE_EFFORT_LEVEL=low` overriding `--effort high`, so it is cleared, and an empty value defers to `--effort`. The captured request carries `output_config.effort`. |
| H1 extra: pass-through variables | The action step presets `CLAUDE_CONFIG_DIR` (`~/.claude`), `CLAUDE_CODE_EFFORT_LEVEL` (empty), `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=0`, empty `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`/`NO_PROXY`, `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `BUN_OPTIONS`, `BUN_CONFIG_REGISTRY` and `BUN_CONFIG_TOKEN`. Lowercase proxy names are omitted because Actions treats `env` keys case-insensitively (actionlint). | `test_claude_runs_from_an_empty_trusted_directory` checks each preset; `env-presets/summary.txt` shows the empty presets leave the request unchanged. `env-presets/addir-claude-md-probe.txt` uses the exact preset block, an empty working directory and the hostile checkout as `--add-dir`: the request is sent and carries only the prompt. The same holds with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` set to `1` or empty, so under `--setting-sources user --restricted` that variable is inert; `"0"` is kept as an explicit off. |
| H1 extra: result and gate steps must not trust files the provider step could rewrite | `trusted/.github` is fingerprinted before the provider step (the output is runner-held) and verified afterwards. The result step runs only after verification. The completion check is inline `jq`. The Claude execution file must be the action's own path and carry the `session_id` that the action output. Helpers run as `python3 -I -B`, so no bytecode is written or trusted. | `test_trusted_configuration_is_fingerprinted_and_verified` (tampered or planted `.pyc` changes the digest); `test_claude_final_result_extraction` (session, file) |
| Round-three incomplete Claude review and parser robustness | The policy now says to start with `lgtm` or `### [` and write nothing else, and the prompt's last line repeats it. A bounded tolerance discards up to three lines (500 characters) of prose before the first finding, without fences or `lgtm`, only when every finding is valid; the result records a warning and the comment shows the findings only. List semantics reject prose between or after findings. | `ParserToleranceTests` (round-three shape accepted; long, fenced, `lgtm` and invalid-finding preambles and prose between or after rejected; lazy, indented, list and fenced continuations accepted) |
| G0 L1: malformed heading after a valid finding | Any other Markdown heading, or a line starting with a severity tag and a location, makes the review malformed wherever it appears | `test_unknown_severity_and_malformed_findings_are_incomplete` (`### HIGH b.js:2`, `**HIGH** b.js:2`, lazy form, `## Summary`) |
| Round-three MEDIUM, G0 L2: base retarget | `edited` triggers the workflows. The guard `github.event.action == 'edited' && !github.event.changes.base` skips setup, review and publish, and gives the gate job another name, so a skipped gate (which GitHub counts as success) can never satisfy the required `… review gate` check. A metadata edit joins a `-metadata` concurrency group and cannot cancel a review. A base change runs a full review against the new base. Setup also classifies a metadata edit as `metadata-edit` as a second line of defense. | `test_metadata_edit_classification`, `test_workflows_filter_title_and_body_edits_identically`, `test_stable_check_names` |
| G0 M2 (guard) | Encodings: literal, JSON-escaped, reversed, hex (both cases), standard and URL-safe base64 at all three alignments, also with whitespace removed | `LeakGuardTests` |
| G0 M2 (fork message) | The message says a maintainer must review fork changes manually and that only reviewed, trusted code may be mirrored | `test_fork_message_does_not_advise_mirroring_untrusted_code` |
| G0 M3: bootstrap for any configuration-less base | `BOOTSTRAP_BASE_BRANCHES: main` in the selection step; any other base fails with "Bootstrap from the pull request head is allowed only for: main". PR #28's next run will therefore fail setup until the configuration is on `improve/integration`. | `test_bootstrap_is_allowed_only_for_listed_bases` (runs the workflow's own selection script) |
| G0 L4 | The heading comes first, then the BOOTSTRAP notice | `test_bootstrap_uses_the_head_loudly` |
| G0 L5 | The network probe runs the same HTTPS request outside the sandbox (must exit 0) and inside (must fail), and logs both curl exit codes. It proves the sandbox blocks a TCP and TLS connection the runner can make, not every protocol. | Workflow text; README |
| G0 L6: Dependabot | PRs authored or sent by `dependabot[bot]` get policy `dependabot`, and the gate fails with "AI review unavailable for Dependabot PRs". Dependabot secrets are an organization decision. | `test_dependabot_pull_requests_fail_explicitly` |
| G0 L7 | `review-helpers.yml` runs actionlint on `.github/workflows/*.yml` (read-only) | local actionlint on all workflows |
| G0 I1 | README "Trust boundary" documents fork check-name spoofing under `pull_request`, and recommends fork-workflow approval, Actions-sourced required gates and code-owner review of `.github/**`. No settings changed. | README |
| G0 M1 | Already fixed at `848bae6` | §6c |
| G0 M4 | Tooling scope (`package.json`), not owned by this task | — |

**Parser decision.** Failing closed on any preamble made an otherwise valid
round-three review incomplete. That costs a rerun and adds no safety: prose
before the first heading cannot add, remove or change a parsed finding or its
severity. The tolerance is bounded (three lines, 500 characters, no fence, no
`lgtm`), applies only when every finding is valid, is recorded as a warning,
and the discarded text is not published. Prose between or after findings stays
an error because it could carry review content outside the parsed records. The
stronger prompt aims to make the tolerance rarely needed.

**Audit of credential-bearing launches.**

| Job and step | Credential | Process | Configuration that could come from the working directory or the checkout | Result |
| --- | --- | --- | --- | --- |
| Codex: check the credential | `CODEX_AUTH_DOT_JSON` | `python3 -I -c` | cwd modules: `-I` keeps cwd off `sys.path`; the workspace root holds only `src/` and `trusted/` | safe (`test_shadow_modules_in_the_working_directory_are_never_loaded`) |
| Codex: run | `auth.json` in a fresh `CODEX_HOME` | bash (`--noprofile --norc`), `run-codex-review.sh`, `python3 -I -B`, `env -i` Node launcher, Codex | shell rc: none. Python: isolated. Node: no `.env` autoload; `NODE_OPTIONS` removed by `env -i`; `package.json` "type" applies to the launcher's own package. Codex: `.codex/` project layer not loaded (untrusted, fresh home); `AGENTS*.md` and skills disabled; `.env` only from `CODEX_HOME` (`codex-rs/arg0/src/lib.rs` `load_dotenv`). git in the sandbox uses the checkout-written `.git/config`; read commands run no hooks. | safe (exact-environment test; §6b probes) |
| Codex: model commands | can read `auth.json` | PR code may run read-only, without network | — | residual (M2): output guard |
| Codex: record result | `CODEX_AUTH_DOT_JSON` | `python3 -I -B` from `trusted/` | fingerprint verified first | safe |
| Codex: install CLI | none | `npm ci --ignore-scripts` in `$RUNNER_TEMP/codex-cli` | the checkout's `.npmrc` and `package.json` scripts are never in scope | safe (`npmrc/summary.txt`: install succeeds with a dead-registry `.npmrc` in `src/`; the control inside `src/` fails with ECONNREFUSED; no checkout script ran) |
| Claude: check the credential | `CLAUDE_CODE_OAUTH_TOKEN` | bash | — | safe |
| Claude: base action | `CLAUDE_CODE_OAUTH_TOKEN` | `setup-node` (cache off, `package-manager-cache: false`), `setup-bun` (1.3.14, `no-cache: true`), `bun install --production` in `GITHUB_ACTION_PATH`, the official installer, `bun run` in `CLAUDE_WORKING_DIR`, Claude Code | Bun `bunfig.toml` and `.env*` were loaded from the checkout (H1); now an empty trusted directory. Claude settings, hooks, `CLAUDE.md`, rules, skills, commands, agents and `.mcp.json`: excluded by `--setting-sources user`, `--restricted` and `--strict-mcp-config`, with no `CLAUDE.md` from added directories. Environment presets as above. | fixed |
| Claude: record result | `CLAUDE_CODE_OAUTH_TOKEN` | `python3 -I -B` from `trusted/` | fingerprint verified; execution-file path and session checked | safe |
| Comment job | `GH_TOKEN` (pull-requests: write) | `python3 -I -B` from a fresh `trusted/` checkout, `gh` | `gh` reads `~/.config/gh` only; no checkout in this job | safe |
| Every checkout | job token, `persist-credentials: false` | git | `.gitattributes` drivers need git config; LFS smudge is the runner's own binary | safe |
| Caches | — | — | none used (no `actions/cache`; the action disables Node and Bun caches) | n/a |

## 7. Recommendations (not performed)

- Ruleset: require `Codex review gate` and `Claude review gate` on `improve/integration` and `main` after a real run succeeds. This is a ruleset change that needs user authorization (D-002).
- Dependabot (owned by the tooling agent): add `npm` for `/.github/scripts/codex-cli` and keep `github-actions` updates, so the pins move by pull request. When the Claude action moves, re-verify the flags and update `accepted_effort_levels` in the same pull request.
- Keep "Require approval for fork pull request workflows" enabled. Under `pull_request` a fork's own YAML runs, so a fork can spoof a gate name; maintainer approval and review of workflow changes are the control. Require the gates with GitHub Actions as the expected source, and require code-owner review of `.github/**` (G0 I1).
- Land the review configuration on `improve/integration` (for example by merging T1 there) before relying on further PR #28 runs: bootstrap is now limited to base `main` (G0 M3).
- Dependabot review credentials, an API-key Codex credential, or persisting refreshed Codex tokens are organization decisions.

## 8. Residual risks

- Same-repository authors control the executed workflow YAML under `pull_request`; base-revision staging protects the review policy and helpers only while the YAML is unchanged.
- The Codex read-only sandbox can read files on the runner, including `auth.json`. Network refusal, the minimal environment and the output credential guard mitigate exfiltration. The guard detects literal, JSON-escaped, reversed, hex and base64 copies (with whitespace removed); a copy split into pieces with other characters between them, a partial copy or another encoding is not detected.
- The edit guard relies on GitHub naming a skipped gate job either with the rendered alternative name or with the raw expression; both differ from the required name. A real title edit (§6 item 11) confirms it.
- The bounded preamble tolerance discards up to three lines of model prose; anything beyond fails closed.
- The Claude effort vocabulary must track the pinned CLI by hand.
- Strict output parsing can mark a substantively useful review incomplete if the model deviates from the format. That fails closed and shows the raw text.
- Cross-provider aggregation relies on both gates being required checks.
