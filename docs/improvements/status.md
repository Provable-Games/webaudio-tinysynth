# Improvement status

Supervisor-owned. After a context reset, read this file, then [contracts.md](contracts.md), then the newest entries of [decisions.md](decisions.md).

## After every merge into improve/integration (supervisor checklist, D-040)

Do these in order, as soon as a merge is seen. Fetch first: the user merges on GitHub.

1. **NOTICE.** Add the merged PR's bullet, from its "NOTICE (for the supervisor)" section, checked against the merged code. Insert it after the last `webaudio-tinysynth.js` bullet and push straight to `improve/integration`. Skip only if the PR changes no shipped behaviour (tests, CI, records); say so in the commit log of step 3.
2. **Issues.** Close every issue the PR completes, with a comment naming the PR and commit (D-038).
3. **Records.** Update this file's task row and the decisions.
4. **Consumer.** After the Dist bot has run for the newest commit, send the onchain coordinator a pin where `npm run verify` passes: the bot's rebuild commit, or a later docs commit if there is one. Include the min.js sha256 and its raw and gzip sizes, so the vendored NOTICE is complete at that pin.

NOTICE coverage was audited at `b6fe640` (2026-10-04). Every merged engine change has a bullet: T2, T3, T3.1, T4, T5, T5.2, T8-seed, T11 and T12. T10 re-audits NOTICE against `git log b70ba90..` before G2.

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
| T5 | #13 #14 | `t5/api` | d1f0e26 (T4 head) | accepted | squash 8f7b600 (PR #48, merged by the user) | Independent review (D-033), then four PR rounds. It folds in `_checkWave`/`_checkFilter`. At 0723736: CI 16/16, unit 894 / node 131 / 3 regressions, 3-engine matrix 288/288 (at 13698ce). min.js `95d8947a…`, 46,409 / 13,415 B (GNU gzip). Two Codex LOWs were deferred to T5.2 (T5.md §25). |
| T5.2 | #13 follow-up | `t5/guard` | 7616104 | accepted | squash 881ff1c (PR #56, merged by the user; docs #58) | `_op` float32 bounds on `a`/`h`/`d`/`r`/`q`. `_note` drops a note before creating nodes when a computed value overflows float32. Converted `tsmode` times are clamped. Both Codex LOWs fixed. The `close()` wait was not adopted (D-035 stands). Matrix 318/318; 14/14 mutants killed. min.js `4135920f…`, 46,488 / 13,469 B (bot rebuild fc04dbe). #13 closed. |
| T6 | #16 #7 (validation) | `t6/validation` | 25d2a3d | phases A and A.1 integrated (merges 346b782 and af3ea7a; PRs #33 and #36 green); phase B.1 accepted (squash ac8e776, PR #41, merged by the user: T2/T3/T4-CC11 assertions, exit guard, double-count fix); the remaining phase-B rows (T5 URL, T8 seed, T11/T12 fidelity) follow those tasks | | PR #33 green, including the arm64 matrix in 3 engines. The integrated tree passes `test:browser:matrix` locally (42 cases). Two deferred Codex MEDIUM test-strength fixes are in A.1. Full acceptance at G1. |
| T7 | #17 | `t7/architecture` | after G1 | pending | | |
| T8 | #7 #18 | seed: `t8/seed`; perf later | seed d1f0e26 | #7 accepted: squash 19cb982 (PR #42, merged by the user). #18 follows T7. | squash 19cb982 | D-004. mulberry32 streams, `bufferVersion` 1, default seed 0. Matrix 306/306 in 3 engines at ec67627. min.js `2f764960…`, 44,000 / 12,676 B. README/NOTICE in #50 (30f1506). |
| T11 | #26 | `t11/waveforms` | d1f0e26 (T4 head) | accepted | squash 4b99a2b (PR #40, merged by the user) | The independent review approved with changes (61deb9f); the fixes (M1 rescale, L1 tags, L2 build-before-install) are in the PR. Integration at 4b99a2b: verify passes, 530 unit / 122 node / 3 regressions. min.js `8b560049…`, 42,421 / 11,859 B. |
| T12 | #27 | `t12/filters` | d1f0e26 (T4 head) | accepted | squash b198d6c (PR #46, merged by the user) | Independent review (9716d63) fixes are in (fq/ff ≥ 2^-126, release tests). Nyquist clamp 0.45·SR. Integration b198d6c: verify passes, 686 unit / 122 node. min.js `59dfcfcd…`, 43,355 / 12,256 B. |
| T9-D2 | #19 (T9-3, T9-5, T9-8) | `t9/demos2` | 1833ef8 | accepted | squash 7eccf5d (PR #60, merged by the user) | Gesture start (lazy + `resume()`), `loadMIDIUrl` errors, and the editor working through `setTimbre`; 425/425 checks per engine. Open for T9-D3: Codex round-3 MEDIUM (file-switch race), T9-10, the MIDI pedal follow-up, E13/E14/X7/J5, untested iOS activation. NOTICE added after merge. |
| T9 | #19 #20, docs for #26/#27 | demos: `t9/demos`; docs later | demos 413f36c | demos integrated (merge 5946c28, head 0818b76; PR #38 green at 284c61b); docs after T7, accepted after T12 | | T9-D covers the engine-independent #19 demo fixes: 11/11 cases in 3 engines, and the demos make zero remote requests offline. T9-3/5/8 deferred to T4/T5. |
| T1-dist | D-036, D-037 (min.js generated by CI; manual releases) | `t1/dist-ci` | 3d965d1 | accepted | squash 7616104 (PR #55) | PR #51 was closed by the user and the work continues as #55 (the user chose that). Head 783d5b7: 16 signed commits. The integration rebuild bot (`dist.yml`) uses `createCommitOnBranch` with `expectedHeadOid`; a `release/*` head must equal a fresh build; local test builds go to `.build/`. Self-tests: Verified bot commit, no-op, race and loop guard (runs 37225981908, 37226544944, 37225990517/37226003000, 37226545843). Before #31 merges it needs a human commit on top. |
| T6-B.2 | #16 (phase-B rows #14, #7, #27, short notes) | `t6/phase-b2` | 7616104 | accepted | squash fdc094b (PR #57, merged by the user) | Adds assertions for #14 install-on-resolve and #7 pairwise seed distinctness; #27 was already asserted by T12. The short-note row was characterized (T6 §18.5) and became #59 / T13. The `waves.test.mjs` timeouts are explained by seeded-buffer generation in the `vm` harness. Matrix 312 cases, 4,806 checks. |
| T13 | #59 (short notes silent; release level from the last operator's attack) | `t13/short-notes` | 858e2d2 | accepted | squash d72be6a (PR #61, merged by the user) | PR head 99e73ab, 6 signed commits. CI was green, with the assert steps at 695 s (Chromium), 736 s (Firefox) and 796 s (WebKit) of the 1,200 s deadline (watch this in T1B). Claude and Codex said `lgtm`. Local matrix 342/342. Unit 996, node 155. +16 B raw / +19 B gzip. Zero-length notes at velocity 100 now sound in every engine (program 0, quality 1, peaks at 0.23). NOTICE is in 68782fa and the bot rebuild is 4bf9829. #59 is closed. |
| T1B | later CI extensions | `t1/ci-ext` | 2f82ec7 | accepted | squash bb7132f (PR #62, merged by the user) | The browser matrix is sharded 3 per engine by declared spec seconds, plus a `browser matrix` aggregate; the slowest assert step dropped from 796 s to 382 s. A malformed AI review with no content is retried once, with the trust boundary kept (supervisor reviewed the credential path). Demos run in CI as `demos (ENGINE)`. #31: re-trigger by a human (close/reopen or a signed commit). Optionally, require `browser matrix` on `main`. Sonnet agent. |
| T10 | all (independent verification) | `t10/verify` | after T8 T9 T1B T11 T12 | pending | | Gate G2 |

## Gates

| Gate | Requirement | State |
| --- | --- | --- |
| G0 initial CI | Lint, Vitest, native Node tests, retained regressions, build verification, offline Playwright smoke, AI review workflows with central model/effort; a real Actions run | **accepted** 2026-10-03. The trusted path was verified on PR #30: CI 37095012463, Claude 37095012532 and Codex 37095012496, both `lgtm`. A title-only edit produced skipped runs with non-required names. Limitations are recorded in validation.md. |
| G1 reliability | T1 foundation plus T2–T6 accepted; source and minified validation pass | **accepted** 2026-10-05: T1, T2, T3/T3.1, T4, T5/T5.2 and T6 (A, A.1, B.1, B.2) are integrated. #57 passed 16/16 CI checks and its matrix ran 312 cases with 4,806 checks. The Dist build and tests pass at `858e2d2`; source and minified builds were validated. The short-note finding moved to #59 (T13). #16 is closed. |
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

- 2026-10-05: pin `4bf9829` sent (T13 short notes, a sound change; min.js `8ad79ab8…`, 46,504 B raw, 13,608 Node gzip / 13,488 GNU gzip). Acknowledged. The consumer repo is now `Provable-Games/onchain-midi-player`, and its class becomes `TinySynth`. It will re-pin after its class-rename PR lands, and it is checking its Firefox render fixtures that start at t≈0.
- 2026-10-04: pin `fc04dbe` sent, the first bot rebuild (min.js `4135920f…`, 46,488 B raw, 13,587 Node gzip / 13,469 GNU gzip). The consumer verified it and is testing whether T5.2's skip-on-overflow lets it remove its five interim operator bounds.
- 2026-10-04: pin `3d965d1` sent (T8-seed, T5, every NOTICE entry, version 2.0.0; min.js `95d8947a…`, 46,409 B raw, 13,530 Node gzip / 13,415 GNU gzip; verify passes). The release model (D-037) and the D-036 rebuild-commit pinning were explained.
- 2026-10-04: pin `1ba4ee6` sent (#47 + #49 NOTICE entries for #26/#27; min.js `6aadee6f…`, 43,456 B raw, 12,393 B Node gzip / 12,295 B GNU gzip). #42 (19cb982), #50 (30f1506) and #48 (8f7b600) merged afterwards; send pin and NOTICE status after the T5 docs PR. Warned that min.js will soon be rebuilt by CI after each merge (D-036): pin the rebuild commit or any SHA where `npm run verify` passes.
- 2026-10-04: the #27 pin `b198d6c` (min.js `59dfcfcd…`, 43,355 / 12,256 B) was sent. #47 (lazy-start leak) and #42 (#7 seed) are still open.
- 2026-10-04: the T3.1 pin `705bb91` (min.js `34f856f9…`) and the combined T3.1+T11 pin `4b99a2b` (min.js `8b560049…`, 42,421 / 11,859 B) were sent to the coordinator.
- 2026-10-03: the T4 pin `a6d3f0e` (min.js `6f5b1f79…`, 40,245 / 10,991 B) was sent to the coordinator, now likely `webaudio-tinysynth-03` after the second crash. This supervisor is now `webaudio-tinysynth-a0`.
- Session names change after restarts. After the 2026-10-03 container crash, the consumer coordinator is `webaudio-tinysynth-33` (formerly `webaudio-tinysynth-15`; the D-028 note first went to `onchain-tinysynth-9b`, a read-only helper, by mistake), and this supervisor is `webaudio-tinysynth-b1` (formerly `-88`). Run `ListAgents` and confirm before messaging.
- 2026-10-03: interim pinning was offered to the onchain-tinysynth agent (session `webaudio-tinysynth-15`): pin an `improve/integration` SHA plus its min.js sha256, with no class declaration against interim pins. The pin candidate offered was `4b29ff1` / min.js `b49e8ceb…`, and the consumer adopted it (below).
- Whenever T4 (caller stop), T3.1 (leading rest, `startTime`), #7, #26 or #27 integrates, send that session the new integration SHA and min.js sha256, and flag any change to `playTime`, `playTick`, `chvol`, `chmod` or `chpan` (D-023).
- The consumer adopted interim pin `4b29ff1` (min.js `b49e8ceb…`) on its main (onchain-tinysynth PR #24). Its checks pass, and no class will be declared against it. Its size metric is gzip, with no budget (D-024).
- The consumer replied that interim pinning works technically. It accepted all six contract answers (D-021, D-023, D-004, D-007) and recorded #26/#27 on its issues #2/#3. It will drop the `chvol` swap and the `playTime`/`playTick` writes once T4 and T3.1 land, and it will qualify its determinism claims as per sample rate and generation version.

## Concurrency (D-029, D-030)

Running in parallel: T4 (fix round), T3.1, T11, T8-seed, T12, T5, T6-B.1 and T9-D. Binding rules are in `_evidence/assignments/CONCURRENCY.md`. Engine integration order: T4 → T3.1 → T11 → T8-seed → T12 → T5 → T5.2 (T4 through T5 are integrated as of 8f7b600; T5.2 starts after T1-dist). T6-B.1 and T9-D integrate whenever they are ready.

## Incidents (2026-10-03)

- **Container crashes, two of them.** The probable cause is vacuity runs that loaded the pre-T2 parser in WebKit: unbounded allocation on malformed MIDI reached 18–35 GB per WPEWebProcess. CONCURRENCY.md rule 10 now forbids unbounded pre-fix cases in browsers (run them in Node with a heap cap and a deadline). Rule 8 serializes heavy browser runs behind a flock.
- **GPG forwarding outage.** After the second crash the VS Code GPG-agent forwarding was gone. The supervisor's `gpgconf --launch` briefly shadowed the socket; it was stopped. The user reconnected VS Code. Unsigned commits made during the outage were re-signed before any push (rule 9).

## Skills work (D-032 → D-034)

- #44 was merged to `main` by the user, and its skills section was then removed (e93359b). #45 was closed by the user. Composer skills live in onchain-tinysynth (D-034).
- Agent-skills #41 (`github-ci` lessons, `no-auto-merge`) is open for the user's decision.

## Next actions

1. T4 fix round (resumed after the container crash): push, PR #37 replies, re-run; then delta re-review and integration.
2. After T4 integrates: dispatch T11 (#26, D-026/D-027; assignment `_evidence/assignments/T11.md`) and T3.1 (assignment `T3-1.md`) in parallel. Send the consumer the T4 SHA and hash, flagging the `stopMIDI` change.
3. After T11: T5 (assignment `T5.md`), then T6 phase B, then the G1 gate. After that T7 → T8 → T12 → T9/T1B → T10 → G2, unless the user re-prioritizes.
4. Umbrella PR #31 stays a draft until G2.
5. After a context reset, read `status.md`, `contracts.md` and the newest entries in `decisions.md` (D-020 to D-027). Assignment files live in `/workspace/webaudio-tinysynth-worktrees/_evidence/assignments/`.
