# T3.1 independent review: leading rest and `getPlayStatus().startTime` (#21, D-023)

| Item | Value |
| --- | --- |
| Candidate | `t3/leading-rest` at `d096501`, base `d1f0e26` (head of `t4/lifecycle`), diff `d1f0e26..d096501` (7 commits, all signed `G`) |
| Implementer record | `docs/improvements/tasks/T3-1.md` |
| Review branch / worktree | `t3/leading-rest-review` in `/workspace/webaudio-tinysynth-worktrees/t3-1-review`. Only this file is added. |
| Evidence | `/workspace/webaudio-tinysynth-worktrees/_evidence/t3-1-review/`: `exit-codes.txt` and suite logs; `review-check.mjs` and `review-check.json` (independent oracle, 1,721 checks); `mutation/` (`run.py`, `R0`–`R6.log`, `summary.json`); `browser/` (scratch spec `review31.js`, `run-chromium/results.json`, and the debug run); `probe-wrapgap.*` and `probe-toggle.*`; `size/size-trims.txt`; `base-d1f0e26.js`; `upstream-3d75aee.js` |
| Toolchain | Node 24.21.0 / npm 11.19.0 and Chromium 153.0.8010.12, through `_evidence/t6-validation/env.sh` |
| Specs | #21 (body sha256[:16] `137220174413e75d`); D-005, D-019, D-023 items 2–3 and the T3.1 outcome note (integration `decisions.md`); L-14 (integration `contracts.md`); consumer `onchain-tinysynth/player/player.js` at `d735793`, lines 280–330, read only |
| Concurrency | Only single-engine, single-spec browser runs, so no lock was needed (rule 8). `free -g` showed at least 106 GB available before each run (rule 10). No pre-fix build ran in a browser. Every process I started has exited. |

## Verdict

**Accept.** There is no CRITICAL, HIGH or MEDIUM finding. Three LOW findings concern documentation and test gaps, and three INFO notes follow. None of them blocks integration. F1 and F3 should be fixed in the record and the draft README before the consumer note goes out.

- **Leading rest: pass.** I checked every entry path against my own tempo map: load, `locateMIDI(0)` idle and while playing, the replay of a completed song (three times), a wrap, and a stop before the first event of pass 1 and of pass 3. Each pass puts tick 0 at the pass start and every note at `startTime + sec(tick)`, within 1e-9 s. The fixtures include two tempo events inside the rest and no event at tick 0. With `loopEnd` unset, behavior matches the base exactly. A seek to a tick above 0 is trace-identical to the base, so next-event positioning (D-005) is kept. A fresh `loopEnd` play is trace-identical to the base build with the consumer's rewrite applied.
- **`startTime`: pass, with F1.** The invariant `playTime − startTime = sec(0 → curTick)` held at every `playMIDI()` and every `loopEnd` wrap. After seeks across tempo changes (11 ticks × 3 fixtures × 2 builds), `startTime` was `now + 0.1 − sec(curTick)` within 1e-12. It is `null` with no song, after a load, when stopped, at the end and after `dispose()`. It is a plain own data property (writable, enumerable, configurable, not a getter), JSON and spread carry it, and each call returns a fresh object. F1: the README draft claims more than the default loop delivers.
- **Compatibility: pass.** The differential, tempo and loop-end regressions pass unchanged. All 130 base-vs-candidate flows I ran are identical in `_note` calls and WebAudio traces. The out-of-list edits are justified and weaken nothing (§4 below).

## Findings

Line numbers are `webaudio-tinysynth.js` at `d096501` unless a file is named.

### F1 (LOW): the draft README overstates the tempo-map guarantee when `loopEnd` is unset

