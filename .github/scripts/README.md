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
| `Review helper tests` (`review-helpers.yml`) | optional | Runs `test_review.py`, shellcheck, and actionlint on every workflow |

The merge gate is the pair of required gates: a HIGH finding from either
provider fails that provider's gate, so one clean provider cannot override the
other. A required-check change is a ruleset change; these workflows do not make it.

### Events

Reviews run on `opened`, `synchronize`, `reopened`, `ready_for_review`, and on
`edited` only when the base branch changed (`github.event.changes.base`), so a
retargeted pull request is reviewed against its new base. A title or body edit
starts no job and joins a separate concurrency group, so it never cancels a
review in progress. GitHub reports a job skipped by a condition as successful,
so in such a run the gate job carries a different name, "… review gate (title
or body edit, not evaluated)". It can never stand in for the required gate,
and the gate from the latest real run stays in force.

## Configuration

| Name | Kind | Use |
| --- | --- | --- |
| `CODEX_REVIEW_MODEL` | Actions variable | Codex model, passed as `codex exec -m` |
| `CODEX_REVIEW_EFFORT` | Actions variable | Codex reasoning effort, passed as `-c model_reasoning_effort="…"` |
| `CLAUDE_REVIEW_MODEL` | Actions variable | Claude model, passed as `--model` and `ANTHROPIC_MODEL` |
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
- The model each provider reports must equal the configured variable: the Codex
  CLI header and Claude's init message are checked after the run, and a
  mismatch fails the review. Configure a full model ID, not an alias such as
  `opus`, because an alias resolves to a different ID.
- Claude Code 2.1.288 ignores an unknown `--effort` value with only a warning
  and does not report effort in its transcript. The workflow therefore accepts
  only the values listed in `providers.claude.accepted_effort_levels`. That list
  is the vocabulary of the pinned CLI, not a default; update it in the same pull
  request that moves the Claude action pin. The docs say an effort the selected
  model does not support falls back to the next lower supported level, and no
  workflow can observe that. `CLAUDE_CODE_EFFORT_LEVEL` would override
  `--effort`, so the action step clears it.
- Codex sends `model_reasoning_effort` to the API without checking it locally;
  an unsupported value is expected to fail the API request. After the run, the
  result step requires the CLI header to show exactly the configured `model:`
  and `reasoning effort:`, which proves what was sent.

### Codex credential lifetime

`CODEX_AUTH_DOT_JSON` is a ChatGPT-mode `auth.json` with an access token and a
refresh token. It is organization-managed and shared with other repositories.
Each run writes it to a fresh `CODEX_HOME`. Codex may refresh the tokens during
the run, but the workflow discards that file afterwards and never writes
secrets. If the refresh token expires, is revoked, or rotates when used
elsewhere, the stored secret goes stale and every Codex review fails until an
organization admin replaces it.

