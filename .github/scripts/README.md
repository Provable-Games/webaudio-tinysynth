# AI review workflows

Codex (`.github/workflows/codex-review.yml`) and Claude
(`.github/workflows/claude-review.yml`) review every same-repository pull request
with one TinySynth reviewer role and one shared output policy:

| File | Purpose |
| --- | --- |
| `.github/review-agents.json` | Reviewer role, scope (`"."`, the whole repository), blocking severities, and per-provider variable names and pins |
| `.github/prompts/review-policy.md` | Shared review policy and output contract |
| `.github/prompts/tinysynth-review.md` | Short TinySynth reviewer role |
| `review_lib.py`, `review.py` | Configuration, prompt, result parsing, comment and gate helpers (Python standard library) |
| `run-codex-review.sh` | Runs the pinned Codex CLI once |
| `codex-cli/package.json`, `package-lock.json` | The Codex CLI pin |
| `test_review.py` | Helper and workflow regression tests |

## Checks

Each provider workflow runs four jobs. Require the two gates in the branch ruleset:

| Check name | Required | Meaning |
| --- | --- | --- |
| `Codex review gate` | yes | Codex review outcome for this head |
| `Claude review gate` | yes | Claude review outcome for this head |
| `Codex review setup`, `Claude review setup` | no | Policy, trusted configuration and change detection |
| `Codex review / tinysynth`, `Claude review / tinysynth` | no | The credential-bearing review run |
| `Codex review comment`, `Claude review comment` | no | Publishes the bot comment |
| `Review helper tests` (`review-helpers.yml`) | optional | Runs `test_review.py`, shellcheck and actionlint |

The merge gate is the pair of required gates: a HIGH finding from either
provider fails that provider's gate, so one clean provider cannot override the
other. A required-check change is a ruleset change; these workflows do not make it.

## Configuration

| Name | Kind | Use |
| --- | --- | --- |
| `CODEX_REVIEW_MODEL` | Actions variable | Codex model, passed as `codex exec -m` |
| `CODEX_REVIEW_EFFORT` | Actions variable | Codex reasoning effort, passed as `-c model_reasoning_effort="…"` |
| `CLAUDE_REVIEW_MODEL` | Actions variable | Claude model, passed as `--model` |
| `CLAUDE_REVIEW_EFFORT` | Actions variable | Claude effort, passed as `--effort` |
| `CODEX_AUTH_DOT_JSON` | secret | Codex `auth.json`, written to a fresh `CODEX_HOME` for the run only |
| `CLAUDE_CODE_OAUTH_TOKEN` | secret | Claude Code OAuth token for the base action |

There are no in-repository defaults. To change a model or effort, edit the
organization variable, or create a repository variable with the same name to
override it for this repository only. The next run uses the new value without
any file change. The organization variable `CODEX_CLI_VERSION` is not read.

Validation happens before any paid run, and errors name the variable:

- Missing or empty values fail.
- Model IDs must match `[A-Za-z0-9][A-Za-z0-9._:@/-]*`, with an optional
  `[suffix]` such as `[1m]`. Efforts must be lowercase slugs.
- Claude Code 2.1.288 ignores an unknown `--effort` value with only a warning
  and does not report effort in its transcript. The workflow therefore accepts
  only the values listed in `providers.claude.accepted_effort_levels`. That list
  is the vocabulary of the pinned CLI, not a default; update it in the same pull
  request that moves the Claude action pin. The docs say an effort the selected
  model does not support falls back to the next lower supported level, and no
  workflow can observe that.
- Codex sends `model_reasoning_effort` to the API without checking it locally;
  an unsupported value is expected to fail the API request. After the run, the
  result step requires the CLI header to show exactly the configured `model:`
  and `reasoning effort:`, which proves what was sent.

## Pins

Each pin has one place:

- Codex CLI: `codex-cli/package-lock.json` (`@openai/codex` 0.160.0, with
  integrity hashes for every platform package, including linux-arm64).
  Installed with `npm ci --ignore-scripts`. To update it, run
  `npm install --package-lock-only --ignore-scripts @openai/codex@<version>` in
  `codex-cli/`, then re-check the `codex exec` flags this workflow uses.
- Claude: `anthropics/claude-code-action/base-action@<sha> # v1.0.240` in
  `claude-review.yml`. The base action installs Claude Code 2.1.288 through the
  official installer. When moving it, re-check `--effort`, `--restricted`,
  `--setting-sources`, `--strict-mcp-config`, `--tools` and the execution-file
  format, and update `accepted_effort_levels`.
- Every other action is pinned to a full commit SHA with a version comment.

All jobs run on `ubuntu-24.04-arm`. Both CLIs publish linux-arm64 builds.

## Policies

| Situation | Gate |
| --- | --- |
| Draft pull request | Passes with "Review intentionally skipped: draft PR". Marking it ready runs the review. |
| Fork pull request (including a deleted fork) | Fails with "AI review unavailable for fork PRs". This public repository does not give forks secrets, and a skipped job would count as success. |
| No changed files (git and GitHub agree) | Passes with an explicit skip notice |
| Git finds no changes but GitHub reports some | Fails: a detection failure is not an empty diff |
| Missing or invalid variable, missing secret | Fails, naming the variable or secret |
| CLI failure, cancellation, timeout, missing or blank output | Fails. Partial output from a failed run is discarded, even `lgtm`. |
| Output that is not exactly `lgtm`, valid findings, or `Review incomplete: …` | Fails as incomplete; the raw text is shown in the comment |
| Output containing a credential value | Fails; the output is withheld |
| Result for a different base or head, or a newer head at publish time | Fails; nothing is published for a stale head |
| Complete review with only MEDIUM or LOW findings | Passes; the findings stay visible |
| Complete review with a CRITICAL or HIGH finding | Fails after the comment is published |

