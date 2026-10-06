# Supervisor handover (2026-10-06)

From the Claude Opus 5.5 supervisor (session `webaudio-tinysynth-a0`) to a GPT-6.1 Sol supervisor. The user is switching because of Claude usage limits.

**Read these, in order:**
1. this file;
2. [status.md](status.md): the post-merge checklist, the release checklist, the task table and the consumer log;
3. the newest entries in [decisions.md](decisions.md): D-036 to D-042;
4. `/workspace/webaudio-tinysynth-worktrees/_evidence/assignments/CONCURRENCY.md`: rules 1–14 for every agent.

## Goal and the user's priorities

- **The goal:** Casey Wescott's MIDI scores play accurately and consistently on all modern devices, through the onchain player. Quality and consistency come first. Startup speed, size and simplicity come second.
- **Scope freeze (D-042):** P1 issues only until the release ships. The user says they "keep shipping features forever", so flag scope creep. New ideas get logged as issues and deferred.
- **Who merges:** the user squash-merges every PR on GitHub. The supervisor never merges.
- **Reporting style:** the user prefers short status updates, honest trade-offs, and a recommendation rather than a survey of options.

## Repositories and branches

| Repo | Role | Local |
| --- | --- | --- |
| `Provable-Games/webaudio-tinysynth` | The engine. `main` is the release branch. `improve/integration` holds all the work. Draft umbrella PR #31 merges integration into `main` at release. | `/workspace/webaudio-tinysynth` (on `main`); integration worktree `/workspace/webaudio-tinysynth-worktrees/integration` |
| `Provable-Games/onchain-midi-player` | The consumer: an onchain player that pins integration SHAs and will pin the release tag. | `/workspace/onchain-tinysynth` (read-only for us) |
| `caseywescott/midi_fun_contract` | Casey's compositions and the production sounds (TinyChip bank, `beast_sound`). | `/workspace/midi_fun_contract` (read-only) |
| `Provable-Games/beast-sound-check` | GitHub Pages listening test with tempo-synced art. | https://provable-games.github.io/beast-sound-check/ |

## How the work runs

- **One worktree per task,** under `/workspace/webaudio-tinysynth-worktrees/<task>`. Each agent pushes only its own branch, opens a PR into `improve/integration`, replies on its own PR, and force-pushes only with lease (D-020, D-035). It never pushes to a merged branch (rule 13).
- **Generated files:** PRs never commit `webaudio-tinysynth.min.js` or its map (rule 12, D-036). After every push to `improve/integration`, the `Dist` workflow rebuilds them and commits them signed by GitHub (`Rebuild webaudio-tinysynth.min.js for <sha>`). Releases into `main` are manual (D-037).
- **Docs:**
  - Task PRs update the README, the source header and their `contracts.md` row.
  - **NOTICE belongs to the supervisor** (D-040). PRs propose a bullet under "NOTICE (for the supervisor)", and the supervisor adds it right after the merge.
- **The post-merge checklist** at the top of `status.md` runs after every merge:
  1. NOTICE;
  2. close the completed issues with a comment (D-038);
  3. update the records;
  4. send the consumer the new pin and a behaviour summary.
- **Signing:** every commit is signed through the forwarded GPG agent. Never run `gpg-agent` or `gpgconf`, because that breaks forwarding (rule 9).
- **CI** (ARM runners):
  - `lint`, `test`, `build-verify` and `browser-smoke`;
  - `browser matrix`: 3 shards per engine plus an aggregate;
  - `demos (ENGINE)`;
  - Claude and Codex AI review gates, with the model and effort set in org variables.
- **The #78 policy (merged in #65):** the first render attempt decides the verdict. Until #91 is fixed, expect a red WebKit shard in about 1 in 3–4 PR runs. The job's diagnostics show whether a re-render was clean.
- **Safety:**
  - Never load pre-fix builds with malformed or looping MIDI in a browser. Earlier runs used 18–35 GB per WebKit process and crashed the container (rule 10).
  - Run heavy browser work through `_evidence/locks/heavy-run.sh` (two slots, with a memory check).
  - Pass explicit `--out` and log paths. `_evidence/t6-validation/env.sh` exports `E`, which overwrites T6 evidence (rule 14).
- **Bot commits start no CI.** Before #31 merges, push a human signed commit on top, or close and reopen it, so its required checks run.

## State at handover

- **Integration:** `4f5ce12`. The latest consumer pin is `31fb18d`: min.js `bcb498b9…`, 47,212 B raw / 13,871 B gzip, and `npm run verify` passes. Every commit since then is records only.
- **Accepted and merged:** T0–T6, T3.1, T4, T5 and T5.2, T8 and T8-seed, T9-D, T9-D2, T9-D3, T11, T12, T13, T13.1, T1-dist and T1B. See the task table in `status.md`.
- **Closed:** #4–#16, #18, #19, #21–#27, #59 and #78.
- **Open PRs:** only #31, the draft umbrella. No agents or background processes are running, and no worktree has uncommitted changes.

