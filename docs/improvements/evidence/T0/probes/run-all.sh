#!/usr/bin/env bash
# Run every T0 baseline probe under an external hard deadline.
#
#   docs/improvements/evidence/T0/probes/run-all.sh [output-dir]
#
# Each probe also applies vm timeouts internally; the external `timeout -s KILL`
# ensures a regression cannot lock the runner. Output: one <probe>.jsonl per
# probe and inventory.json in output-dir (default: ./t0-probe-output), plus an
# exit-status summary. stderr files are kept only when non-empty.
# embed-data-uri.js is not run here: it needs playwright-core and Chromium
# (see its header).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-./t0-probe-output}"
DEADLINE="${T0_PROBE_DEADLINE:-60}"
mkdir -p "$OUT"
status=0
for p in issue-4-unterminated-tracks issue-6-time-division issue-8-zero-duration-loop \
         issue-9-empty-song issue-10-replay-tempo issue-21-seek-state consumer-semantics; do
  start=$(date +%s)
  timeout -s KILL "$DEADLINE" node "$HERE/$p.js" > "$OUT/$p.jsonl" 2> "$OUT/$p.stderr"
  rc=$?
  [ -s "$OUT/$p.stderr" ] || rm -f -- "$OUT/$p.stderr"
  echo "$p exit=$rc ($(( $(date +%s) - start ))s)"
  [ "$rc" -ne 0 ] && status=1
done
timeout -s KILL "$DEADLINE" node "$HERE/inventory.js" > "$OUT/inventory.json" 2> "$OUT/inventory.stderr"
rc=$?
[ -s "$OUT/inventory.stderr" ] || rm -f -- "$OUT/inventory.stderr"
echo "inventory exit=$rc"
[ "$rc" -ne 0 ] && status=1
exit $status
