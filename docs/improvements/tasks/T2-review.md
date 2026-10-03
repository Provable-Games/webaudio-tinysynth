# T2 independent review: bounded SMF parsing (#4), unsupported divisions (#6), D-013

| Item | Value |
| --- | --- |
| Candidate | `t2/parser` at `f357e0f` (PR #32), base `25d2a3d` (improve/integration after G0), diff `25d2a3d..f357e0f` |
| Implementer record | `docs/improvements/tasks/T2.md` |
| Review branch / worktree | `t2/review` in `/workspace/webaudio-tinysynth-worktrees/t2-review` (only this file is added) |
| Evidence | `/workspace/webaudio-tinysynth-worktrees/_evidence/t2-review/`: `commands.tsv`, `logs/`, `fuzz/` (summary and per-case records), `browser-fuzz.json`, `parity/` and `parity-summary.json`, `compat-probes.json`, `perf.jsonl`, `probes/` (T0 #4/#6 probes rerun), `mutation/` (results, logs; scratch clone in `mutation/repo`), `size/` (variant builds, `variants*.json`, R3 patch), `scripts/` |
| Toolchain | Node v24.21.0 / npm 11.19.0 (`_evidence/t1-tooling/tools`), Terser 5.51.2 (pinned), Chromium headless shell 153.0.8010.12 via playwright-core 1.63.0 |
| PR #32 (read only) | 13 of 13 checks pass. The Claude and Codex reviews each raise one LOW: NOTICE and the source header are not updated (F6 below) |

## Verdict

**Accept with follow-ups.** I found no CRITICAL or HIGH defect.

The parser bounds every read, and it fails transactionally with correct `code`, `track` and `offset` values. Fuzzing found no hang, crash, uncaught non-`Error` throw, partial install or state change. The corpus was 939,930 cases in Node across both builds, plus 12,000 loads in Chromium. The case-by-case comparison against an independent oracle shows no mismatch. Valid files parse and play identically to upstream plus the fork patches: 6,008 files, with the load and playback WebAudio calls compared.

The follow-ups are:
- a wrong size attribution in T2.md, which should be fixed before the supervisor's size decision (F1);
- two cheap performance fixes (F2, F3);
- wording and ledger clarifications (F4, F5);
- the NOTICE update (F6).

## 1. Findings

### F1 MEDIUM: the T2.md §7 size attribution is invalid. The bounded parser is not size-neutral.

- **Where.** `docs/improvements/tasks/T2.md:156` and `_evidence/t2-parser/scripts/size-breakdown.py`.
- **Evidence.** The script empties messages with `re.sub(r'"(?!SMF_)[^"]*"', '""', body)` on the minified text. Any `"SMF_…"` literal makes the regex pair that literal's closing quote with the next opening quote. Most of `loadMIDI`'s code between the first message and the end of the region is deleted with them.
  - Reproduced: `_evidence/t2-review/size/implementer-nomsg.min.js` is 36,164 B, the number in T2.md. `node --check` fails with `SyntaxError: missing ) after argument list` (`size/implementer-nomsg.check.txt`).
  - A valid build with every message emptied and the codes kept is **36,719 B raw and 9,694 B gzip** (`size/V1-messages-emptied.min.js`). It passes `node --check` and the oracle fuzz.
- **Impact.** T2.md says the parser costs "nothing net (−208 B raw)" and that the messages are "all the growth (about 1,109 B)". The correct split of the +901 B raw is:
  - messages: **554 B raw / 297 B gzip**;
  - parser structure (bounds, `Fail`/`Need`, error properties, 240 B of code literals): **+347 B raw / +272 B gzip**, which is +0.95 % raw and +2.89 % gzip on its own.

  Shortening the messages therefore cannot remove all of the growth, which matters for the supervisor's review of the gzip growth over 5 %.
- **Fix.** Replace the §7 breakdown with build-based numbers, for example from §5 below. Measure variants by editing the source and running the pinned build, never by rewriting minified text.

### F2 LOW: `GetStr` decodes byte by byte. Large text and copyright metas cost about 32x their size in retained heap and run about 10x slower than the baseline.

- **Where.** `webaudio-tinysynth.js:674-678`.
- **Evidence** (`perf.jsonl`, one process per case):

  | Input | Load time | Peak RSS | Retained heap | Baseline |
  | --- | --- | --- | --- | --- |
  | 16 MB text meta | 1,774 ms | 740 MB | 518 MB (`song.text` is a 16 M-node rope) | `RangeError` |
  | 4 MB text meta | 484 ms | | 134 MB | `RangeError` |
  | 20,000 copyright metas of 128 B | 270 ms | | | 21 ms |

  Source and min behave the same.
- **Impact.** No hang and no failure, but a main-thread stall and a large retained allocation proportional to the text bytes present. The baseline threw a non-coded `RangeError` beyond about 120 KB, so T2 is functionally better. The onchain consumer's MIDI is small.
- **Fix (P1, +49 B raw).** Use the chunked form of the legacy `apply` decode:

  ```js
  for(var r="",k;len>0;i+=k,len-=k)
    r+=String.fromCharCode.apply(null,s.subarray(i,i+(k=len<8192?len:8192)));
  ```

  It gives the same strings. The 16 MB text then loads in 56 ms with 30 MB of heap, and the 20,000 copyright metas in 14 ms. The variant passes the oracle fuzz and the existing tests (§5).

### F3 LOW: channel-message arrays are built with `push`, which doubles the retained heap per channel event against the baseline.

- **Where.** `webaudio-tinysynth.js:720-724` (`for(m=[rs=v];k--;) … m.push(v)`).
- **Evidence.**
  - 4 MB of running-status events (2,097,153 events) loads in 339 ms with 552 MB of heap. The baseline takes 169 ms and 267 MB.
  - 1 MB: 62 ms and 148 MB, against 43 ms and 74 MB.
  - This is about 130 extra bytes per channel event. V8 gives a pushed one-element array literal spare capacity.
- **Impact.** Every valid file is affected, but only in memory and time. ws.mid's roughly 540 channel events cost about 70 KB more. Events are identical.
- **Fix (P2, +14 B raw).** Build the event with a literal and keep the per-byte check:

  ```js
  for(m=k>1?[rs=v,s[p],s[p+1]]:[rs=v,s[p]];k--;)
    if(s[p++]>0x7f) Fail(...,p-1);
  ```

  It restores 180 ms and 273 MB at 4 MB, with identical behavior (§5).

### F4 LOW: D-013 wording and the implementation differ on two points. Fix the wording, not the code.

- **Where.**
  - `decisions.md:144` says `track` is the "0-based chunk index". The code uses the 0-based MTrk index (`webaudio-tinysynth.js:653, 664-665, 706`): unknown chunks are not counted.
  - D-013 lists "a bad meta or SysEx length" under `SMF_MALFORMED`. The code reports a meta or SysEx length that runs past the chunk as `SMF_TRUNCATED`. T2.md §2 documents that choice. Only the tempo-length and End-of-Track-length cases are `SMF_MALFORMED`.
- **Evidence.** In `compat-probes.json` `unknownThenBad` (MTrk, XFIH, bad MTrk), both builds give `SMF_MALFORMED @50 t1`; the chunk index is 2.
- **Impact.** None at runtime. A caller reading D-013 would mis-map `track` for files with alien chunks. The MTrk index matches what users call "track n", and a parser cannot tell a cut file from an over-long length.
- **Fix.** Amend D-013: `track` is "the 0-based MTrk (track chunk) index; unknown chunks are not counted". A meta or SysEx length past the chunk end is `SMF_TRUNCATED`.

### F5 LOW: an understated chunk length that lands on an event boundary now loads a silently truncated song. The baseline loaded the whole track, and ledger L-01 does not mention this.

- **Where.** The missing-End-of-Track recovery (`webaudio-tinysynth.js:709-761`), together with ignoring bytes after the last needed chunk.
- **Evidence** (`compat-probes.json` `lengthEdits`). For every MTrk, I set the declared length to each event boundary inside it:

  | File | Boundaries | Silent partial loads | Errors | Baseline |
  | --- | ---: | ---: | ---: | --- |
  | all-gm-sounds.mid | 1,198 | 1,197 | 0 | full song at all 1,198 |
  | the 6 test-midi tuning fixtures | 18 to 3,884 each | all but 2 in each | 0 | full song at every boundary |
  | ws.mid (8 tracks) | 573 | 14 | 558 (`SMF_TRUNCATED`) | full song at 15 |

  Overstating the last chunk by 1 byte fails with `SMF_TRUNCATED` on every fixture, where the baseline loaded the song (documented in T2.md §3).
- **Impact.** This follows the #4 and D-013 policy, since an understated length is indistinguishable from a missing End-of-Track. A file with a corrupted length can therefore play partially without any error. I have no evidence that real writers emit such lengths, so I do not recommend a code change, which would cost bytes.
- **Fix.** Add one sentence to ledger L-01 and to the README contract (T9/#20): "an understated track length on an event boundary loads only the declared part".

### F6 LOW: NOTICE and the source header's modification list are not updated (deployment contract, `contracts.md:55`). This is outside T2's allowed files.

- **Where.** `NOTICE:11-24` and `webaudio-tinysynth.js:5-8`. Both PR #32 AI reviews raise it, and T2.md §8.2 acknowledges it.
- **Note.** The license header comment is kept in min.js (`scripts/build.js` `licenseHeader`), so a header bullet costs raw onchain bytes, about 60 to 90 B per line. NOTICE is free. The `loadMIDI` doc comment is stripped and costs 0 B.
- **Fix.** Supervisor follow-up. Add a NOTICE bullet. Optionally add one short header line, and if so, rebuild.

### F7 LOW: test observations. None hides a defect.

- **Timbres not asserted.** `tests/harness.js:339` `playbackState` omits `program` and `drummap`, so D-013's "timbres unchanged" claim is not asserted by the tests. My fuzz did assert it: custom timbres and `program`/`drummap` JSON were unchanged in every failing case. The parser never touches timbres. Adding the two arrays to `playbackState` would close the gap.
- **Cascading failures.** `tests/node/parser-compat.test.cjs:128-137` shares the playing synths across the "documented differences" tests. One regression cascades into unrelated failures: mutant M8 also failed the SMPTE test. This only affects diagnosis; no test passes falsely.
- **Equivalent mutant.** Mutant M6, which removes `if(tr) this.notetab.length=0` (`webaudio-tinysynth.js:765-766`), survives. The line is redundant after `stopMIDI()`, whose `allSoundOff(0..15)` already splices those notes. It only differs for notes on channels outside 0 to 15 created through the public API. It is legacy-faithful, so keeping it is fine.

### Observations (no change requested)

- **Running status after a meta or SysEx event, or across tracks.** T2 rejects all of these with `SMF_MALFORMED`. The baseline was not usable on them either (`compat-probes.json`):
  - after a meta event: hung (vm timeout of 500 ms);
  - across tracks: hung;
  - after a SysEx event: loaded garbage. The note-off became `[0xf0]`, so the note stuck.
  - the legacy file-wide `0x90` initial status: the only variant the baseline handled. It requires a file whose very first event omits its status byte.

  So T2 regresses no file the baseline could play. A DAW file that relies on running status after a meta event fails descriptively instead of hanging or loading garbage, as the baseline did on the probes. If such files appear in practice, a tolerant variant that keeps the last channel status across metas is a small, separate decision. It contradicts the SMF specification text that D-013 cites.
- **Fewer track chunks than `ntrks`.** For example, an XMODEM-padded file with `ntrks` too high now fails (`SMF_TRUNCATED @250 t1`). The baseline loaded it. This is per D-013 ("fewer chunks than declared"). A correct file followed by zero padding still loads.
- **Non-buffer arguments (T5 scope).** `loadMIDI(-1)` throws a non-coded `RangeError` from `new Uint8Array`, before any mutation. A `DataView` reads as empty (`SMF_INVALID_HEADER`), as before. A `Uint8Array` view is copied correctly.

## 2. Per-criterion verdicts

### Issue #4: met

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| Every read is bounded by the chunk end and the file end: header fields, VLQ, status, channel payload, meta type, length and payload, SysEx length and payload | Met | Code review: header reads need n ≥ 8 + len ≥ 14; every chunk satisfies `end ≤ n`; `Need`/`Vlq` bound every track read by `end`; the tempo read follows `Need(3)`. Fuzz: 0 oracle mismatches over all cut points and lengths |
| Unsigned lengths; no allocation from a declared length | Met | MThd and MTrk lengths of 0xFFFFFFFF, SysEx and meta lengths of 0x0FFFFFFF, and `ntrks` 65,535 on a tiny file each fail in about 0.3 ms, with a 2 MB heap delta in total (`compat-probes.json` `hugeDeclared`). Allocation is proportional to the bytes present (see F2 and F3 for the constants) |
| VLQ of at most 4 bytes | Met | Fuzz; mutant M1 is killed |
| Running status per track, cancelled by meta and SysEx | Met | Fuzz; mutants M3 and M4 killed, implementer's D killed |
| Channel, meta and SysEx payloads validated; tempo exactly 3 bytes and nonzero; End-of-Track length 0 | Met | Fuzz; mutants M7, M8, M13 and M23 killed |
| Format 2 and unknown formats rejected | Met | Mutant M10 killed |
| Unknown chunks skipped | Met | Mutant M12 killed |
| Temporary state, installed only after validation; no partial event | Met | 0 invariant violations in 939,930 cases plus 12,000 in Chromium; mutants M14 and M15 killed |
| Missing End-of-Track: accepted only on an event boundary, documented, no bleed into the next track | Met | Tests and fuzz. Recovery documented in the source comment and T2.md. Its side effect is F5 |
| Valid-file ordering, fractional tempo and `maxTick` preserved | Met | Parity on 6,008 files (§3); mutants M19 and M22 killed |
| Hang regressions run in a child process with an external deadline | Met | `tests/node/parser.test.cjs` (30 s, SIGKILL). The implementer's mutation C was killed at the deadline |

### Issue #6: met

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| Reject high-bit (SMPTE) divisions | Met | `0xE728`, `0xE850`, `0xE350`, `0xE250`, `0xE204`, `0xE801`, `0x8000` and `0xFFFF` give `SMF_UNSUPPORTED_DIVISION` at byte 12 with "SMPTE division 0x…". T0 probe rerun: `probes/issue-6-time-division.jsonl` |
| Reject zero PPQ and truncated division fields | Met | Header cut at 12 or 13 bytes gives `SMF_TRUNCATED`; zero PPQ gives `SMF_UNSUPPORTED_DIVISION`. Mutant M11 killed |
| Previous song kept; valid PPQ timing and fractional tempo unchanged | Met | Unit tests for PPQ 1, 96, 480 and 32767; parity; transactional fuzz |
| Document the supported format and division contract | Partly met | In the `loadMIDI` comment and T2.md. README pending (T9/#20) |

### D-013: met, with the F4 wording fixes

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| Throws an `Error` with a stable `code` from the five | Met | `[object Error]`, `name === "Error"`, code in the set, for every failure in both engines and builds |
| `track` and `offset` where applicable | Met | `offset` is always an integer in [0, n]. `track` is absent exactly for header errors. The message ends with `(track t, byte o)`. Values agree with the oracle in every case. The `track` semantics differ from D-013's wording (F4) |
| Failed loads are side-effect free | Met | Unchanged after every failure: song identity, `maxTick`, `playTick`, `playIndex`, `playing`, `playTime`, `tick2Time`, the channel and tuning arrays, `notetab`, and `program`/`drummap` including custom timbres. There were no WebAudio calls and no notes, with notes sounding at the time of each failed load |
| Successful loads keep the legacy effects | Met | WebAudio calls of the load (stop, reset, locate) and of 400 ms of playback are identical to the baseline on 6,008 files, each replacing a playing song |
| Legacy differences recorded in L-01 to L-03 | Met | Each one judged in §3. F5 should be added to L-01 |

## 3. Valid-file compatibility

**Parity** (`scripts/parity.js`, `parity-summary.json`). The reference is upstream `3d75aee` plus `FORK_PATCHES`, loaded under a 2 s vm timeout. It ran in lockstep with both builds in one process.

- **Files:** 6,008, all identical on load (song, `maxTick`, status, `playIndex` and the load's WebAudio calls) and on 400 ms of playback.
- **Composition:** the 8 repository fixtures and 6,000 generated files, with 777,215 events in total.
- **Feature coverage of the generated files:**
  - running status within a track in about 5,500 files;
  - SysEx F0 and F7 escape packets: 5,297;
  - tempo changes with random 24-bit values, giving fractional BPM: 5,221;
  - text metas (types 1, 3, 4 and 9, bytes 0 to 255): 4,704;
  - copyright under 128 B: 3,241;
  - several tracks of different lengths: 3,431;
  - format 0 with several tracks: 502;
  - header longer than 6 bytes: 1,177;
  - 4-byte delta-times: 3,516;
  - empty tracks;
  - `ntrks` 0 is in the repository tests.

**Documented differences, judged:**

| T2 difference | Justified by | Realistic-file risk (evidence) | Recommendation |
| --- | --- | --- | --- |
| Strict chunk fit even when End-of-Track is present | #4 ("validate … chunk lengths"), D-013 `SMF_TRUNCATED` | Overstated last length: the baseline loaded, T2 errors (all 8 fixtures). No known writer does this | Keep |
| Unknown chunks not counted as tracks | SMF 1.0 ("alien chunks … ignored"), D-013 | Improvement: the baseline dropped the last track | Keep |
| Exact copyright text of 128 B or more | Bounded reads (#4). The baseline read 1 byte past the payload | `song.copyright` loses a stray byte (2,580,000 against 2,560,000 characters in `perf.jsonl`) | Keep |
| Non-`MThd` input throws | D-013. Previously it stopped playback and returned | RIFF RMID callers now get `SMF_INVALID_HEADER` and playback continues | Keep |
| No legacy `0x90` or cross-track running status; no running status after meta or SysEx | SMF 1.0, D-013 | The baseline hung or produced garbage on all but the first-event `0x90` form (Observations) | Keep |
| Understated length on an event boundary gives a partial song | #4 recovery policy | F5 | Document in L-01 |

## 4. Fuzz statistics

**Node, mock WebAudio** (`scripts/fuzz.js` and `fuzz-child.js`, seed 20261003, `fuzz/summary.json`).

**Setup.**
- 470 child processes ran, 24 in parallel. Each had a 120 s external deadline with SIGKILL and `--max-old-space-size=256`.
- Each child printed `S <i>` before every case.
- A previous song was playing, with sounding voices, a manual program change and custom timbres, and was re-established after every successful load.

**Checks on every case.**
- Every failure was checked for: a coded cross-realm `Error`, `offset`, `track` and message format, an unchanged state snapshot (including timbres), song identity, no WebAudio call and no note.
- Every case was checked against an independent oracle written from SMF 1.0 and T2.md §2 (`scripts/fuzz-lib.js` `oracle`): code, offset and track, or the full song and `maxTick`.
- The two builds were compared case by case on the full signature, including the message text.

| Mode (per build; ×2 builds) | Cases | Loaded | Errors by code | Oracle mismatches | Invariant violations | src/min differences |
| --- | ---: | ---: | --- | ---: | ---: | ---: |
| exhaustive: every prefix, single-bit flip, and byte set to {00,7F,80,F0,F7,FF,2F,51} of 5 small fixtures and 2 generated files | 129,965 | 107,690 | TRUNCATED 10,272, MALFORMED 11,263, INVALID_HEADER 496, FORMAT 203, DIVISION 41 | 0 | 0 | 0 |
| mutate: 1 to 4 of 18 operators on 8 fixtures and 50 generated files. Operators: truncation, bit flips, random and interesting bytes, chunk lengths set to {0, 1, ±1, ±k, 0x7FFFFFFF, 0x80000000, 0xFFFFFFFF}, 1 to 10 continuation bytes, inserted F0/F7/FF with 0x0FFFFFFF or 5-byte lengths, End-of-Track removal, splice, chunk duplicate or drop, id swaps, header field edits | 200,000 | 21,409 | TRUNCATED 77,979, MALFORMED 48,560, INVALID_HEADER 20,085, FORMAT 16,073, DIVISION 15,894 | 0 | 0 | 0 |
| soup: structured random chunks and tokens, random header fields, `ntrks` up to 65,535 | 100,000 | 13,655 | MALFORMED 35,162, TRUNCATED 23,545, DIVISION 10,933, FORMAT 8,966, INVALID_HEADER 7,739 | 0 | 0 | 0 |
| valid (parity-safe generator) | 20,000 | 20,000 | none | 0 | 0 | 0 |
| validx (adds unknown chunks, long copyright, missing End-of-Track, bytes after End-of-Track, extra chunks, trailing bytes) | 20,000 | 20,000 | none | 0 | 0 | 0 |

**Totals and timing.**
- 469,965 cases per build, **939,930 in total**: 0 hangs, 0 child failures or kills, 0 non-coded throws, 0 partial installs, 0 state changes.
- Wall time was 45.5 s.
- The slowest case was 29.6 ms, a one-off scheduling or GC pause on a 4.5 KB file; rerun, it took 0.08 to 0.47 ms. Every other case took under 10 ms.
- Peak heap per child was 157 MB.

**Chromium** (`scripts/browser-fuzz.js`, `browser-fuzz.json`). 6,000 sampled cases (mutate 2,500, soup 1,200, exhaustive 1,500, valid 400, validx 400) were run against both builds in one page, with a real AudioContext and the network blocked: **12,000 loads**.
- Results: 0 oracle mismatches, 0 differences between the builds, 0 message differences from the Node source build, 0 invariant violations (song identity, state and timbre snapshot, still playing), 0 non-coded throws, 0 page errors.
- Every code occurred: TRUNCATED 2,688, MALFORMED 2,324, INVALID_HEADER 720, DIVISION 672, FORMAT 618; loads 4,978.

**Large inputs** (`perf.jsonl`, one process per case, both builds and the reference):

| Input | src | min | Baseline |
| --- | --- | --- | --- |
| 65,535 empty MTrk chunks | 1.2 ms | 1.1 ms | crashed with heap OOM (exit 134) |
| 500,000 unknown chunks | `SMF_TRUNCATED` in 2.5 ms | 2.4 ms | |
| 16 MB text cut by 10 bytes | `SMF_TRUNCATED` in 0.2 ms, no string built | 0.2 ms | |

Text, copyright and running-status inputs are under F2 and F3.

**T0 probes rerun** (`probes/`, both builds):
- **#4:**
  - `eot-removed-len-kept`, `cut-at-40` and `ws.mid-cut-at-40` give `SMF_TRUNCATED` in about 1 ms;
  - `eot-removed-len-fixed` loads 8 events, `maxTick` 1680;
  - `fmt1-no-eot-then-valid` loads 10 events, `maxTick` 1680.
- **#6:** all four SMPTE encodings and PPQ 0 are rejected; the 12- and 13-byte headers give `SMF_TRUNCATED`; the PPQ-480 control plays as before.

## 5. Tests and mutations

**Tests.**
- The tests use independent expectations:
  - offsets are computed from the generated layout;
  - expected events come from the writer's input;
  - parity comes from the reference parser;
  - SMPTE and PPQ timings come from the specification.
- They cover:
  - `0xE728` and 7 other high-bit divisions, zero PPQ, header cuts at 4/7/8/9/12/13 bytes;
  - every prefix of ws.mid and of a generated format-1 file;
  - the final 4 End-of-Track bytes removed;
  - missing End-of-Track alone (one event, and an empty chunk), followed by a second track, in a complete chunk, and after a final meta;
  - format 2, unknown chunks, a header longer than 6 bytes, and valid PPQ files.
- Hang cases run under a 30 s external deadline. Both builds are exercised.
- Gaps are listed in F7.

**Mutations.** I ran these in a scratch clone (`mutation/results.json`, logs in `mutation/logs/`). I mutated only the source build and ran `tests/unit/parser.test.mjs`, `tests/node/parser.test.cjs` and `tests/node/parser-compat.test.cjs`. The unmutated control passes. **25 of 26 mutants are killed**; M6 is equivalent (F7).

| Mutant | Killed by |
| --- | --- |
| M1 VLQ allows 5 bytes | node, 3 failures |
| M2 `0xD0` takes 2 data bytes | parity "every event kind" |
| M3 SysEx keeps running status | node |
| M4 meta keeps running status | node |
| M5 SysEx offset `p` instead of the event start | node, exact offset |
| M6 `notetab` clear removed | **survived**, equivalent (F7) |
| M7 tempo 0 accepted | node |
| M8 End-of-Track length accepted | node, 5 failures |
| M9 header length 5 accepted | unit |
| M10 format 2 accepted | unit and node |
| M11 zero PPQ accepted | unit |
| M12 unknown chunk counted as a track | unit and node |
| M13 channel-message bound removed | node |
| M14 install before validation | unit 29, node 9 |
| M15 `stopMIDI` before validation | unit 3, node 12 |
| M16 `GetStr` drops the last character | unit and node (fixture parity) |
| M17 copyright overwritten | unit |
| M18 text type 0x09 ignored | unit and node |
| M19 no sort | node |
| M20 `track` on header errors | unit, 28 failures |
| M21 F7 events keep the 0xF7 prefix | unit and node |
| M22 tempo floored | unit and node |
| M23 data-byte check removed | node, 7 failures |
| M24 system status skipped | node, 8 failures |
| M25 track loop runs to `p<=end` | node |
| M26 tolerant chunk fit when End-of-Track is present | node, 12 failures |

The implementer's mutations A, C, D and E (T2.md §6) are not repeated here.

## 6. Size analysis (min.js, pinned Terser)

**Where the +901 B raw goes.**
- `loadMIDI` in min.js grows from 1,428 to 2,329 B.
- Its string literals take 805 B:
  - error-code literals, 240 B: `"SMF_MALFORMED"` ×6, `"SMF_TRUNCATED"` ×4, `"SMF_INVALID_HEADER"` ×2, `"SMF_UNSUPPORTED_FORMAT"` and `"SMF_UNSUPPORTED_DIVISION"` ×1 each;
  - message text and punctuation, 565 B.
- A valid emptied-message build attributes **554 B to messages** and **347 B to the parser structure** (F1).
- The 10-line `loadMIDI` doc comment is stripped (0 B). The license header is kept.

**Variants.** Each was built from an edited source with `scripts/build.js` (`scripts/size-variants.js`, `size/variants.json`). Every variant except V1 and V7 was rerun through the oracle fuzz on both builds (mutate 20,000, soup 10,000, valid 2,000, validx 2,000 per build): 0 mismatches and 0 invariant violations. V1 and V7 change the message format.

| Variant | Raw B | gzip -9 -n B | vs T2 raw | vs T1 baseline raw | gzip vs baseline |
| --- | ---: | ---: | ---: | ---: | ---: |
| T2 as is (`5ccdd798…`) | 37,273 | 9,991 | 0 | +901 (+2.48 %) | +6.04 % |
| V1 messages emptied (attribution only) | 36,719 | 9,694 | −554 | +347 (+0.95 %) | +2.89 % |
| V2 short descriptive messages | 37,052 | 9,891 | −221 | +680 (+1.87 %) | +4.98 % |
| V3 `"SMF_"` prefix added inside `Fail` | 37,228 | 9,993 | −45 | +856 | +6.06 % |
| V4 V2 + V3 | 37,007 | 9,894 | −266 | +635 (+1.75 %) | +5.01 % |
| V5 V2 + numeric code table | 36,938 | 9,897 | −335 | +566 (+1.56 %) | +5.04 % |
| V8 V2 + local constants `TRUNCATED`/`MALFORMED` | 36,948 | 9,894 | **−325** | +576 (+1.58 %) | +5.01 % |
| V6 drop the `(track t, byte o)` message suffix | 37,229 | 9,967 | −44 | +857 | +5.78 % |
| V7 V5 + V6 (floor; message loses context) | 36,894 | 9,874 | −379 | +522 (+1.44 %) | +4.80 % |
| P1 chunked `GetStr` (F2 fix) | 37,322 | 10,020 | +49 | +950 | +6.35 % |
| P2 literal channel arrays (F3 fix) | 37,287 | 9,995 | +14 | +915 | +6.08 % |
| **R3 = V8 + P1 + P2 (recommended)** | **37,011** | **9,927** | **−262** | **+639 (+1.76 %)** | +5.36 % |
| R2 = V5 + P1 + P2 | 37,001 | 9,930 | −272 | +629 (+1.73 %) | +5.39 % |

**Recommendation.** Adopt R3. The patch is `size/R3_V8+P1+P2_.diff`, about 20 changed lines in `loadMIDI`.
- **Size.** It saves **262 raw bytes** (37,273 to 37,011 B; growth +901 to +639 B, +1.76 %). This is the cost that matters onchain.
- **Performance.** It fixes F2 and F3.
- **Contract.** Codes, `track`, `offset`, the message format `"<code>: <message> (track t, byte o)"` and every message's subject are unchanged.
- **Tests.** The existing parser tests (86 unit, 41 node) and the 3 regressions pass unchanged on R3 in the scratch clone.

The messages become, for example:
- "VLQ over 4 bytes"
- "event past chunk end"
- "chunk past file end"
- "no track 1 of 2"
- "no running status"
- "bad data byte"
- "bad tempo"
- "bad status 0xf8"
- "SMPTE division 0xe728"
- "format 2"

If the performance fixes are deferred, V8 alone saves **325 B**. Numeric codes save only 10 B more than local constants and read worse. Dropping the suffix saves 44 B more, but the uncaught `loadMIDIUrl` errors would then lose their location until T5.

gzip stays above 5 % for every variant that keeps descriptive messages, except V2 (+4.98 %). Since onchain storage pays raw bytes, I recommend that the supervisor accept the gzip overage rather than shorten the messages further. If NOTICE's header bullet (F6) is added to the source header, budget about 60 to 90 B more.

## 7. Checks run

| Command | Exit | Time | Result |
| --- | ---: | ---: | --- |
| `npm ci` | 0 | 0.57 s | 0 vulnerabilities |
| `npm run lint` | 0 | 0.42 s | |
| `npm run verify` | 0 | 0.25 s | distribution matches the pinned build: min.js `5ccdd798…`, 37,273 B, 9,991 B gzip |
| `npm run pack:check` | 0 | 0.49 s | |
| `npm test` | 0 | 61.5 s | unit 4 files and 116 tests (floor 116); node 5 files and 74 tests (floor 74); regressions 3 of 3 |
| `npm run test:browser` | 0 | 4.9 s | 2 of 2 |
| `node --check` on webaudio-tinysynth.js and on .min.js | 0 / 0 | | |
| Style and constraints (`logs/style-checks.log`) | 0 | | Non-ASCII bytes: 0 in all changed files. Tabs: 0. Odd indentation only in the aligned comment block. `</script`, `<script`, `<!--`: 0. Every diff hunk is inside `loadMIDI` (lines 648 to 770). `package.json` changes only the two floors. There is no `"type": "module"` and no export change |
| T0 probes `issue-4-unterminated-tracks.js` and `issue-6-time-division.js` under `timeout -s KILL 60` | 0 / 0 | | as in §4 |
| `node scripts/fuzz.js fuzz exhaustive:0 mutate:200000 soup:100000 valid:20000 validx:20000` | 0 | 46 s | §4 |
| `node scripts/browser-fuzz.js` (Chromium) | 0 | 2.5 s in the page | §4 |
| `node scripts/parity.js <seed> 500` ×12 (seed 101 also runs the fixtures), each under `timeout -s KILL 1200` | 0 ×12 | | 6,008 of 6,008 identical |
| `node scripts/compat-probes.js` | 0 | | §1 F4, F5 and Observations |
| `node scripts/perf-one.js <build> <case>` ×33 under `timeout -s KILL 120` | 0, except the reference `emptyMTrk65535` (134, heap OOM, baseline bug) | | F2, F3, §4 |
| `node scripts/mutate.js` | 0 | | 25 of 26 killed |
| `node scripts/size-variants.js [--check] [--perf] [--diff]` | 0 | | §6. The clone was restored to `f357e0f` afterwards (`git status` clean) |
| R3 in the scratch clone: `vitest run tests/unit/parser.test.mjs`, `node --test tests/node/parser*.test.cjs`, `node scripts/run-regressions.js` | 0 / 0 / 0 | | 86, 41 and 3 of 3 passed |
| `gh pr checks 32` and the issue-comments API (read only) | 0 | | 13 of 13 pass. The AI reviews raise one LOW each (F6) |
