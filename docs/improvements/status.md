# Improvement status

Supervisor-owned. After a context reset, read this file, then [contracts.md](contracts.md), then the newest entries of [decisions.md](decisions.md).

## Baseline

- Repository: `Provable-Games/webaudio-tinysynth`, default branch `main`.
- Baseline: `b70ba90d63c5ea657cb67ca98de90d7f778c29bd` (= `origin/main`, verified 2026-10-02).
- Integration branch: `improve/integration` (worktree `/workspace/webaudio-tinysynth-worktrees/integration`).
- Evidence root (not in the repo): `/workspace/webaudio-tinysynth-worktrees/_evidence/`.
- Remote actions: task branches may be pushed and PRs opened; no GitHub merges, releases, tags, or ruleset/secret changes (D-002).

## Baseline artifact (T0)

| File | sha256 | Raw / gzip -9 bytes |
| --- | --- | --- |
| `webaudio-tinysynth.js` | `abb2d0fb828ada86…` | 54,000 / 11,765 |
| `webaudio-tinysynth.min.js` | `5aa3edbc13371694…` | 37,060 / 9,444 |
| `webaudio-tinysynth.min.js.map` | `fd7f64190db21526…` | 59,637 / 11,423 |

The rebuild with Terser 5.51.2 and the current flags is byte-identical. The minified file has no `sourceMappingURL` and no trailing newline, and contains no `</script`, `<script` or `<!--` sequence and no non-ASCII bytes. `npm test` passes in 44 s. Full hashes are in `evidence/T0/baseline.json`.

## Task state

States: `pending`, `running`, `review`, `accepted`, `blocked`.

| Task | Issues | Branch / worktree | Base | State | Accepted commit | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| T0 | #16 (baseline), #7/#21/#26/#27 contracts | `t0/baseline` | b70ba90 | accepted | c2252bc | Policy decisions D-004 to D-007 and D-010; evidence in tasks/T0.md |
| T1 | #5 #15 #16 #22 #23 #24 #25 | tooling: `t1/tooling`; AI review: `t1/ai-review` | 1e6184c | running | | Tooling running. AI review in review: local work complete (1f17527), PR #28 bootstrap run pending. Initial CI gate G0 |
| T9A | #19 #20 (read-only audit) | `t9/audit` | 1e6184c | accepted | 3e9d013 | Findings and T9 plan in tasks/T9A.md; D-011 |
| T2 | #4 #6 | `t2/parser` | after G0 | pending | | |
| T3 | #8 #9 #10 #21 | `t3/transport` | after T2 | pending | | D-005 |
| T4 | #11 #12 | `t4/lifecycle` | after T3 | pending | | |
| T5 | #13 #14 | `t5/api` | after T4 | pending | | |
| T6 | #16 #7 (validation) | `t6/validation` | after T1–T5 | pending | | Gate G1 |
| T7 | #17 | `t7/architecture` | after G1 | pending | | |
| T8 | #7 #18 | `t8/performance` | after T7 | pending | | D-004 |
| T11 | #26 | `t11/waveforms` | after T8 | pending | | D-006 |
| T12 | #27 | `t12/filters` | after T11 | pending | | D-007 |
| T9 | #19 #20, docs for #26/#27 | `t9/docs` | after T7; accepts after T12 | pending | | |
| T1B | later CI extensions | `t1/ci-ext` | after T6/T7/T12 | pending | | |
| T10 | all (independent verification) | `t10/verify` | after T8 T9 T1B T11 T12 | pending | | Gate G2 |

## Gates

| Gate | Requirement | State |
| --- | --- | --- |
| G0 initial CI | Lint, Vitest, native Node tests, retained regressions, build verification, offline Playwright smoke, AI review workflows with central model/effort; a real Actions run | review. The independent review (`03003e9`) accepts #15, #16-initial, #22 and #23. It accepts #5 and #24 with M4, and rejects #25 at 1eff7ba (H1). Fixes are in progress (D-014). Afterwards: re-review, a real run, and a trusted-path (non-bootstrap) run. |
| G1 reliability | T1 foundation plus T2–T6 accepted; source and minified validation pass | pending |
| G2 delivery | All registered criteria verified; T10 independent review; consumer artifact/hash handoff | pending |

## Risks and blockers

- Hosted ARM Playwright is verified: the arm64 Chromium headless shell ran in CI, so no x64 exception is needed.
- G0 remote evidence so far:
  - PR #29 (`t1/tooling` c76bb81): CI run 37091100129 passed all jobs on `ubuntu-24.04-arm` (lint 10 s, build-verify 9 s, test 154 s, browser-smoke 49 s). The browser job ran the arm64 Chrome Headless Shell 153.0.8010.12 build.
  - PR #28 (`t1/ai-review` 1f17527): Review Helpers, Claude Review (lgtm) and Codex Review (two MEDIUM findings) all completed successfully in bootstrap mode. Both findings were fixed (e9e31e6). The rerun at e9e31e6 passed (Review Helpers, Claude, Codex), and both bot comments were updated in place (same IDs 5964758179 and 5964792024) with the D-012 heading. Round-two MEDIUM findings: a missing Claude init message, and Codex ChatGPT credential rotation (an org-level secret concern) are being fixed or documented.
  - PR #29 rerun at f40de89: CI passed.
- The ruleset has no required status checks. Making the new gates required is a ruleset change that needs user authorization (D-002).
- The org variable `CODEX_CLI_VERSION=latest` is ignored in favor of an in-repo pin (D-009).

## Next actions

1. (done) T0 accepted and merged.
2. (running) T1 tooling, T1 AI review and the T9A audit.
3. Push `improve/integration` and open the umbrella draft PR once T1 workflows exist.