The failure is explicit. The review comment reads "Review not completed: Codex
authentication failed: the org secret CODEX_AUTH_DOT_JSON needs to be refreshed
(or switch to an API-key credential)", and the `Codex review gate` fails with
the same message. The result step recognizes the pinned CLI's refresh-failure
messages ("Your access token could not be refreshed…", "Please log out and sign
in again") and HTTP `401 Unauthorized`. Any other CLI failure reports its exit
status with a hint to check the secret. The log is printed only when it contains
no credential value.

Persisting refreshed tokens back into the secret, or switching to an API-key
credential, is an organization-level decision. These workflows do neither.

## Pins

Each pin has one place:

- Codex CLI: `codex-cli/package-lock.json` (`@openai/codex` 0.160.0, with
  integrity hashes for every platform package, including linux-arm64).
  Installed with `npm ci --ignore-scripts`. To update it, run
  `npm install --package-lock-only --ignore-scripts @openai/codex@<version>` in
  `codex-cli/`, then re-check the `codex exec` flags this workflow uses.
- Claude: `anthropics/claude-code-action/base-action@<sha> # v1.0.240` in
  `claude-review.yml`. The base action installs Claude Code 2.1.288 through the
  official installer and runs it with Bun 1.3.14. When moving it, re-check
  `--effort`, `--restricted`, `--setting-sources`, `--strict-mcp-config`,
  `--tools`, the `CLAUDE_WORKING_DIR` handling, the environment variables the
  action passes through, and the execution-file format, and update
  `accepted_effort_levels`.
- Every other action is pinned to a full commit SHA with a version comment.

All jobs run on `ubuntu-24.04-arm`. Both CLIs publish linux-arm64 builds.

## Policies

| Situation | Gate |
| --- | --- |
| Draft pull request | Passes with "Review intentionally skipped: draft PR". Marking it ready runs the review. |
| Fork pull request (including a deleted fork) | Fails with "AI review unavailable for fork PRs". This public repository does not give forks secrets, and a skipped job would count as success. A maintainer must review the fork's changes manually; only code a maintainer has reviewed and trusts may be mirrored to a branch here. |
| Dependabot pull request (author or sender `dependabot[bot]`) | Fails with "AI review unavailable for Dependabot PRs". Dependabot runs receive no Actions secrets, so a maintainer reviews the update manually. Giving Dependabot review credentials (Dependabot secrets) is an organization decision. |
| Title or body edit | No review and no required check (see Events) |
| Base without review configuration | Fails setup, unless the base is `main` (see Bootstrap) |
| No changed files (git and GitHub agree) | Passes with an explicit skip notice |
| Git finds no changes but GitHub reports some | Fails: a detection failure is not an empty diff |
| Missing or invalid variable, missing secret | Fails, naming the variable or secret |
| Expired, revoked or rejected Codex credential | Fails with "Codex authentication failed: the org secret CODEX_AUTH_DOT_JSON needs to be refreshed (or switch to an API-key credential)" |
| Claude transcript without an init message, from another working directory, session or file, with a non-read-only tool, or with another model | Fails; a final result alone is never accepted |
| Trusted configuration changed during the run | Fails before any result is recorded |
| CLI failure, cancellation, timeout, missing or blank output | Fails. Partial output from a failed run is discarded, even `lgtm`. |
| Output that is not exactly `lgtm`, valid findings, or `Review incomplete: …` | Fails as incomplete; the raw text is shown in the comment |
| Output containing a credential value in any detected form | Fails; the output is withheld |
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

The policy and the last line of the prompt tell the model to start with `lgtm`
or `### [` and write nothing before, between or after the findings.
`review_lib.parse_review` is deterministic and fails closed:

- Finding headings count only outside code fences, and every field is required.
- Unknown severities, a missing line number, `lgtm` next to any other text, and
  any other heading or line that starts like a finding (a severity tag followed
  by a location, such as `**HIGH** b.js:2`) make the review incomplete,
  wherever they appear. Severity words in prose or in code examples are ignored.
- Inside a finding, list semantics apply: after a blank line, only a field
  bullet, a list item, an indented line or a code fence continues it. An
  unindented prose paragraph between or after findings makes the review
  incomplete.
- One bounded tolerance: up to three lines (500 characters) of prose before the
  first finding, without a code fence or `lgtm`, are discarded when every
  finding is valid. The result records a warning, and the comment shows the
  findings only. Models sometimes add a sentence such as "I've finished
  reading the files", and rejecting an otherwise valid review for it adds
  noise without adding safety.

## Comments

Each provider keeps one bot comment per reviewer. A comment belongs to a
provider and reviewer only if `github-actions[bot]` (type `Bot`) wrote it and
its first line is exactly the hidden marker
`<!-- tinysynth-ai-review:<provider>:<agent> -->`. Both providers post as the
same bot, so a comment that merely quotes another marker, including the other
provider's comment, is never edited or deleted. A second hidden comment records
the base, head, merge base, configuration revision, model, effort and run.

Every comment, clean or not, starts with one visible heading built from the
result record, for example:

```text
**Claude review** · model `<CLAUDE_REVIEW_MODEL>` · effort `<CLAUDE_REVIEW_EFFORT>` · head `0123456789ab`
```

It shows the requested model and effort, and adds `(resolved …)` when the
provider reported a different model ID (which also fails the review). A
bootstrap review shows a BOOTSTRAP notice below the heading. A clean review's
body is then exactly `lgtm`; findings and failures follow the same heading. The
heading is only presentation: the model's own output must still be exactly
`lgtm`, and the gate reads `result.json`, never comment or review text. A
failed or incomplete run replaces an earlier verdict with "Review not
completed", so an old `lgtm` never stays under a new head.

## Trust boundary

- The workflows use `pull_request`, not `pull_request_target`. Top-level
  permissions are empty. Review jobs have `contents: read`, and only the comment
  job has `pull-requests: write`.
- The review job runs only when the setup job chose the `review` policy and the
  head repository is this repository. Forks and Dependabot never reach a job with
  secrets.
- Configuration, prompts and helpers come from the pull request's **base
  revision**, checked out sparsely into `trusted/`. The head is checked out
  separately into `src/` with `persist-credentials: false` and is only read:
  no install scripts, hooks or helpers from the pull request run. Every helper
  runs as `python3 -I -B`, so neither the working directory, `PYTHON*`
  variables, user site-packages nor stale bytecode can supply a module.
- The review job fingerprints `trusted/.github` before the provider runs and
  verifies it afterwards; the result is recorded only if nothing changed.
- Codex runs with a fresh `CODEX_HOME` holding only `auth.json`, with
  `--ignore-user-config --ignore-rules --sandbox read-only --ephemeral` and an
  environment reduced to `HOME`, `PATH`, `CODEX_HOME`, locale and terminal
  variables. Codex reads `.env` only from `CODEX_HOME`. A trusted Codex home
  would load the pull request's `.codex/` layer, including MCP server commands.
  `-c project_doc_max_bytes=0` stops Codex loading the pull request's
  `AGENTS.md` and `AGENTS.override.md` as instructions, and
  `-c skills.include_instructions=false` keeps its `.agents/skills` and
  `.codex/skills` out of the prompt. Codex can still read those files as data.
- Before the Codex review, the sandbox must run `git`, refuse a write, and fail
  an HTTPS request to `api.github.com` that succeeds from the runner outside the
  sandbox; both curl exit codes are logged. This proves that the read-only
  sandbox blocks a TCP and TLS connection the runner itself can make. It does
  not prove that every protocol is blocked. Reads are not blocked: the sandbox
  can read `auth.json`, which is why the output is screened.
- Claude runs through the base action, so no GitHub token or GitHub tools reach
  it. The action changes into `CLAUDE_WORKING_DIR` and runs Bun there, and Bun
  loads `bunfig.toml` (including preload scripts) and `.env` files from that
  directory. `CLAUDE_WORKING_DIR` is therefore an empty trusted directory under
  `$RUNNER_TEMP`, verified empty first. The checkout and the precomputed
  context are passed to Claude with `--add-dir` as read-only data.
- Claude uses `--restricted --setting-sources user --strict-mcp-config
  --permission-mode dontAsk --tools Read,Glob,Grep`, so project settings, hooks,
  `CLAUDE.md`, `CLAUDE.local.md`, `.claude/` rules, skills, commands and agents,
  and `.mcp.json` servers from the pull request do not load. `--setting-sources`
  must stay `user`: the base action treats an empty value as absent and loads
  every source.
- The action step presets every variable it would pass through:
  - `ANTHROPIC_MODEL` is set to the validated model.
  - `CLAUDE_CODE_EFFORT_LEVEL` is cleared.
  - `CLAUDE_CONFIG_DIR` is set to `~/.claude`.
  - Auto memory is disabled, and `CLAUDE.md` loading from added directories is
    off.
  - The proxy variables, `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `BUN_OPTIONS`
    and the Bun registry settings are cleared.
- The result step fails the review if Claude's init message is missing, reports
  another working directory, session or model, or reports any tool that runs
  commands, writes, delegates or reaches the network. It also fails if the
  execution file is not the action's own output file.
- The pull request title and body are read from the event file and placed
  between random delimiters as untrusted data. They are never interpolated into
  shell code.
- Before upload, the result step withholds any output that contains a secret
  value or one of its long string leaves. It checks the literal, JSON-escaped,
  reversed, hex (both cases), and standard and URL-safe base64 forms at every
  byte alignment, also after removing whitespace, and includes refreshed Codex
  tokens. Residual risk: a copy split into pieces with other characters between
  them, a partial copy, or another encoding is not detected. Only `result.json`
  and the review text are uploaded, for one day.
- The comment job checks the current head through the API before writing, and
  runs the base revision's helpers without secrets.

Under `pull_request`, GitHub runs the workflow YAML from the pull request merge
commit. A same-repository author can therefore change these workflows, but such
an author can already push workflows that run with secrets. A fork pull request
gets no secrets, but its own edited workflow runs and can report a passing
check named `Codex review gate` or `Claude review gate`. Taking helpers and
prompts from the base revision stops a pull request from weakening its own
review policy without visibly editing a workflow. Recommended settings, which
these workflows do not change:

- Keep "Require approval for all outside collaborators" (or stricter) for fork
  pull request workflows.
- Require the two gates in the `main` ruleset with GitHub Actions as the
  expected source.
- Require code-owner review of `.github/**` (a `CODEOWNERS` entry plus a
  ruleset rule).

## Bootstrap

A base revision without `.github/review-agents.json` normally fails setup with
"Base branch '…' has no .github/review-agents.json. Bootstrap from the pull
request head is allowed only for: main." The one exception
(`BOOTSTRAP_BASE_BRANCHES: main` in both workflows) is the one-time path by
which the review configuration reaches `main`: a pull request into `main`
while `main` lacks it uses the configuration from the pull request head. The
run emits a `::warning::`, the step summary says BOOTSTRAP, the result records
`bootstrap: true`, and the comment shows a BOOTSTRAP notice. The normal
completion and severity rules still apply. Once `main` carries the
configuration, the exception no longer applies and can be removed. A base
revision that has `review-agents.json` but lacks a prompt or helper fails setup;
it never falls back to the head.

## Tests

```bash
python3 -I -B -m unittest discover -s .github/scripts -p 'test_*.py' -v
shellcheck .github/scripts/*.sh
actionlint .github/workflows/*.yml
```

The tests need Python 3.9 or later (CI uses the runner's Python), Git and Bash. They replace `gh` and the Codex CLI
with local fakes. Set `REVIEW_TEST_BUN` to a Bun 1.3.14 binary to also run the
test showing that the action's Bun step loads no `bunfig.toml` or `.env` from
the checkout. The tests cannot show that real credentials, runners or provider
models work; only a real Actions run can.