- **Where:** `docs/improvements/tasks/T3-1.md:184` (draft README `getPlayStatus()`): "An event at tick T sounds at `startTime` plus the time from tick 0 to T under the song's tempo map". Code: `:526` (the default-loop wrap extrapolates at the inherited `tick2Time`) and `:811–820` (a resume walks the 120 BPM map).
- **Evidence:** `review-check.json` → `defaultLoop`. The fixture has its first note at 96, 60 BPM from tick 200, `loopEnd` unset, and PPQ 96.
  - In pass 2, the notes land 0.500, 0.781 and 1.042 s after `startTime + sec(tick)` on the song's tempo map. They are exact at the inherited tempo, which the record's §2/§8 do describe.
  - A stop and resume inside that same pass gives `startTime` 1.372, against 1.100 from the wrap. The next note then sounds 0.854 s after `startTime`, against 0.781 s on the map (`probe-toggle.log` shows the same).
- **Impact:** a caller following the README with `loopEnd` unset gets visuals off by up to the length of the inherited-tempo region. This is upstream tempo carry-over (D-005), not a T3.1 regression. The consumer uses `loopEnd` and is unaffected.
- **Fix:** qualify the README sentence. For example: "Exact with `loopEnd` set. With `loopEnd` unset, a later pass keeps the previous pass's final tempo until its first tempo event (upstream), so `startTime` is extrapolated at that tempo; use `loopEnd` for exact sync." The record's §8 residual already says this. Carry it into the public text.

### F2 (LOW): two documented behaviors are not pinned by any test

- **Where:** `:700` and `:526`, and record `:39` and `:48`.
- **Evidence:** in `mutation/`, each mutant ran the full unit (462), node (115) and regression (3) suites, plus `review-check.mjs`:
  - **R4** `_z=!(tick>0)` → `_z=!tick` makes a negative tick count as a seek. It **survives** all 462 + 115 + 3 tests. Only my `locateMIDI(-5)` check kills it (5 failures). The record documents `locateMIDI(tick ≤ 0)` as tick 0. The existing `[0, 480, -1, undefined, NaN]` loop (`tests/unit/transport.test.mjs:724`) only checks that nothing throws.
  - **R5**: the default-loop wrap's `startTime` on the 120 BPM map instead of the inherited tempo. It **survives** everything. The only `loopEnd`-unset test is 120 BPM throughout, so the two formulas coincide there. The candidate's choice is the better one: it matches every pass-2 event before the first tempo event, while R5 matches only `ev[0]`. Still, nothing protects it.
- **Impact:** a later edit could change either behavior silently.
- **Fix:** add `locateMIDI(-1)` and `locateMIDI(NaN)` cases to `leading-rest.test.mjs` (expect `startTime = now + 0.1` and the first note one rest later). Add a `loopEnd`-unset fixture with `ev[0].t > 0` and a final tempo other than 120 BPM, and assert that pass 2's events before its first tempo event land at `startTime + ticks × inherited seconds per tick`.

### F3 (LOW): the consumer note names the harmless hazard, not the one that breaks sync

- **Where:** `docs/improvements/tasks/T3-1.md:65`.
- **Evidence:** `review-check.json` → `consumer`. These are the consumer's flows on the consumer-like fixture: one beat of rest, a drum, a tempo change at bar 2, `loopEnd = maxTick` = 768. The art period comes from the consumer's own `checkMidi()` (4.4 s), over 5 passes per build:
  - **New flow** (`startTime`, no rewrite): art at 0.1 s, first note at 0.6 s. The maximum art/note error is 7e-15 s.
  - **Old flow left in place** (`playTime` delay plus rewrite): art at 0.6 s, first note at 1.1 s. Both are 0.5 s late but stay aligned with each other (error 1e-14 s). This is the doubled rest the record describes.
  - **Half migration** (art from `startTime`, rewrite kept): every note on every pass is **0.5 s late against the art**.
  - **Base `d1f0e26` with the old flow:** identical to the new flow on the candidate.
- **Impact:** the record's wording ("art delay becomes 0.6 s … every note is 0.5 s late") reads as a startup delay only. The case that actually desynchronizes the art is a partial edit that adopts `startTime` but keeps `synth.playTime += first * synth.tick2Time`.
- **Fix:** say it explicitly in the consumer note: remove the `first` read and both rewrite lines in the same change that switches the delay to `startTime`. Keeping the rewrite with `startTime` misaligns notes and art by one leading rest on every pass.

