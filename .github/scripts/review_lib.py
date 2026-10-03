"""Shared logic for the Codex and Claude review workflows.

Standard library only. The workflows run this file from a trusted staging
directory (the pull request's base revision), never from the reviewed checkout.
"""

import base64
import json
import re
import shlex
import subprocess
from pathlib import Path

SEVERITIES = ("CRITICAL", "HIGH", "MEDIUM", "LOW")
PROVIDERS = ("codex", "claude")
FINDING_FIELDS = ("Evidence/trigger", "Impact", "Recommended action")
MARKER_PREFIX = "tinysynth-ai-review"
BOT_LOGIN = "github-actions[bot]"
MAX_COMMENT_CHARS = 60000

AGENT_ID_RE = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
VARIABLE_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}(\[[A-Za-z0-9]{1,16}\])?$")
EFFORT_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
PROMPT_DIR = ".github/prompts/"

FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
FINDING_RE = re.compile(r"^### \[([A-Z]+)\] (\S.*?):(\d+)(?:-(\d+))? (?:—|–|-) (\S.*?)\s*$")
# Any other Markdown heading, or a line that starts like a finding (a severity tag
# followed by a location) without the exact heading form, makes the review malformed.
ATX_HEADING_RE = re.compile(r"^ {0,3}#{1,6}(\s|$)")
PSEUDO_FINDING_RE = re.compile(r"^\s*(?:[-*+]\s+)?(?:\*\*|__)?\[?(?:CRITICAL|HIGH|MEDIUM|LOW)\]?(?:\*\*|__)?:?\s+\S+:\d+")
LIST_ITEM_RE = re.compile(r"^(?:[-*+]|\d{1,9}[.)])\s")
MAX_PREAMBLE_LINES = 3
MAX_PREAMBLE_CHARS = 500
FIELD_RE = re.compile(r"^- \*\*(" + "|".join(re.escape(f) for f in FINDING_FIELDS) + r"):\*\*(.*)$")


CODEX_AUTH_FAILURE = ("Codex authentication failed: the org secret CODEX_AUTH_DOT_JSON needs to be refreshed "
                      "(or switch to an API-key credential)")
# Authentication signatures printed by the pinned Codex CLI: its refresh-failure
# messages (codex-rs/login/src/auth/manager.rs at rust-v0.160.0) and HTTP 401.
CODEX_AUTH_RE = re.compile(r"Your access token could not be refreshed|Please (log out and )?sign in again"
                           r"|\b401 Unauthorized\b")


class ReviewError(Exception):
    """A configuration, input or detection problem. Messages are safe to print."""


# ---------------------------------------------------------------------------
# Trusted configuration


def _relative_prompt_path(value, what):
    if not isinstance(value, str) or not value.startswith(PROMPT_DIR) or not value.endswith(".md"):
        raise ReviewError(f"{what} must be a Markdown file under {PROMPT_DIR}: {value!r}")
    if ".." in Path(value).parts or "\\" in value:
        raise ReviewError(f"{what} must not leave {PROMPT_DIR}: {value!r}")
    return value


