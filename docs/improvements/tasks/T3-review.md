# T3 independent review: transport safety (#8, #9), replay (#10) and seek (#21)

| Item | Value |
| --- | --- |
| Candidate | `t3/transport` at `4610be9` (PR #34), base `09922b9` (improve/integration with T2), diff `09922b9..4610be9` |
| Extension | At the supervisor's request, the verdict also covers the PR head `6c0a353` (`4610be9..6c0a353`: `82bbc6a`, `5cbd97c`, `9d77f43`, `e884899`, `000424b`, `d618a2c`, `9040c55`). |
| Implementer record | `docs/improvements/tasks/T3.md` |
| Review branch / worktree | `t3/review` in `/workspace/webaudio-tinysynth-worktrees/t3-review`. Only this file is added. |
| Evidence | `/workspace/webaudio-tinysynth-worktrees/_evidence/t3-review/`: `scripts/` (every adversarial script and mutation runner), `adversarial/` (JSON results per head), `mutation/` (diffs, logs, `summary.tsv`), `logs/` (4610be9 commands in `commands.tsv` and `*.log`; 6c0a353 in `logs/h6-clone/`; PR #34 reads), `probes/` (T0 #8/#9/#10/#21 probes rerun at both heads) |
| Toolchain | Node v24.21.0 / npm 11.19.0 (`_evidence/t1-tooling/tools`), pinned Terser, Chromium headless shell via playwright-core (`PLAYWRIGHT_BROWSERS_PATH=_evidence/t1-tooling/ms-playwright`, `LD_LIBRARY_PATH=_evidence/T0/tools/libroot/...`) |
| Specs | Issues #8, #9, #10 and #21 (`_evidence/issues`); D-005, D-013 and D-019 (integration copy of `decisions.md`); L-04, L-05, L-06 and L-08 |
| PR #34 (read only) | At `6c0a353`, 13 of 13 checks pass. Claude: lgtm. Codex: one MEDIUM open (caller-scheduled automation survives a seek), which is F3 below. |

## Verdict

**`4610be9`: changes requested.**
- #8 passes and #9 passes.
- #10 fails in the issue's own pattern (F1, HIGH): play to the end, then call `playMIDI()` at once. Channel automation queued in the last 0.2 s fires after the replay's reset. In Chromium, a song that ends with a CC7 fade replays at gain 0 for the whole pass, in 10 of 10 runs.
- #21 is partial:
  - 74 of 600 random histories end in a state that differs from a fresh `loadMIDI` + `locateMIDI(X)`. All 74 are F1: a stopped seek while scheduler events are still queued.
  - F2: a song loaded at `maxTick` loses post-load settings on its first play.

**`6c0a353`: accept after one fix (F3, MEDIUM). F4 needs a decision or a corrected record.**
- F1 and F2 are fixed. Seek equivalence holds in 600 of 600 histories, and Chromium is correct in 30 of 30 runs.
- The load path is still trace-identical to upstream (240 of 240), and seeks with nothing queued are trace-identical to `4610be9` (120 of 120).
- Remaining:
  - **F3 (MEDIUM):** automation the caller schedules with `send(msg, t)` or a timed setter survives a seek unless the scheduler happens to have queued something. 186 of 600 caller-timed histories fail. Always cancelling on a non-load seek fixes it (600 of 600), deletes the `queued` bookkeeping and shrinks min.js.
  - **F4 (MEDIUM):** a replay at the status flip drops the previous pass's queued notes, not only release tails.
  - LOW items F5 to F10.

No CRITICAL defect. No hang in 2,028 externally deadlined scheduler runs.

## Findings

Severity is for the head named. Line numbers are `webaudio-tinysynth.js`.

### F1 (HIGH at 4610be9; fixed at 6c0a353): queued channel automation overrides a replay or a stopped seek

- **Where:** `4610be9:572`. The cancel runs only when `p` (playing). `4610be9:640–641`: the replay sets `playing=0` before `locateMIDI(0)`, so a replay never cancels.
- **Evidence:**
  - Chromium (`adversarial/browser-probe.json`). Fixture: CC7 100 at tick 0, CC7 60/30/10/0 at ticks 1800 to 1880, end at 1900. The page polls `play` every 5 ms, then calls `playMIDI()` at the flip. Channel 1's gain 600 ms into the replay is **0**, against 1.86 expected, in 5 of 5 runs per build. `stopMIDI(); locateMIDI(0); playMIDI()` at the flip also gives 0 (5 of 5). Waiting 1 s first gives 1.86 (5 of 5).
  - Mock with a Web Audio timeline model (`scripts/adv-stale.js`): the same, and upstream behaves identically, so this is pre-existing. A seek *while playing* was already fixed at `4610be9`.
  - Seek fuzz (`scripts/adv-seek.js`, seed 21, 300 random histories × 2 builds): 526 of 600 equal. All 74 mismatches are "stopped seek with queued events", and differ only in effective param values.
  - The implementer's test "a stopped seek and a load cancel no channel automation" pinned this behaviour. `seekState` reads only trace lines after the seek, and the "stopped" history waits 500 ms, so the history-independence test could not see it.
- **Impact:** #10's acceptance (D-005: "a replay sounds the same as the first play") fails in its own reproduction pattern (`runUntil(!playing)` then `playMIDI()`) for any song with volume, expression, pan or modulation changes in its last 0.2 s. #21 is history-dependent after a stop: a "restart" button (`stopMIDI(); locateMIDI(0); playMIDI()`) has the same problem.
- **Status at 6c0a353:** fixed by `000424b`, which tracks a `queued` high-water mark (`:492`) and cancels when it is ahead (`:575`). Results:
  - seek fuzz 600 of 600
  - Chromium 30 of 30 correct
  - Codex's stop → immediate resume → seek case correct (it failed at `e884899`)
  - my independent sketch R11 (`mutation/R11-highwater-cancel`) reached the same result
- **Fix:** none needed beyond F3.

### F2 (MEDIUM at 4610be9; fixed at 6c0a353): first play of a song loaded at `maxTick` is treated as a replay

- **Where:** `4610be9:640`. After loading, `playTick == maxTick` when every event sits at `maxTick` (for example the #8 snippet, `maxTick` 0), so `playMIDI()` calls `locateMIDI(0)`.
- **Evidence:** `scripts/adv-followup.js`. Load a one-tick song, `setProgram(0,40)`, then play: the first note uses program **0**. A two-tick song keeps 40. Codex found this independently.
- **Impact:** settings made between load and first play are lost for zero-length songs, which is inconsistent with every other song.
- **Status at 6c0a353:** fixed (`82bbc6a`, `:644`: completed only if `playIndex > 0`). Program 40 is kept, and mutation H6 (reverting it) is killed by 4 tests.

### F3 (MEDIUM, open at 6c0a353): caller-scheduled channel automation survives a seek

- **Where:** `6c0a353:575`. The cancel runs only if `queued > currentTime`, and `queued` is advanced only by the scheduler (`:492`). Automation from `send([0xb0|ch,7,v], t)`, `setChVol`, `setPan`, `setExpression` or `setModulation` with a future `t` is not tracked.
- **Evidence:** `scripts/adv-seek.js` with `CALLER_TIMED=1` (seed 22, 300 × 2) adds timed sends and setters to the histories. Result at `6c0a353`: **414 of 600** equal. The 186 mismatches:

  | Class | Count |
  | --- | ---: |
  | Stopped seek, nothing queued by the scheduler | 162 |
  | Seek while playing during a rest (`queued` already passed) | 16 |
  | Stopped seek while the scheduler had queued events | 8 |

  Every mismatch has caller automation pending. Codex's reproduction gives the same result.
- **Impact:** D-005 says "Manual overrides do not survive a seek", and the timed `send()` is documented API. Whether an override survives depends on whether the scheduler queued anything in the last 0.2 s, so the seek is still history-dependent and can silence a channel.
- **Fix (recommended), R12b:** cancel on every non-load seek and delete the `queued` bookkeeping. At `:575` use `if(!load) for(;i<16;++i) …cancelScheduledValues(currentTime)`, and drop the line at `:492`.
  - Validated in `mutation/R12b-h6-always-cancel-no-queued`:
    - seek fuzz 600 of 600, standard and caller-timed
    - all stale and resume cases correct
    - scheduler node test passes, parser unit passes, regressions 3 of 3
  - min.js: **36,917 B / 9,939 B gzip**, against 37,022 / 9,965 at `6c0a353`.
  - Cost: 48 `cancelScheduledValues` calls per seek, and 4 unit tests fail. Those tests ("…a later seek cancels nothing") pin a trace property, so they must be updated.
  - The property they protect has no compatibility value. T3 seek traces never match upstream: 0 of 120 nothing-queued seeks are upstream-identical (`adversarial/trace-identity.json`, S). They match only `4610be9`, because a seek rebuilds state through `reset()` and `send()` by design. D-019's wording "non-playing seeks stay trace-identical to upstream" is inaccurate. Only the **load** path is upstream-identical, and R12b keeps that (the `load` flag).
  - This is the simpler, standard option: a seek resets channel automation unconditionally.
- **Alternative, R13:** track the converted time in the four channel setters (`_q(t)` wrapping `_tsConv`). It passes every current test unchanged and is also 600 of 600 in both fuzzes. But it adds +39 B raw / +17 B gzip over `6c0a353`, and every future AudioParam writer must remember to update `queued`. Prefer R12b.

### F4 (MEDIUM, open at both heads): a replay at the status flip drops the previous pass's queued notes

- **Where:** the replay path (`4610be9:640–641`, `6c0a353:644–645`) calls `locateMIDI(0)` → `stopMIDI()` → `_pruneNote`, which calls `o.stop()` (`4610be9:822`, `6c0a353:826`). That stop also hits voices whose `start(t)` is still in the future. `play` turns 0 when the last event is *queued*, up to 0.2 s before it sounds.
- **Evidence:** `scripts/adv-stale.js`, PICKUP fixture with three short notes in the last 0.2 s. A replay at the flip leaves **6 oscillators (3 notes) that never start**. Upstream leaves 0, at `4610be9` and at `6c0a353`.
- **Impact:** D-019 records this as "a replay cuts the previous pass's release tails". In practice, a completion-driven replay also loses the final up to 0.2 s of notes (the last beat) on every pass. This is a regression from upstream, where replay did not stop voices.
- **Fix (needs a supervisor decision):** either
  - (a) correct D-019, T3.md and the README (T9) to say that a replay within about 0.2 s of completion drops the notes still queued; or
  - (b) set `play` to 0 only once `currentTime` reaches the last event's time, so that "completed" means audibly completed. A replay then cuts only release tails, and completion waiters stop seeing `play: 0` up to 0.2 s early.

  (a) is the minimum to merge. (b) is the better contract.

### F5 (LOW, pre-existing, both heads): automation queued by a previous song survives `loadMIDI`

- **Where:** `6c0a353:781` passes `load`, which skips the cancel. `4610be9` never cancels on a load.
- **Evidence:** load another song at the status flip of the fade song, then play. Channel 1 is at gain **0**, as in upstream (`stale-*.json`, "loadMIDI(other)").
- **Impact:** the new song starts with the old song's queued volume or pan until its own controller events.
- **Fix:** kept deliberately by D-019 for load-path trace identity, so record it as a ledger follow-up. Cancelling on a load only when automation is pending (mutation H4) keeps parser-compat and the differential green, because their fixtures load into idle synths. Only the 4 unit tests that pin it change.

### F6 (LOW): #8 "advances" is measured in ticks, so nanosecond passes loop forever at the work bound

- **Where:** `:497` (`4610be9`) / `:499` (`6c0a353`). The parser accepts a 1 µs tempo (`60000000/1`). A looping song of 1 to 480 ticks at that tempo advances about 2 ns to 1 µs per pass. It never catches up and runs 1000 events every 60 ms forever.
- **Evidence:**
  - Chromium, 4 s per case (`browser-probe*.json`): about 44,700 oscillators in 4 s. The page stays responsive: mean timer lag 0.6 to 5.4 ms, maximum 6 to 79 ms, long tasks totalling 52 to 436 ms.
  - Mock: 90 of 1014 fuzz runs are such "floods". Dense loops above about 16.7k events/s fall behind without bound.
  - A 1-hour stall of a looping song is replayed as roughly 83 s of 1000-event late bursts, since #8 forbids silent drops.
- **Impact:** not a hang, but sustained garbage audio and CPU for untrusted looping MIDI.
- **Fix (optional):** also end a loop whose pass lasts under a small floor in seconds (for example 1 ms), or document it.

### F7 (LOW): test gaps

Two reviewer mutations survive every suite at both heads:
- R1/H1, the wrap gate on `maxTick` instead of the last event's tick (a one-tick song with a trailing End-of-Track rest would then flood);
- R2/H2, a SysEx-only song treated as silent.

The code is right (my fuzz covers both cases), but the tests do not pin it. Add a one-tick song with a later End-of-Track and loop on, and a SysEx-only or CC-only song that plays as timed silence. H5 (not clearing `queued` after a cancel) also survives, but it is benign and disappears with R12b.

### F8 (LOW): negative `loopEnd` is half "unset", half "set"

- **Where:** the gate uses `loopEnd>0`, but the wrap body uses `if(this.loopEnd)` (`4610be9:499`, `6c0a353:501`).
- **Evidence:** a one-tick song at 960 with `loopEnd` −480 stops after one pass, while `loopEnd` 1 loops every 960 ticks. A multi-tick song with −480 takes the padding and 120 BPM reset branch (`adversarial/misc.json`).
- **Fix:** T5/#13 should reject non-finite or negative `loopEnd` (RangeError), or use `>0` in both places.

### F9 (LOW): a seek calls `audioContext.resume()` once per replayed state event

- **Where:** `send()` (`:1049`/`:1053`) is used by the seek loop (`:581`/`:585`).
- **Evidence:** on a suspended context, `locateMIDI(500)` over 200 CCs makes 200 `resume()` calls. Upstream makes 0.
- **Fix:** resume once, or not at all, during a seek. This is T3 risk #3, and T4 (#12) owns it.

### F10 (LOW, docs): D-019 and T3.md wording

- "non-playing seeks stay trace-identical to upstream" should read "…to the pre-cancel T3 seek" (see F3).
- "replay cuts release tails" understates F4.

## Judgement on the deliberate extensions and the residual

- **Scale tuning cleared on load and seek: accept.** D-005's baseline lists scale tuning 0. Upstream leaked it from one song into the next. The change is JS state only, so the load trace is unchanged (the differential passes).
- **Replay cutting release tails: accept the policy, but not the description.** It also drops queued notes (F4). Either fix the record or move the completion flip.
- **Residual "queued automation fires within 0.2 s after a stop or song end": not acceptable at `4610be9`** (F1, HIGH, breaks #10's own pattern). It is fixed at `6c0a353` for scheduler automation. What remains is F3 (caller-scheduled, MEDIUM, fix with R12b) and F5 (loads, LOW, pre-existing, policy).

## Issue verdicts

| Issue | 4610be9 | 6c0a353 | Basis |
| --- | --- | --- | --- |
| #8 | PASS | PASS (F6 LOW) | 2,028 deadlined runs (507 cases × 2 builds × 2 heads), 0 kills, at most 1000 events per callback. Sends equal an independent D-019 schedule (no drop, duplicate or reorder across callbacks), no early sends, no premature yield. Zero-duration loops end `{play:0, curTick:maxTick}`. A positive `loopEnd` keeps tick-0 phrases looping. T0 probe: snippet ends, `loopEnd` 480 loops at 0.5 s. |
| #9 | PASS | PASS | 128 of 128 per head: 8 silent files × 8 loop setups × 40 transport calls each. No node created, `play` stays 0, finite status, nothing sent, and the next normal song plays at tempo-map times. T0 probe agrees. |
| #10 | FAIL (F1) | PASS (F4 open) | Timing: 400 of 400 random tempo maps per head (delayed first tempo, up to 4 changes, 3 replays, stop/resume, seek then play, replay after seek) against an independent tempo map. 8 runs hit the D-005 legacy "next event at `maxTick` restarts" rule. State: F1 fixed at `6c0a353`. |
| #21 | PARTIAL (F1, F2) | PASS for song and scheduler state; PARTIAL for caller-timed automation (F3) | Seek fuzz 600 of 600 at `6c0a353` (JS state, next event, sends and notes for 3 s, all 48 channel params every 10 ms). Caller-timed 414 of 600, and 600 of 600 with R12b. Positioning at or past the end matches D-005 (fuzz targets include `maxTick` and `maxTick`+1). |

## Compatibility

- **Upstream differential** (`scripts/adv-compat.js`, 150 random songs × 2 builds per head; WebAudio traces against upstream + fork patches), identical at both heads:

  | Case | Identical traces |
  | --- | ---: |
  | Default loop wrap, `loopEnd` 0, 400 callbacks | 300 of 300 |
  | Load path (load while playing, load right after a stop) | 300 of 300 |
  | One finite pass | 300 of 300 |

- **Repository regressions:** differential, tempo and loop-end (3 of 3) pass at both heads.
- **Load-path trace at `6c0a353`** (`scripts/adv-trace.js`, 60 songs; `adversarial/trace-identity.json`):

  | Check | Result |
  | --- | --- |
  | Load while playing, just stopped or just ended, then play to the end (full traces against upstream) | 240 of 240 identical |
  | Seek with nothing queued, against `4610be9` | 120 of 120 identical, 0 cancels |
  | Seek with nothing queued, against upstream | 0 of 120 identical (T3 seeks rebuild state by design) |
  | Seek with events queued, against `4610be9` | 120 of 120 equal plus exactly 48 channel cancels (86 runs), or plus none when nothing was queued (34 runs) |

  The `reset()` move into `locateMIDI(0)` keeps the load trace identical.
- **Fractional tempo and the `loopEnd` fix:** unchanged. The tempo and loop-end regressions pass, and the scheduler fuzz model includes the `loopEnd` wrap.

## Tests: independence and mutations

**Independence.** Expected times come from an independent tempo map (`secondsAt`) and controller values from the MIDI specification. The seek oracle is differential, comparing against an uninterrupted first play on the same engine, which is acceptable for "seek ≡ play-through". Two weaknesses:
- `seekState` ignores pre-seek automation (it hid F1);
- tests pinned the residual at `4610be9`, and at `6c0a353` they pin "a later seek cancels nothing", which blocks the F3 fix.

**Mutations.** Every mutation rebuilds min.js from the mutated source, so both builds are mutated.

At `4610be9` (`mutation/summary.tsv`):

| Mutation | Result |
| --- | --- |
| R1: wrap gate on `maxTick` | **survived** |
| R2: SysEx-only song treated as silent | **survived** |
| R3: cancel when `p` or `playTime` is ahead (fix sketch) | fails only the residual-pinning test (4); parser and regressions pass |
| R4: seek applies events at `t <= tick` | killed (16) |
| R5: no 120 BPM tempo baseline | killed (18) |
| R6: requested tick past the end | killed (2) |
| R7: seek skips bend | killed (32) |
| R8: bound counts sends only | killed (2) |
| R9: replay resets tempo only | killed (8) |
| R10: seek writes deferred by 0.1 s | killed (4) |
| R11: high-water-mark cancel (fix sketch) | fails only the pin (4) |

At `6c0a353`:

| Mutation | Result |
| --- | --- |
| H1: wrap gate on `maxTick` | **survived** |
| H2: SysEx-only song treated as silent | **survived** |
| H3: `queued` never set | killed (16) |
| H4: cancel on load too | fails only the pin (4); parser and regressions pass |
| H5: `queued` not cleared | survived (benign) |
| H6: completion check without `playIndex` | killed (4) |
| R12: always cancel, keeping `queued` | fails only "a later seek cancels nothing" (4) |
| R12b: always cancel, without `queued` | fails only "a later seek cancels nothing" (4) |
| R13: track in the setters | passes all |

Totals: 14 behavioural mutations; 9 killed and 5 survived (R1, R2, H1 and H2 are the F7 gaps; H5 is benign). There are also 6 fix sketches (R3, R11, R12, R12b, R13, H4).

## Adversarial statistics

| Suite | 4610be9 | 6c0a353 |
| --- | --- | --- |
| Scheduler (`adv-scheduler.js`, seed 20261003; 107 fixed + 400 random cases × 2 builds; 20 s SIGKILL deadline each) | 1014 of 1014, 0 kills, at most 1000 events per callback, longest callback 151 ms (mock, loaded host) | 1014 of 1014, 0 kills, at most 1000, 48 ms |
| Seek equivalence (`adv-seek.js`, seed 21, 300 × 2) | 526 of 600 | 600 of 600 |
| Seek, caller-timed (seed 22) | not run | 414 of 600 (R12/R12b/R13: 600) |
| Replay timing (`adv-replay.js`, seed 10, 200 × 2) | 400 of 400 | 400 of 400 |
| Silent songs (`adv-silent.js`) | 128 of 128 | 128 of 128 |
| Upstream differential (`adv-compat.js`) | 900 of 900 | 900 of 900 |
| Chromium stale (replay / stop-seek-play / replay after 1 s; 5 runs × 2 builds) | 0/10, 0/10, 10/10 correct | 10/10, 10/10, 10/10 |
| Chromium flood (4 cases × 2 builds) | responsive; max lag 79 ms | responsive; max lag 17 ms |

The fixed scheduler cases cover:
- one-tick songs at ticks 0, 1, 960 and 2^20, each with `loopEnd` of 0, NaN, −480, 0.5, 1, T−1, T, T+1, 480 and 10^5, and with or without a trailing rest;
- same-tick batches of 999 to 20,000 events, with and without looping;
- 2^28−1-tick gaps;
- tempos of 1 µs and 16.7 s per quarter note at PPQ 1 to 32767;
- 1-day and 1-hour catch-up windows.

## Checks run

| Command | Where | Exit |
| --- | --- | ---: |
| `npm ci` | 4610be9 worktree | 0 |
| `npm run lint` | 4610be9 | 0 |
| `npm run verify` (min.js rebuilt byte-identical) | 4610be9 | 0 |
| `npm test` (unit 5 files / 260, node 6 / 105, regressions 3 of 3) | 4610be9 | 0 |
| `npm run pack:check` | 4610be9 | 0 |
| `npm run test:browser` (2 of 2) | 4610be9 | 0 |
| `npm run size` | 4610be9 | 0 |
| `npm ci`, `lint`, `verify`, `npm test` (unit 276, node 105, regressions 3 of 3), `pack:check`, `test:browser` | 6c0a353, full-history scratch clone | 0 each |
| `npm test` in a `git archive` copy of 6c0a353 | no `.git` | 1: only "upstream reference … needs full history"; environment artifact |
| T0 probes `issue-{8,9,10,21}-*.js` (60 s deadline) | both heads | 0 each |
| `adv-scheduler.js`, `adv-replay.js` (after correcting my expectation for the legacy restart: first run exit 1), `adv-silent.js`, `adv-compat.js`, `browser-probe.js`, `adv-stale.js`, `adv-followup.js`, `adv-misc.js`, `adv-trace.js` (first try killed at its 1200 s deadline for slowness; rerun with 60 songs) | both heads | 0 |
| `adv-seek.js` (always exits 0; results in JSON) | all trees | 0 |
| `run-mutations.sh`, `run-mutation-r11.sh`, `run-mutations-h6.sh`, `run-mutations-h6b.sh` | scratch copies | 0 (per-suite exits in `summary.tsv`) |

**Sizes** (`gzip -9 -n`):

| Build | min.js bytes | gzip | sha256 | Change from T2 |
| --- | ---: | ---: | --- | --- |
| T2 base `09922b9` | 36,975 | 9,875 | `45cc9778…` | |
| 4610be9 | 36,895 | 9,937 | `dbe097b6…` | −80 B / +62 B |
| 6c0a353 | 37,022 | 9,965 | `0892d76e…` | +47 B / +90 B |
| R12b on 6c0a353 | 36,917 | 9,939 | | −58 B / +64 B |

`npm run verify` confirms source and min.js parity at both heads, and every adversarial suite ran on both builds with identical outcomes.