### F4 (INFO): `startTime` can be ahead of `currentTime` for most of a pass

- **Where:** `:526`, documented in the `getPlayStatus` comment (`:666–670`) and in the README draft.
- **Evidence:** `review-check.json` → `ahead`. A song's last event at tick 300 of a 1,536-tick loop (8 s). At the wrap, `currentTime` is 1.5 s and `startTime` is 8.1 s, 6.6 s ahead (82 % of the pass).
- **Impact:** a per-frame poller that computes `currentTime − startTime` sees negative values throughout the trailing rest. Reading `playTime` had the same behavior. The consumer reads `startTime` once and is unaffected.
- **Fix:** none required. Optionally add a README hint: "while `startTime > currentTime`, the previous pass is still sounding."

### F5 (INFO): the record is stale after the re-signing

- **Where:** `docs/improvements/tasks/T3-1.md:23`, `:31` and `:73`. Integration `contracts.md` L-14.
- **Evidence:**
  - `:23` says the later commits are unsigned, but all 7 commits show `G`.
  - `:31` and `:73` cite `571296a`, which is not on the branch. The commit there is `d727ec5`, and the record commit is `e965c3a`.
  - L-14 cites `76a4a12`, the superseded non-enumerable candidate.
- **Fix:** update the SHAs to `d727ec5`, `e965c3a` and `d096501`, and drop the signing sentence. The supervisor owns L-14.

### F6 (INFO): size: nothing material to trim

- **Evidence:** `size/size-trims.txt`. The candidate min.js is `4242bdc2…`, 40,569 B raw and 11,118 B with `gzip -9 -n`, both matching the record. The trims, measured with the pinned build:

  | Trim | Change | Raw | gzip -9 -n |
  | --- | --- | --- | --- |
  | T1 | `this._st=(this.playTime=a+(cond&&t))-t` | −24 B | −8 B |
  | T4 | inverted flag `this._k=tick>0` | −2 B | −6 B |
  | T1 + T4 | both | −26 B | −13 B (0.12 %) |
  | — | comma-bodied loop | 0 B | 0 B |

  T1 keeps `playTime` exact, so traces are unchanged. In the rest branch, however, `startTime` becomes `(a+t)−t`, which can differ from `currentTime + 0.1` by 1 ulp, so the exact `toBe` assertions would need `closeTo`. The other single-assignment form, `playTime=(_st=…)+t`, must not be used: it rounds the first event's time and breaks upstream trace identity.
- **Recommendation:** not worth it unless bytes become critical.

## §4. Out-of-list edits and the updated assertions

- **`locateMIDI` (`:700`, `this._z=!(tick>0)`): justified.** After `locateMIDI(0)` and after `locateMIDI(48)` on a song whose first event is at 96, the transport state is otherwise identical (`playIndex 0`, `curTick 96`). Only `locateMIDI` knows the requested tick. Every path that resets the position goes through it, and loads use `locateMIDI(0,1)`. The wrap sets `_z=1`.

  Two checks confirm the flag cannot leak. A failed load after a seek keeps the seek's next-event behavior. A successful load after a seek gives the new song its rest.