## Output contract and parsing

A complete clean review is exactly `lgtm`. Otherwise the output is only
findings in the form defined in `review-policy.md`:

```text
### [HIGH] webaudio-tinysynth.js:123 — concise issue
- **Evidence/trigger:** …
- **Impact:** …
- **Recommended action:** …
```

`review_lib.parse_review` reads finding headings outside code fences only and
requires every field. Unknown severities, text outside findings, a missing line
number, or `lgtm` next to findings make the review incomplete. Severity words
in prose or in code examples are ignored.

## Comments

Each provider keeps one bot comment per reviewer, found by the hidden marker
`<!-- tinysynth-ai-review:<provider>:<agent> -->` and authored by
`github-actions[bot]` (type `Bot`). Comments by other users or apps are never
edited, even if they quote the marker. A second hidden comment records the
base, head, merge base, configuration revision, model, effort and run.

Every comment, clean or not, starts with one visible heading built from the
result record, for example:

```text
**Claude review** · model `<CLAUDE_REVIEW_MODEL>` · effort `<CLAUDE_REVIEW_EFFORT>` · head `0123456789ab`
```

It shows the requested model and effort, and adds `(resolved …)` when the
provider reported a different model ID, such as for an alias. A clean review's
body is then exactly `lgtm`; findings and failures follow the same heading. A
bootstrap review also shows a BOOTSTRAP notice above it. The heading is only
presentation: the model's own output must still be exactly `lgtm`, and the gate
reads `result.json`, never comment or review text. A failed or incomplete run
replaces an earlier verdict with "Review not completed", so an old `lgtm` never
stays under a new head.

## Trust boundary

- The workflows use `pull_request`, not `pull_request_target`. Top-level
  permissions are empty. Review jobs have `contents: read`, and only the comment
  job has `pull-requests: write`.
- The review job runs only when the setup job chose the `review` policy and the
  head repository is this repository. Forks never reach a job with secrets.
- Configuration, prompts and helpers come from the pull request's **base
  revision**, checked out sparsely into `trusted/`. The head is checked out
  separately into `src/` with `persist-credentials: false` and is only read:
  no install scripts, hooks or helpers from the pull request run.
- Codex runs with a fresh `CODEX_HOME` holding only `auth.json`, with
  `--ignore-user-config --ignore-rules --sandbox read-only --ephemeral` and a
  minimal environment. Before the review, the sandbox must run `git`, refuse a
  write and refuse network access. A trusted Codex home would load the pull
  request's `.codex/` layer, including MCP server commands.
- Claude runs through the base action, so no GitHub token or GitHub tools reach
  it. It uses `--restricted --setting-sources user --strict-mcp-config
  --permission-mode dontAsk --tools Read,Glob,Grep`, so project settings, hooks
  and `.mcp.json` servers from the pull request do not load. Its working
  directory is `src/`, and the precomputed diff is added with `--add-dir`.
  Symlinks that leave the checkout are replaced first. The result step fails
  the review if Claude's init message reports a working directory other than
  `src/`, or any tool that runs commands, writes, delegates or reaches the
  network (including MCP tools).
- The pull request title and body are read from the event file and placed
  between random delimiters as untrusted data. They are never interpolated into
  shell code.
- Before upload, the result step withholds any output that contains a literal
  or JSON-escaped secret value, including refreshed Codex tokens. Only
  `result.json` and the review text are uploaded, for one day.
- The comment job checks the current head through the API before writing, and
  runs the base revision's helpers without secrets.

Under `pull_request`, GitHub runs the workflow YAML from the pull request merge
commit. A same-repository author can therefore change these workflows, but such
an author can already push workflows that run with secrets. Taking helpers and
prompts from the base revision stops a pull request from weakening its own
review policy without visibly editing a workflow. Maintainers should review
workflow changes, and the repository's fork-approval setting should stay on.

## Bootstrap

If the base revision has no `.github/review-agents.json` (for example the pull
request that adds these files, or an umbrella pull request into a branch that
predates them), the setup job uses the configuration from the pull request head.
The run emits a `::warning::`, the step summary says BOOTSTRAP, the result
records `bootstrap: true`, and the comment shows a BOOTSTRAP notice. The normal
completion and severity rules still apply, so a bootstrap review passes only
when it completed with no blocking findings. A base revision that has
`review-agents.json` but lacks a prompt or helper fails setup; it never falls
back to the head.

## Tests

```bash
python3 -m unittest discover -s .github/scripts -p 'test_*.py' -v
shellcheck .github/scripts/*.sh
actionlint .github/workflows/*review*.yml
```

The tests need Python 3.9 or later (CI uses the runner's Python), Git and Bash. They replace `gh` and the Codex CLI
with local fakes. They cannot show that real credentials, runners or provider
models work; only a real Actions run can.
