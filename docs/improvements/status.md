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
| T3 | #8 #9 #10 #21 | `t3/transport` | 09922b9 | accepted | 99177f4 | The independent review accepted after two rounds (`tasks/T3-review.md`, 0cf4495). PR #34 green, Codex and Claude `lgtm`. min.js `b49e8ceb…`, 36,960 / 9,948 B. D-005, D-019. F11 is a T6-B test; F12 is a documented residual. |
| T4 | #11 #12 | `t4/lifecycle` | e5866e1 | accepted | 25c4f79 (merge 4fc3b0c) | Independent review plus delta re-review accepted (`tasks/T4-review.md`, 24581b8). PR #37 green. min.js `6f5b1f79…`, 40,245 / 10,991 B. D-018, D-023, D-025. LOW follow-up: CC11 (expression) resume test, assigned to T6-B. |
| T3.1 | #21 (consumer D-023) | `t3/leading-rest` | d1f0e26 (T4 head) | accepted | b4335c8 (merge b9882f1) | Independent review accepted (`tasks/T3-1-review.md`, 63d0424). PR #39 green; Codex and Claude `lgtm` after a formatting-flake rerun. min.js `34f856f9…`. |
| T5 | #13 #14 | `t5/api` | d1f0e26 (T4 head) | done pending merge of T4 (decisions: T3 test diff approved, invalidate-on-dispose kept); review after merge | | Integrates last among engine tasks and folds in the T11/T12 helpers (D-030). The `_note` guard is deferred to T5.2. |
| T6 | #16 #7 (validation) | `t6/validation` | 25d2a3d | phases A and A.1 integrated (merges 346b782 and af3ea7a; PRs #33 and #36 green); phase B.1 running (`t6/phase-b`, 413f36c: T2/T3 assertions, F11, the double-count LOW); the remaining phase-B rows follow their tasks | | PR #33 green, including the arm64 matrix in 3 engines. The integrated tree passes `test:browser:matrix` locally (42 cases). Two deferred Codex MEDIUM test-strength fixes are in A.1. Full acceptance at G1. |
| T7 | #17 | `t7/architecture` | after G1 | pending | | |
| T8 | #7 #18 | seed: `t8/seed`; perf later | seed d1f0e26 | #7 seed ready (399907b, signed): review fixes in (fmix32, static guard, `seed: null`); PR opening; integrates after T3.1 and T11; #18 after T7 | | D-004. mulberry32 streams, `bufferVersion` 1, default seed 0. The matrix passes in 3 engines. min.js 40,694 / 11,334 B. |
| T11 | #26 | `t11/waveforms` | d1f0e26 (T4 head) | done (4ea5927); TinyChip compatibility follow-up plus PR in progress; independent review running | | D-006, D-021, D-027 (held storage) |
| T12 | #27 | `t12/filters` | d1f0e26 (T4 head) | review requested fixes (9716d63): F1 `fq` NaN floor; fixes in progress | | D-007, D-028. Integrates after T11 and T8-seed. |
| T9 | #19 #20, docs for #26/#27 | demos: `t9/demos`; docs later | demos 413f36c | demos integrated (merge 5946c28, head 0818b76; PR #38 green at 284c61b); docs after T7, accepted after T12 | | T9-D covers the engine-independent #19 demo fixes: 11/11 cases in 3 engines, and the demos make zero remote requests offline. T9-3/5/8 deferred to T4/T5. |
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

## Consumer coordination

- 2026-10-03: the T4 pin `a6d3f0e` (min.js `6f5b1f79…`, 40,245 / 10,991 B) was sent to the coordinator, now likely `webaudio-tinysynth-03` after the second crash. This supervisor is now `webaudio-tinysynth-a0`.
- Session names change after restarts. After the 2026-10-03 container crash, the consumer coordinator is `webaudio-tinysynth-33` (formerly `webaudio-tinysynth-15`; the D-028 note first went to `onchain-tinysynth-9b`, a read-only helper, by mistake), and this supervisor is `webaudio-tinysynth-b1` (formerly `-88`). Run `ListAgents` and confirm before messaging.
- 2026-10-03: interim pinning was offered to the onchain-tinysynth agent (session `webaudio-tinysynth-15`): pin an `improve/integration` SHA plus its min.js sha256, with no class declaration against interim pins. The pin candidate offered was `4b29ff1` / min.js `b49e8ceb…`, and the consumer adopted it (below).
- Whenever T4 (caller stop), T3.1 (leading rest, `startTime`), #7, #26 or #27 integrates, send that session the new integration SHA and min.js sha256, and flag any change to `playTime`, `playTick`, `chvol`, `chmod` or `chpan` (D-023).
- The consumer adopted interim pin `4b29ff1` (min.js `b49e8ceb…`) on its main (onchain-tinysynth PR #24). Its checks pass, and no class will be declared against it. Its size metric is gzip, with no budget (D-024).
- The consumer replied that interim pinning works technically. It accepted all six contract answers (D-021, D-023, D-004, D-007) and recorded #26/#27 on its issues #2/#3. It will drop the `chvol` swap and the `playTime`/`playTick` writes once T4 and T3.1 land, and it will qualify its determinism claims as per sample rate and generation version.

## Concurrency (D-029, D-030)

Running in parallel: T4 (fix round), T3.1, T11, T8-seed, T12, T5, T6-B.1 and T9-D. Binding rules are in `_evidence/assignments/CONCURRENCY.md`. Engine integration order: T4 → T3.1 → T11 → T8-seed → T12 → T5 → T5.2. T6-B.1 and T9-D integrate whenever they are ready.

## Incidents (2026-10-03)

- **Container crashes, two of them.** The probable cause is vacuity runs that loaded the pre-T2 parser in WebKit: unbounded allocation on malformed MIDI reached 18–35 GB per WPEWebProcess. CONCURRENCY.md rule 10 now forbids unbounded pre-fix cases in browsers (run them in Node with a heap cap and a deadline). Rule 8 serializes heavy browser runs behind a flock.
- **GPG forwarding outage.** After the second crash the VS Code GPG-agent forwarding was gone. The supervisor's `gpgconf --launch` briefly shadowed the socket; it was stopped. The user reconnected VS Code. Unsigned commits made during the outage were re-signed before any push (rule 9).

## Next actions

1. T4 fix round (resumed after the container crash): push, PR #37 replies, re-run; then delta re-review and integration.
2. After T4 integrates: dispatch T11 (#26, D-026/D-027; assignment `_evidence/assignments/T11.md`) and T3.1 (assignment `T3-1.md`) in parallel. Send the consumer the T4 SHA and hash, flagging the `stopMIDI` change.
3. After T11: T5 (assignment `T5.md`), then T6 phase B, then the G1 gate. After that T7 → T8 → T12 → T9/T1B → T10 → G2, unless the user re-prioritizes.
4. Umbrella PR #31 stays a draft until G2.
5. After a context reset, read `status.md`, `contracts.md` and the newest entries in `decisions.md` (D-020 to D-027). Assignment files live in `/workspace/webaudio-tinysynth-worktrees/_evidence/assignments/`.