- **`tests/node/transport-scheduler.test.cjs` "one tick at 960 with loopEnd 480": justified and not weakened.** The old expectation pinned exactly the first-pass behavior that D-023/L-14 change. The new one is equally exact (`0.1 + (i+1) × 1 s`, same tolerance). It still fails if the wrap stops restoring the rest, and still requires at least 4 passes (the #8 regression).
- **The helpers and the updated assertions: not partial or vacuous.**
  - There are 22 `H.playStatus` sites: `transport.test.mjs` 9, `parser.test.mjs` 2, `lifecycle.test.mjs` 1, `transport-scheduler.test.cjs` 9 and `parser.test.cjs` 1. `H.statusOf` is used in `parser-compat.test.cjs` and in `H.playbackState`. Parametrized over builds, modes and targets, they run as roughly 110 assertions.
  - Every site is still a whole-object `toEqual` or `node:assert/strict` `deepEqual`. Stopped states now also pin `startTime: null`; strict mode rejects `undefined` for `null`, and so does Vitest.
  - The playing sites pin an exact `startTime`. The one exception, `expect.closeTo(start − sec(1440), 9)` at `transport.test.mjs:538`, is appropriate for a seconds value. The `expect.any(Number)` at `lifecycle.test.mjs:635` is for `curTick` and predates this branch.
  - `H.statusOf` fills `null` only for a missing key, which is upstream's case. A fork reporting `undefined` or a number when stopped would still fail the upstream comparison. The implementer's mutants M6 and M7 are killed by 18 node tests.

## Checks run

| Check | Exit | Result |
| --- | --- | --- |
| `npm ci` | 0 | |
| `npm run lint` | 0 | |
| `npm run verify` | 0 | the committed min.js and map equal the pinned build |
| `npm test` | 0 | unit 7 files / 462 tests; node 7 / 115; differential, tempo and loop-end PASS |
| `npm run pack:check` | 0 | |
| `npm run test:browser` | 0 | 2 of 2 smoke runs |
| `node review-check.mjs` (source and min) | 0 | 1,721 checks, 0 failures; 130 of 130 differential flows identical to base `d1f0e26` (`loopEnd` 0: fresh, replay, stop/resume, `locateMIDI(0)` while playing, 6 seek ticks; `loopEnd` > 0: 6 seek ticks, and stop/resume after the first event against base plus rewrite); 3 fixtures trace-identical to base plus the consumer rewrite |
| `python3 mutation/run.py` | 0 | see the mutation table |
| Chromium, `review31` via `scripts/browser-matrix.js --engines=chromium --specs=review31` in a scratch copy | 0 | 4 of 4 cases, 56 of 56 checks |
| `probe-wrapgap.cjs`, `probe-toggle.cjs` | 0 | diagnostic |

**Chromium detail.** The fixture has tempo events inside the rest, a drum and a 3.8 s tail, over source/min × q0/q1:
- `startTime` was `currentTime + 0.1` at the call.
- All 12 notes of 3 passes landed at `art0 + k × 5.583 s + sec(tick)`, with error at most 4e-15. Each time reached a real `start()`.
- A stop at pass 4's tick 0, followed by play, kept the rest.
- A seek to 100 resumed at tick 120, at `currentTime + 0.1`, with `startTime = playTime − sec(120)`.
- `startTime` was `null` after stop and after dispose, and there were no page errors.

The first run failed the `start()` check in q0 only. That was my instrumentation: `AudioBufferSourceNode.prototype.start` overrides the patched base `start`, which affected the q0 noise drums. The debug run shows the times, and the fixed spec passes.

**Mutation table.** The run used the full suites in a scratch `git archive`. Node failures exclude `runner.test.cjs`'s two "upstream reference via git" tests, which fail in any copy without `.git`, the control included.

| Mutant | Candidate unit | Candidate node | Regression | Reviewer checks | Killed by candidate suite |
| --- | --- | --- | --- | --- | --- |
| R0 control | 0 | 0 | pass | 0 (on the rerun at the candidate) | — |
| R1 walk stops one event short | 26 | 4 | pass | 308 | yes |
| R2 walk starts at the current tempo | 8 | 0 | pass | 65 | yes |
| R3 rest only when `loop` is on | 4 | 0 | pass | 16 | yes |
| R4 `_z=!tick` | 0 | 0 | pass | 5 | **no** (F2) |
| R5 default-loop wrap at 120 BPM | 0 | 0 | pass | 0 | **no** (F2) |
| R6 no `!playIndex` check | 2 | 0 | pass | 7 | yes |

R0's logged reviewer failure came from my own mis-specified differential case. The stop fell after the wrap was scheduled, which is the intended "stop before a later pass's first event", as `probe-wrapgap.log` shows. I corrected the case, and the rerun on the candidate is 0 failures.

**Sizes.** min.js `4242bdc29f3f…`, 40,569 B, 11,118 B with `gzip -9 -n` (11,220 B with default `gzip -c`), against a fresh base build of 40,245 / 10,991 (record §7). Growth is +324 B raw, +127 B gzip.