def load_config(config_root):
    """Load and validate .github/review-agents.json from a staged config root."""
    root = Path(config_root)
    path = root / ".github" / "review-agents.json"
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ReviewError(f"review configuration not found: {path}") from None
    except (OSError, json.JSONDecodeError) as error:
        raise ReviewError(f"review configuration is unreadable: {error}") from None
    if not isinstance(config, dict) or config.get("schema_version") != 1:
        raise ReviewError("review-agents.json must be an object with schema_version 1")

    policy = _relative_prompt_path(config.get("policy_file"), "policy_file")
    if not (root / policy).is_file():
        raise ReviewError(f"policy_file is missing from the staged configuration: {policy}")

    blocking = config.get("blocking_severities")
    if not isinstance(blocking, list) or not blocking or any(s not in SEVERITIES for s in blocking):
        raise ReviewError(f"blocking_severities must be a non-empty subset of {list(SEVERITIES)}")

    agents = config.get("agents")
    if not isinstance(agents, list) or not agents:
        raise ReviewError("agents must be a non-empty list")
    seen = set()
    for agent in agents:
        agent_id = agent.get("agent_id") if isinstance(agent, dict) else None
        if not isinstance(agent_id, str) or not AGENT_ID_RE.fullmatch(agent_id) or agent_id in seen:
            raise ReviewError(f"agent_id must be a unique lowercase slug: {agent_id!r}")
        seen.add(agent_id)
        if not isinstance(agent.get("agent_name"), str) or not agent["agent_name"].strip():
            raise ReviewError(f"agent {agent_id} needs an agent_name")
        prompt = _relative_prompt_path(agent.get("prompt_file"), f"agent {agent_id} prompt_file")
        if not (root / prompt).is_file():
            raise ReviewError(f"agent {agent_id} prompt is missing from the staged configuration: {prompt}")
        paths = agent.get("diff_paths")
        if not isinstance(paths, list) or not paths or not all(isinstance(p, str) and p for p in paths):
            raise ReviewError(f"agent {agent_id} needs a non-empty diff_paths list")

    providers = config.get("providers")
    if not isinstance(providers, dict) or set(providers) != set(PROVIDERS):
        raise ReviewError(f"providers must define exactly {list(PROVIDERS)}")
    for name, provider in providers.items():
        for key in ("model_variable", "effort_variable"):
            if not isinstance(provider.get(key), str) or not VARIABLE_RE.fullmatch(provider[key]):
                raise ReviewError(f"providers.{name}.{key} must be an Actions variable name")
        if not isinstance(provider.get("display_name"), str) or not provider["display_name"]:
            raise ReviewError(f"providers.{name}.display_name is required")
        levels = provider.get("accepted_effort_levels")
        if levels is not None and (not isinstance(levels, list) or not levels
                                   or not all(isinstance(v, str) and EFFORT_RE.fullmatch(v) for v in levels)):
            raise ReviewError(f"providers.{name}.accepted_effort_levels must be null or a list of levels")
    return config


def agent_by_id(config, agent_id):
    for agent in config["agents"]:
        if agent["agent_id"] == agent_id:
            return agent
    raise ReviewError(f"unknown agent_id: {agent_id!r}")


def is_metadata_edit(event):
    """An `edited` event that did not change the base: no review, no gate.

    Mirrors the workflows' guard
    `github.event.action == 'edited' && !github.event.changes.base`.
    """
    return event.get("action") == "edited" and not (event.get("changes") or {}).get("base")


def in_scope(path, diff_paths):
    """'.' covers everything, a trailing '/' is a directory prefix, anything else is exact."""
    for scope in diff_paths:
        if scope == "." or (scope.endswith("/") and path.startswith(scope)) or path == scope:
            return True
    return False


# ---------------------------------------------------------------------------
# Central model and effort settings


def resolve_settings(provider, config, env):
    """Return the validated model and effort for a provider from Actions variables.

    There are no defaults: a missing or invalid variable is an error that names it.
    """
    spec = config["providers"][provider]
    model_var, effort_var = spec["model_variable"], spec["effort_variable"]
    model, effort = env.get(model_var, ""), env.get(effort_var, "")
    errors = []
    if not model:
        errors.append(f"{model_var} is not set; define it as an organization or repository Actions variable")
    elif not MODEL_RE.fullmatch(model):
        errors.append(f"{model_var} has an invalid format ({model[:80]!r}); expected a model ID such as letters, "
                      "digits and . _ : @ / - with an optional [suffix], without spaces")
    if not effort:
        errors.append(f"{effort_var} is not set; define it as an organization or repository Actions variable")
    elif not EFFORT_RE.fullmatch(effort):
        errors.append(f"{effort_var} has an invalid format ({effort[:80]!r}); expected a lowercase effort level")
    elif spec.get("accepted_effort_levels") is not None and effort not in spec["accepted_effort_levels"]:
        errors.append(f"{effort_var}={effort!r} is not accepted by the pinned {spec['display_name']} CLI, "
                      f"which would silently ignore it; accepted: {', '.join(spec['accepted_effort_levels'])}")
    if errors:
        raise ReviewError("; ".join(errors))
    return {"model": model, "effort": effort, "model_variable": model_var, "effort_variable": effort_var}


def classify_codex_failure(exit_code, log):
    """Explain a nonzero Codex exit. The log is matched, never quoted."""
    if CODEX_AUTH_RE.search(log or ""):
        return CODEX_AUTH_FAILURE
    return (f"the Codex CLI exited with status {exit_code}; if its log shows an authentication error, "
            "the org secret CODEX_AUTH_DOT_JSON may need to be refreshed")


