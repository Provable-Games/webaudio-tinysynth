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
| T1 | #5 #15 #16 #22 #23 #24 #25 | tooling: `t1/tooling`; AI review: `t1/ai-review` | 1e6184c | accepted | 5457966, 866f6a1 | Integrated at f01ca19. Independent review accepted every criterion (`tasks/G0-review.md`, 0b980fa). |
| T9A | #19 #20 (read-only audit) | `t9/audit` | 1e6184c | accepted | 3e9d013 | Findings and T9 plan in tasks/T9A.md; D-011 |
| T2 | #4 #6 | `t2/parser` | 25d2a3d | accepted | cdb2228 (merge e128330) | The independent review accepted after fuzzing about 940k cases (`tasks/T2-review.md`). PR #32 was green at 4efcd64 with Codex and Claude `lgtm`. min.js is `45cc9778…`, 36,975 / 9,875 B (+1.66 % raw / +4.81 % gzip vs 782e9b92). D-013 and D-016. |
| T3 | #8 #9 #10 #21 | `t3/transport` | after T2 | pending | | D-005 |
| T4 | #11 #12 | `t4/lifecycle` | after T3 | pending | | |
| T5 | #13 #14 | `t5/api` | after T4 | pending | | |
| T6 | #16 #7 (validation) | `t6/validation` | 25d2a3d | review (phase A, PR #33: matrix green on arm64; three Codex MEDIUM test-strength fixes in progress) | | Infrastructure and baseline characterization now; phase B assertions after T5. Assignment: `_evidence/assignments/T6A.md` |
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
| G0 initial CI | Lint, Vitest, native Node tests, retained regressions, build verification, offline Playwright smoke, AI review workflows with central model/effort; a real Actions run | **accepted** 2026-10-03. The trusted path was verified on PR #30: CI 37095012463, Claude 37095012532 and Codex 37095012496, both `lgtm`. A title-only edit produced skipped runs with non-required names. Limitations are recorded in validation.md. |
| G1 reliability | T1 foundation plus T2–T6 accepted; source and minified validation pass | pending |
| G2 delivery | All registered criteria verified; T10 independent review; consumer artifact/hash handoff | pending |

## G0 integration (f01ca19)

Local checks at f01ca19 all exit 0: `npm ci`, lint, verify, `pack:check`, `npm test` (unit 30/30, node 33/33, regressions 3/3), `test:browser` (both builds, both fixtures), and 71 review-helper tests. A rebuild is drift-free. The min.js is `782e9b92…`, 36,372 / 9,422 B (ledger L-13).

## Risks and blockers

- Hosted ARM Playwright is verified: the arm64 Chromium headless shell ran in CI, so no x64 exception is needed.
- G0 remote evidence so far:
  - PR #29 (`t1/tooling` c76bb81): CI run 37091100129 passed all jobs on `ubuntu-24.04-arm` (lint 10 s, build-verify 9 s, test 154 s, browser-smoke 49 s). The browser job ran the arm64 Chrome Headless Shell 153.0.8010.12 build.
  - PR #28 (`t1/ai-review` 1f17527): Review Helpers, Claude Review (lgtm) and Codex Review (two MEDIUM findings) all completed successfully in bootstrap mode. Both findings were fixed (e9e31e6). The rerun at e9e31e6 passed (Review Helpers, Claude, Codex), and both bot comments were updated in place (same IDs 5964758179 and 5964792024) with the D-012 heading. Round-two MEDIUM findings: a missing Claude init message, and Codex ChatGPT credential rotation (an org-level secret concern) are being fixed or documented.
  - PR #29 rerun at f40de89: CI passed.
- The ruleset has no required status checks. Making the new gates required is a ruleset change that needs user authorization (D-002).
- The org variable `CODEX_CLI_VERSION=latest` is ignored in favor of an in-repo pin (D-009).

## Remote PRs

- #28 (`t1/ai-review`) and #29 (`t1/tooling`) were marked merged by GitHub when their commits reached `improve/integration` through the supervisor's push. No GitHub merge was performed.
- #30 (`g0/verify`) is the trusted-path verification.

## Next actions

1. (running) T2 parser and T6 phase A.
2. (done) Umbrella draft PR #31 `improve/integration → main`.
3. User decision pending: whether to make `CI` jobs and the `Codex review gate`/`Claude review gate` required checks (a ruleset change, D-002), and whether the org wants Dependabot secrets or an API-key Codex credential (D-014).
