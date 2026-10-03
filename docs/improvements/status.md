# Improvement status

Supervisor-owned. After a context reset, read this file, then [contracts.md](contracts.md), then the newest entries of [decisions.md](decisions.md).

## Baseline

- Repository: `Provable-Games/webaudio-tinysynth`, default branch `main`.
- Baseline: `b70ba90d63c5ea657cb67ca98de90d7f778c29bd` (= `origin/main`, verified 2026-10-02).
- Integration branch: `improve/integration` (worktree `/workspace/webaudio-tinysynth-worktrees/integration`).
- Evidence root (not in the repo): `/workspace/webaudio-tinysynth-worktrees/_evidence/`.
- Remote actions: task branches may be pushed and PRs opened; no GitHub merges, releases, tags, or ruleset/secret changes (D-002).

## Task state

States: `pending`, `running`, `review`, `accepted`, `blocked`.

| Task | Issues | Branch / worktree | Base | State | Accepted commit | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| T0 | #16 (baseline), #7/#21/#26/#27 contracts | `t0/baseline` | b70ba90 | running | | Policy decisions D-004 to D-007 written by the supervisor |
| T1 | #5 #15 #16 #22 #23 #24 #25 | tooling: `t1/tooling`; AI review: `t1/ai-review` | after T0 | pending | | Initial CI gate G0 |
| T9A | #19 #20 (read-only audit) | `t9/audit` | after T0 | pending | | Optional, parallel with T1 |
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
| G0 initial CI | Lint, Vitest, native Node tests, retained regressions, build verification, offline Playwright smoke, AI review workflows with central model/effort; a real Actions run | pending |
| G1 reliability | T1 foundation plus T2–T6 accepted; source and minified validation pass | pending |
| G2 delivery | All registered criteria verified; T10 independent review; consumer artifact/hash handoff | pending |

## Risks and blockers

- Hosted ARM Playwright support is unverified. If a browser is unavailable on linux-arm64, record an x64 exception (D-008).
- The ruleset has no required status checks. Making the new gates required is a ruleset change that needs user authorization (D-002).
- The org variable `CODEX_CLI_VERSION=latest` is ignored in favor of an in-repo pin (D-009).

## Next actions

1. Review T0's report and evidence; accept it, then merge `t0/baseline` into `improve/integration`.
2. Dispatch T1 tooling and T1 AI review in parallel worktrees; optionally dispatch the T9A audit.
3. Push `improve/integration` and open the umbrella draft PR once T1 workflows exist.