## Release plan (P1 only)

| Wave | Item | Notes |
| --- | --- | --- |
| 1 | **#91**: the WebKit render slip on looped, low-rate buffers | It is inherited from upstream (same rate in `3d75aee`) and has never been reproduced without the library. It sometimes reaches audible levels (0.38 on q0 program 127). Bisection plan: `tasks/T13.1.md` §4. Also stress-render the TinyChip bank in WebKit, since every TinyChip voice is a looped buffer. |
| 1 | **#68**: scheduling deadlines (B1) | The revised design is S–M. The first downbeat has only 40–100 ms of lead. Keep the first-pass art origin (`startTime`) and the housekeeping cadence; a naive synchronous tick moves the origin a whole loop later. Record the timing trade-off as a new decision (D-043, because D-042 is the freeze) with a contracts row. Flag the timing change to the consumer. |
| 1 | **#79**: release-gate integrity (A2) | Cross-engine checks after the shard merge, and full-mix baselines. Then the user makes `browser matrix` required on `main`. |
| 1 | **#76**: certifying production tracks and banks (A3) | Belongs in the consumer repo. The triage prototype `_evidence/review-triage/probes/certify-mock.cjs` has a confirmed false pass (a tuning SysEx), so certification needs independent pitch and state checks and a blocking result. Size M. |
| 2 | **#80**: device qualification | Real devices, run by the user and Casey: iPhone (speaker, AirPods, silent switch), iPad, mid-range and low-end Android, macOS Safari, desktop Chrome and Firefox. The 8-step checklist is in `_evidence/review-triage/TRIAGE.md` §5. Casey signs off. |
| 2 | T10 and G2 | An independent final check, which also covers the accuracy of README and NOTICE and NOTICE coverage. |
| 3 | Release | #31, then `release/v2.0.0`, then the signed tag and a GitHub Release with `SHA256SUMS` and the verbatim `npm run verify` output, which the consumer asked for. Checklist in `status.md`. |

**Frozen until after the release:** P2 and P3 issues #66, #67, #69–#75, #77 and #81–#88; #90 (the push note API); #17; #20.

## Waiting on the user

1. **The version.** The user said "v1.0.0". The engine is planned as v2.0.0 (D-037: the input checks break compatibility with upstream 1.1.4). The consumer's mainnet release is its own 1.0.0. Confirm which is meant.
2. **#68:** approval of the B1 timing trade-off, once the design is ready.
3. **#76:** whether A3 goes to the consumer side, and who runs it.
4. **#80:** the device list, and Casey's final production MIDI files and settings, if they differ from `midi_fun_contract`.
5. **The ruleset:** require `browser matrix` on `main` after #79 lands.
6. **Small items:**
   - the `priority: P3` label on #90;
   - the trailer for commits written by GPT agents (Claude agents used `Co-Authored-By: Claude …`);
   - whether supervisor records and NOTICE should go through PRs, since the commit audit found many direct pushes without a PR.
7. **Optional:** send `_evidence/assignments/TRIAGE-FEEDBACK-REQUEST.md` to the reviewer that filed #66–#89.

## Coordinating with the consumer

The onchain-midi-player coordinator is a Claude session (`webaudio-tinysynth-03`). A GPT supervisor cannot message it directly, so go through the user or through GitHub, in `Provable-Games/onchain-midi-player` issues and PRs.

**What the consumer is owed:**
- **Now:** the triage outcome (P1-only plan), any sound or timing changes before the tag (#68 changes timing), and a revised timeline.
- **After each engine merge:** the pin, the min.js sha256 and sizes, and the behaviour.
- **At release:** the tag and its assets.

**What it relies on:** `playMIDI()` and `getPlayStatus().startTime` for art sync. One of its render checks reads the internal `convBuf`; it is guarding that at its re-pin.

## Evidence

- `_evidence/review-quality/`: the independent review that filed #66–#89.
- `_evidence/review-triage/`: `TRIAGE.md`, `ISSUES-VERIFIED.md` and `PRIORITY-REVIEW.md`; the Opus triage agrees with every P1–P3 label.
- `_evidence/t13-1-flake/`: the WebKit investigation and its probes.
- `_evidence/anim-explore/`: the note-driven animation study, for after the release (#90).
- `_evidence/assignments/`: every brief, `CONCURRENCY.md`, and `BEAT-SYNC-ART-for-Casey.md`.