def codex_argv(settings, workdir, output_file):
    """Arguments for `codex exec`. The prompt is read from stdin ('-').

    project_doc_max_bytes=0 stops Codex loading AGENTS.md and AGENTS.override.md
    from the checkout as instructions, and skills.include_instructions=false keeps
    repository skills out of the prompt. The files stay readable as review data.
    """
    return [
        "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules",
        "--sandbox", "read-only", "--color", "never",
        "-m", settings["model"],
        "-c", f'model_reasoning_effort="{settings["effort"]}"',
        "-c", 'approval_policy="never"',
        "-c", "project_doc_max_bytes=0",
        "-c", "skills.include_instructions=false",
        "-C", str(workdir), "-o", str(output_file), "-",
    ]


def claude_args(settings, add_dirs):
    """The claude_args input for the pinned base action (parsed with shell quoting).

    --setting-sources user (and, independently, --restricted) stops Claude Code
    loading the checkout's CLAUDE.md, CLAUDE.local.md, .claude/ settings, hooks,
    rules, skills, commands and agents. The value must not be empty: the base
    action treats an empty --setting-sources as absent and loads every source.
    """
    parts = [
        "--model", settings["model"], "--effort", settings["effort"],
        "--restricted", "--setting-sources", "user", "--strict-mcp-config",
        "--permission-mode", "dontAsk",
        "--tools", "Read,Glob,Grep", "--allowedTools", "Read,Glob,Grep",
    ]
    for directory in add_dirs:
        parts += ["--add-dir", str(directory)]
    return " ".join(shlex.quote(part) for part in parts)


# ---------------------------------------------------------------------------
# Review output contract


def parse_review(text):
    """Classify review text deterministically.

    Returns a dict with kind in {"lgtm", "findings", "incomplete", "malformed"},
    the validated findings, parse errors, warnings, and the findings text. Severity
    tags count only in exact finding headings outside code fences. Within a
    finding, list semantics apply: after a blank line, only field bullets, list
    items, indented lines and code fences continue it, so prose between or after
    findings is rejected. Up to MAX_PREAMBLE_LINES of prose before the first
    finding are discarded with a warning, and only when every finding is valid.
    """
    stripped = (text or "").strip()
    if not stripped:
        return {"kind": "malformed", "findings": [], "errors": ["the review output is empty"], "warnings": [],
                "body": ""}
    if stripped == "lgtm":
        return {"kind": "lgtm", "findings": [], "errors": [], "warnings": [], "body": "lgtm"}
    lines = stripped.splitlines()
    if lines[0].startswith("Review incomplete:"):
        return {"kind": "incomplete", "findings": [], "errors": [lines[0][:300]], "warnings": [], "body": ""}

    findings, errors, warnings, preamble = [], [], [], []
    current, field, fence = None, None, None
    preamble_fence, first_heading, previous_blank = False, None, False

    def continue_field(number, line):
        if current is None:
            if line.strip():
                preamble.append(number)
        elif field is not None:
            current["fields"][field] += "\n" + line
        elif line.strip():
            errors.append(f"line {number}: text before the first field of a finding")

    for index, line in enumerate(lines):
        number = index + 1
        fence_match = FENCE_RE.match(line)
        if fence is not None:
            marker_text = fence_match.group(1) if fence_match else ""
            if marker_text and marker_text[0] == fence[0] and len(marker_text) >= len(fence) \
                    and not line.strip()[len(marker_text):].strip():
                fence = None
            continue_field(number, line)
            previous_blank = False
            continue
        if fence_match:
            fence = fence_match.group(1)
            preamble_fence = preamble_fence or current is None
            continue_field(number, line)
            previous_blank = False
            continue
        heading = FINDING_RE.match(line)
        if heading:
            severity = heading.group(1)
            if severity not in SEVERITIES:
                errors.append(f"line {number}: unknown severity {severity!r}")
            current = {
                "severity": severity, "path": heading.group(2), "line": int(heading.group(3)),
                "end_line": int(heading.group(4)) if heading.group(4) else None,
                "title": heading.group(5), "fields": {},
            }
            findings.append(current)
            field, previous_blank = None, False
            first_heading = index if first_heading is None else first_heading
            if current["path"].startswith("/") or ".." in current["path"].split("/"):
                errors.append(f"line {number}: finding path must be repository-relative")
            continue
        if ATX_HEADING_RE.match(line) or PSEUDO_FINDING_RE.match(line):
            errors.append(f"line {number}: malformed finding heading {line[:120]!r}")
            previous_blank = False
            continue
        if line.strip() == "lgtm":
            errors.append(f"line {number}: 'lgtm' cannot accompany findings or other text")
            previous_blank = False
            continue
        field_match = FIELD_RE.match(line)
        if current is not None and field_match:
            field = field_match.group(1)
            if field in current["fields"]:
                errors.append(f"line {number}: duplicate field {field!r}")
            current["fields"][field] = field_match.group(2).strip()
            previous_blank = False
            continue
        if not line.strip():
            if current is not None and field is not None:
                current["fields"][field] += "\n"
            previous_blank = True
            continue
        if current is not None and previous_blank and not (
                line.startswith(("  ", "\t")) or LIST_ITEM_RE.match(line)):
            errors.append(f"line {number}: prose between or after findings")
        else:
            continue_field(number, line)
        previous_blank = False
    if fence is not None:
        errors.append("unterminated code block")
    if not findings and not errors:
        errors.append("the output is neither 'lgtm' nor findings")
    records = []
    for finding in findings:
        fields = {name: value.strip() for name, value in finding.pop("fields").items()}
        missing = [name for name in FINDING_FIELDS if not fields.get(name)]
        if missing:
            errors.append(f"finding {finding['path']}:{finding['line']} lacks {', '.join(missing)}")
        records.append(finding | {
            "evidence": fields.get("Evidence/trigger", ""),
            "impact": fields.get("Impact", ""),
            "action": fields.get("Recommended action", ""),
        })
    if preamble:
        size = sum(len(lines[n - 1]) for n in preamble)
        if errors or not records or preamble_fence or len(preamble) > MAX_PREAMBLE_LINES \
                or size > MAX_PREAMBLE_CHARS:
            errors.append(f"text outside findings at line {preamble[0]}")
        else:
            warnings.append(f"discarded {len(preamble)} line(s) of text before the first finding")
    if errors:
        return {"kind": "malformed", "findings": records, "errors": errors, "warnings": [], "body": ""}
    body = "\n".join(lines[first_heading:])
    return {"kind": "findings", "findings": records, "errors": [], "warnings": warnings, "body": body}


