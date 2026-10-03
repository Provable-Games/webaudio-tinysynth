#!/usr/bin/env bash
# Run the pinned Codex CLI once with the centrally configured model and effort.
#
# Usage: run-codex-review.sh CONFIG_ROOT REPO_DIR PROMPT_FILE OUT_DIR
# Environment: CODEX_BIN (pinned CLI), CODEX_HOME (fresh directory holding only
# auth.json), and the model and effort variables named in review-agents.json.
#
# Writes OUT_DIR/review.txt (final message), OUT_DIR/codex.log and
# OUT_DIR/exit-code. It exits 0 once the CLI has run, so that the result step
# can record a failed run; a setup error exits nonzero.
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: $0 CONFIG_ROOT REPO_DIR PROMPT_FILE OUT_DIR" >&2
  exit 2
fi
config_root="$1"
repo_dir="$2"
prompt_file="$3"
out_dir="$4"
: "${CODEX_BIN:?CODEX_BIN must name the pinned Codex CLI}"
: "${CODEX_HOME:?CODEX_HOME must name a fresh Codex home}"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$out_dir"
rm -f "$out_dir/review.txt" "$out_dir/exit-code"

# A config.toml (or profile) in CODEX_HOME could mark the checkout as trusted,
# which would load the pull request's own .codex/ configuration and MCP servers.
if [ ! -f "$CODEX_HOME/auth.json" ]; then
  echo "::error::CODEX_HOME has no auth.json" >&2
  exit 1
fi
if [ -n "$(find "$CODEX_HOME" -maxdepth 1 \( -name '*.toml' -o -name rules \) -print -quit)" ]; then
  echo "::error::CODEX_HOME must not contain configuration or rules" >&2
  exit 1
fi

# Build the argument list from the validated central settings (NUL-delimited).
python3 "$script_dir/review.py" codex-argv --config-root "$config_root" \
  --workdir "$repo_dir" --output "$out_dir/review.txt" > "$out_dir/argv"
args=()
while IFS= read -r -d '' arg; do
  args+=("$arg")
done < "$out_dir/argv"
if [ "${#args[@]}" -eq 0 ]; then
  echo "::error::no Codex arguments were produced" >&2
  exit 1
fi

# Only the variables Codex needs reach it and the commands it runs; the
# credential stays in CODEX_HOME/auth.json.
set +e
env -i HOME="$HOME" PATH="$PATH" CODEX_HOME="$CODEX_HOME" LANG=C.UTF-8 LC_ALL=C.UTF-8 \
  TERM=dumb NO_COLOR=1 "$CODEX_BIN" "${args[@]}" < "$prompt_file" > "$out_dir/codex.log" 2>&1
status=$?
set -e
printf '%s\n' "$status" > "$out_dir/exit-code"
echo "Codex CLI exited with status $status."