def build_result(*, identity, execution_ok, execution_errors, text, blocking_severities):
    """Combine execution status and review text into one result record.

    Execution status is tracked separately from the text: a failed run is never
    a completed review, whatever partial output it left behind.
    """
    result = dict(identity)
    result.update({"schema": 1, "status": "failed", "verdict": None, "findings": [],
                   "blocking": False, "errors": list(execution_errors)})
    if not execution_ok:
        if (text or "").strip():
            result["errors"].append("partial output from the failed run was discarded")
        return result
    if not (text or "").strip():
        result["errors"].append("the provider produced no final review output")
        return result
    parsed = parse_review(text)
    result["findings"] = parsed["findings"]
    result["warnings"] = parsed["warnings"]
    if parsed["kind"] == "lgtm":
        result.update(status="complete", verdict="lgtm")
    elif parsed["kind"] == "findings":
        result.update(status="complete", verdict="findings")
        result["blocking"] = any(f["severity"] in blocking_severities for f in parsed["findings"])
    else:
        result["status"] = "incomplete"
        result["errors"].extend(parsed["errors"])
    return result


# ---------------------------------------------------------------------------
# Credential leak guard


def credential_values(sources):
    """Literal credential strings: each raw value plus long string leaves of JSON values."""
    values = set()

    def collect(node):
        if isinstance(node, dict):
            for item in node.values():
                collect(item)
        elif isinstance(node, list):
            for item in node:
                collect(item)
        elif isinstance(node, str) and len(node) >= 20:
            values.add(node)

    for source in sources:
        if not source:
            continue
        values.add(source)
        try:
            collect(json.loads(source))
        except (json.JSONDecodeError, RecursionError):
            pass
    return values


def encoded_forms(value):
    """Literal, JSON-escaped, reversed, hex and base64 (standard and URL-safe) forms of a value.

    Base64 depends on alignment, so each of the three byte offsets contributes the
    part of its encoding that does not mix with unknown neighbouring bytes.
    """
    data = value.encode("utf-8")
    forms = {value, json.dumps(value)[1:-1], value[::-1], data.hex(), data.hex().upper()}
    for offset in range(3):
        encoded = base64.b64encode(b"\0" * offset + data).decode("ascii").rstrip("=")
        core = encoded[4 if offset else 0:len(encoded) - 4]
        forms.update({core, core.translate(str.maketrans("+/", "-_"))})
    return {form for form in forms if len(form) >= 16}


def contains_credential(text, values):
    """True if text contains a credential in any form from encoded_forms, also after removing whitespace."""
    if not text:
        return False
    compact = re.sub(r"\s+", "", text)
    for value in values:
        for form in encoded_forms(value):
            if form in text or form in compact:
                return True
    return False


# ---------------------------------------------------------------------------
# Comment rendering


def marker(provider, agent_id):
    return f"<!-- {MARKER_PREFIX}:{provider}:{agent_id} -->"


def owns_comment(comment, mark):
    """A comment is ours only if the bot wrote it and its first line is exactly the marker.

    Both providers post as the same bot, so a substring match would let one
    provider's comment that quotes another marker be updated or deleted.
    """
    user = comment.get("user") or {}
    lines = (comment.get("body") or "").splitlines()
    return user.get("login") == BOT_LOGIN and user.get("type") == "Bot" and bool(lines) and lines[0] == mark


def _metadata(result):
    keys = ("provider", "agent_id", "repository", "pr_number", "base_sha", "head_sha", "merge_base",
            "config_sha", "bootstrap", "model", "effort", "resolved_model", "permission_mode", "status", "verdict",
            "blocking", "run_url")
    # An HTML comment cannot contain "--"; JSON-escape the second hyphen.
    data = json.dumps({k: result.get(k) for k in keys}, sort_keys=True).replace("--", "-\\u002d")
    return f"<!-- {MARKER_PREFIX}-meta {data} -->"


def _inline(value):
    """Render a recorded value inside inline code without breaking the Markdown."""
    if value is None or value == "":
        return "unknown"
    text = " ".join(str(value).replace("`", "'").split())[:128]
    return f"`{text}`"


def heading(result, display_name):
    """The visible source line: provider, requested model and effort, and head."""
    line = (f"**{display_name} review** · model {_inline(result.get('model'))} · "
            f"effort {_inline(result.get('effort'))} · head {_inline((result.get('head_sha') or '')[:12])}")
    resolved = result.get("resolved_model")
    if resolved and resolved != result.get("model"):
        line += f" (resolved {_inline(resolved)})"
    return line


def render_comment(result, review_text, display_name):
    """One bot-owned comment per provider and agent.

    Every comment shows which provider, model and effort produced it. A clean
    review's body is exactly lgtm. The gate reads result records, never this text.
    """
    lines = [marker(result["provider"], result["agent_id"]), _metadata(result), heading(result, display_name), ""]
    if result.get("bootstrap"):
        lines.append("> **BOOTSTRAP:** the base revision has no review configuration, so this review "
                     "used the configuration from the pull request head.")
        lines.append("")
    body = review_text or ""
    if result["status"] == "complete" and result["verdict"] == "lgtm":
        lines.append("lgtm")
    elif result["status"] == "complete":
        lines.append(body.strip())
    else:
        reasons = "; ".join(result.get("errors") or ["unknown error"])
        lines.append(f"**Review not completed:** {reasons}")
        lines.append("")
        lines.append("This is not an approval. The review gate fails until a complete review exists for this head.")
        if body.strip():
            lines += ["", "<details><summary>Unvalidated review output</summary>", "", body.strip(), "", "</details>"]
    comment = "\n".join(lines) + "\n"
    if len(comment) > MAX_COMMENT_CHARS:
        notice = "\n\n**Output truncated to fit a GitHub comment.** The gate used the full parsed result.\n"
        comment = comment[:MAX_COMMENT_CHARS - len(notice)] + notice
    return comment


# ---------------------------------------------------------------------------
# Gate


def evaluate_gate(*, policy, upstream, expected, results, event_head, event_base, blocking_severities):
    """Decide the stable gate. Returns (passed, messages).

    upstream maps job names to their results; expected lists (provider, agent_id)
    pairs; results maps the same pairs to loaded result records (or None).
    """
    if upstream.get("prepare") != "success":
        return False, [f"Review setup did not succeed (prepare job: {upstream.get('prepare') or 'unknown'})."]
    if policy == "fork":
        return False, ["AI review unavailable for fork PRs: this public repository does not give review "
                       "credentials to forks. A maintainer must review the fork's changes manually; only code a "
                       "maintainer has reviewed and trusts may be mirrored to a branch in this repository."]
    if policy == "dependabot":
        return False, ["AI review unavailable for Dependabot PRs: Dependabot runs receive no Actions secrets. "
                       "A maintainer must review the update manually; giving Dependabot review credentials is an "
                       "organization decision."]
    if policy == "metadata-edit":
        return False, ["A title or body edit is not evaluated; the gate of the latest review run stands."]
    if policy == "draft":
        return True, ["Review intentionally skipped: draft PR. Marking it ready for review runs the review."]
    if policy == "no-changes":
        return True, ["Review intentionally skipped: the pull request changes no files in reviewer scope."]
    if policy != "review":
        return False, [f"Unknown review policy {policy!r}."]
    messages, passed = [], True
    for job in ("review", "publish"):
        if upstream.get(job) != "success":
            passed = False
            messages.append(f"The {job} job did not succeed ({upstream.get(job) or 'unknown'}).")
    if not expected:
        return False, messages + ["No reviewer was expected although the policy requires a review."]
    for provider, agent_id in expected:
        label = f"{provider}/{agent_id}"
        result = results.get((provider, agent_id))
        if result is None:
            passed = False
            messages.append(f"{label}: no review result was produced.")
            continue
        if result.get("head_sha") != event_head or result.get("base_sha") != event_base:
            passed = False
            messages.append(f"{label}: result is for base {result.get('base_sha')} head {result.get('head_sha')}, "
                            f"not this event's base {event_base} head {event_head} (stale).")
            continue
        if result.get("status") != "complete":
            passed = False
            reasons = "; ".join(result.get("errors") or []) or "no reason recorded"
            messages.append(f"{label}: review {result.get('status')}: {reasons}")
            continue
        blocking = [f for f in result.get("findings", []) if f.get("severity") in blocking_severities]
        advisory = [f for f in result.get("findings", []) if f.get("severity") not in blocking_severities]
        for finding in blocking:
            passed = False
            messages.append(f"{label}: blocking {finding['severity']} finding at "
                            f"{finding['path']}:{finding['line']}: {finding['title']}")
        if advisory:
            messages.append(f"{label}: {len(advisory)} advisory finding(s) (MEDIUM/LOW) do not block merging.")
        for warning in result.get("warnings") or []:
            messages.append(f"{label}: warning: {warning}")
        if result.get("bootstrap"):
            messages.append(f"{label}: BOOTSTRAP review used the pull request head's review configuration.")
        if not blocking:
            messages.append(f"{label}: review completed ({result.get('verdict')}).")
    return passed, messages


# ---------------------------------------------------------------------------
# Git helpers


def git(repo_dir, *args, binary=False):
    completed = subprocess.run(["git", "-C", str(repo_dir), "-c", "core.quotePath=false", *args],
                               capture_output=True, check=False)
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", "replace").strip()[:500]
        raise ReviewError(f"git {' '.join(args[:3])} failed: {detail}")
    return completed.stdout if binary else completed.stdout.decode("utf-8", "replace")


def merge_base(repo_dir, base_sha, head_sha):
    for sha in (base_sha, head_sha):
        if not SHA_RE.fullmatch(sha or ""):
            raise ReviewError(f"invalid commit SHA {sha!r}")
        git(repo_dir, "cat-file", "-e", f"{sha}^{{commit}}")
    value = git(repo_dir, "merge-base", base_sha, head_sha).strip()
    if not SHA_RE.fullmatch(value):
        raise ReviewError("could not determine the merge base")
    return value


def changed_paths(repo_dir, merge_base_sha, head_sha):
    """Both sides of renames, NUL-delimited, so no filename is split or lost."""
    raw = git(repo_dir, "diff", "--no-renames", "--name-only", "-z", merge_base_sha, head_sha, binary=True)
    return sorted({p.decode("utf-8", "surrogateescape") for p in raw.split(b"\0") if p})
