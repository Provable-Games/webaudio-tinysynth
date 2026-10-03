# T4 independent review: lifecycle (#11 disposal and replacement, #12 injection and gesture start, D-023 stop)

| Item | Value |
| --- | --- |
| Candidate | `t4/lifecycle` at `2fe1882` (PR #37), merge base `f1d5c8f` with `improve/integration` (`542cd4e`); diff `improve/integration...t4/lifecycle` |
| Implementer record | `docs/improvements/tasks/T4.md` (§2 post-dispose table, §5 WebKit/Chromium history) |
| Review branch / worktree | `t4/review` in `/workspace/webaudio-tinysynth-worktrees/t4-review`. Only this file is added. |
| Evidence | `/workspace/webaudio-tinysynth-worktrees/_evidence/t4-review/`: `logs/` (`commands.tsv`, every command log, PR #37 reads, probe outputs), `results/` (matrix `results.json` per run), `scratch/` (mock probes `probe-mock.cjs`, `probe-codex.cjs`, `exports.cjs`; `scratch/repo/` = the candidate plus the reviewer's browser spec `tests/browser/specs/review.js`, run on T6's runner), `mutation/` (`run-mutations.py`, per-mutant logs, `summary.json`), `size/` (`variants.py`, `minify.cjs`, `out/<variant>/` sources and min builds, `browser-variants.sh`), `fix-proto/` (the F1 fix prototype), `builds/` (base `b49e8ceb` builds, upstream `3d75aee` reference) |
| Toolchain | Node 24.21.0 / npm 11.19.0; pinned Terser 5.51.2; playwright-core 1.63.0 with Chromium 153.0.8010.12, Firefox 155.0, WebKit 26.6 (`_evidence/t6-validation/env.sh`, T6's PulseAudio null sink) |
| Specs | #11, #12 (`_evidence/issues`), D-011, D-013, D-018, D-019, D-023 (worktree `decisions.md`), D-024 (integration `decisions.md`), ledger L-11 and the ownership contract (`contracts.md`) |
| PR #37 (read only) | At `2fe1882` all 16 checks completed successfully (CI, Browser matrix ×3, review gates). Claude: one MEDIUM (= F1a) and one LOW (= F5). Codex: three MEDIUM and one LOW (= F1b, F2, F3, F10) plus an inline P2 (= F8). Every AI finding was reproduced or bounded below. |

## Verdict

**Changes requested: one MEDIUM regression (F1) needs a fix or an explicit supervisor acceptance; the rest is LOW and cheap.**

- **#11 (disposal and replacement): PASS.** Instrumented construct, play, replace and dispose cycles leave no interval, no active owned source and no live connection, in Chromium, Firefox and WebKit, source and min. Double dispose returns the same promise; caller-owned contexts stay open and running; only synth-created contexts are closed, and `dispose()` resolves after the close: in Firefox and WebKit the context already reads `closed` in the resolution callback and the context's own `close()` promise has resolved first (reviewer S1/S1b, which a resolve-early mutant fails there); Chromium closes at once, so it cannot tell. Disposing with drums sounding and scheduled ahead, a sustained note, a held note, a release tail, a playing transport and a pending URL load leaves exact silence 60 ms later and starts nothing. Every public method, attached and detached, is a safe no-op after `dispose()` for 1.5 s of running timers. Remaining LOW: F3 (teardown on a context the caller already closed leaves its routes), F9 (`init()` called again leaks an interval).
- **#12 (injection and gesture start): PASS with LOW findings.** An injected context creates no other context and routes to the given destination (offline gain test and live analyser test). `lazy` creates nothing before first use. Real click and key gestures under the default autoplay policy start lazy, injected and default synths in all three engines (T4 start spec, D-011 method). Resume rejections are observable and there are zero unhandled rejections, including `send()`/`playMIDI()`/seek on a suspended (no gesture) or closed context. `SYNTH_DISPOSED`, `AUDIO_CONTEXT_CLOSED` and `AUDIO_CONTEXT_OFFLINE` behave as documented. OfflineAudioContext renders are no longer pruned by the timer and repeat exactly. LOW: F2 (resume coalescing is per instance, not per context), F4 (guarded methods lose `length` and `name`), F5 (`reset()` creates a lazy context, contrary to the README), F6 (`loadMIDI` creates a lazy context; judged a defensible but costly choice), F7 (offline direct scheduling silently drops notes beyond `voices`).
- **D-023 (stop): the stop itself PASSES; F1 must be resolved before integration.** A caller's `stopMIDI()` silences sounding and scheduled drum hits and cancels queued volume, pan and modulation automation, verified audibly in all three engines and both builds, also with the consumer's swapped `chvol` nodes. The load path keeps the upstream trace (the differential test fails as soon as the load uses the full stop). But the cancel leaves the transport and the channel state ahead of the graph: **F1 (MEDIUM)**, stop-then-play (the demos' Stop/Play buttons) resumes channels at the wrong volume and pan, 16× (+24 dB) louder and centred instead of panned in the reviewer's test, in 3 of 3 engines × 2 builds, while the base build is correct. A 196 B raw / 68 B gzip transport rewind fixes the resume path: every existing test passes, and the resumed note matches a straight play in all three engines and both builds (§3.3).
- **Compatibility:** defaults stay legacy (eager context, warm-up note, `ready()`; the differential test is identical to upstream plus the tempo patch); CommonJS, AMD and global exports and detached `dispose`/`resume` work in both builds; T2 and T3 tests and the upstream differential, tempo and loop-end regressions pass unchanged. The 13 guarded methods report `length` 0 and `name` "" in both builds (F4); per-method guards restore both and are smaller in gzip.
- **Size (D-024, gzip):** +1,127 B gzip (+11.3 %) over `b49e8ceb`. A behavior-preserving combination (C5: code-only lifecycle messages, `ready()` without polling, compact option checks, per-method guards) saves **407 B raw / 195 B gzip** and fixes F4; with the F1, F2 and F3 fixes added (C7) the net is **−184 B raw / −123 B gzip** against the candidate, and dropping `_gone` and the start-up oscillator tracking, which no browser check needs, brings it to −341 / −169 B (§6).

## 1. Findings

Severity: MEDIUM blocks integration unless the supervisor accepts it; LOW should be fixed or recorded; INFO needs no action.

### F1 (MEDIUM) `stopMIDI()`'s cancel leaves the transport and the channel state ahead of the audio graph

- **Where:** `webaudio-tinysynth.js:762-763` (the D-023 cancel), with `:509-548` (the scheduler dispatches song events up to 0.2 s ahead and advances `playIndex`), `:766-791` (`playMIDI()` resumes "as it is", comment at `:771`) and `:1093-1104` (`setChVol`/`setExpression` update `vol[ch]`/`ex[ch]` at once but only schedule the gain).
- **(a) Pause and resume, browser evidence.** Reviewer spec `review.js` S5: a song with CC7=20 and CC10=0 on channel 0 at tick 48 (due 0.15 s after `playMIDI()`) and a note at tick 960. `playMIDI()`, wait until the scheduler has sent the CCs, `stopMIDI()` (17–70 ms after the start, before they were due), `playMIDI()`. Peak of the resumed note, left/right, against a straight play of the same song:

  | Build | Engine | Straight play L / R | Stop, then play L / R |
  | --- | --- | --- | --- |
  | base `b49e8ceb` | Chromium / Firefox / WebKit | 0.0150 / 0 · 0.0132 / 0 · 0.0150 / 0 | 0.0149 / 0 · 0.0130 / 0 · 0.0149 / 0 (correct) |
  | candidate, source and min | Chromium / Firefox / WebKit | 0.0150 / 0 · 0.0132 / 0 · 0.0151 / 0 | **0.248 / 0.248 · 0.208 / 0.208 · 0.248 / 0.248** |

  The cancelled CC7 and CC10 are never sent again (the transport already moved past them), so the channel keeps the reset level (gain 1.86 instead of 0.074) and the centre pan for the rest of the song, while `vol[0]` says 0.074. Mock replay of the recorded automation agrees (`logs/probe-pause-resume.txt`). Any CC change in the last 0.2 s before a stop is affected, which is likely right after a start or a seek, and with expression-heavy songs at any time. All three demo pages (`simple.html`, `jstest.html`, `soundedit.html`) use Stop/Play as pause/resume.
- **(b) Later CCs reuse cancelled values** (PR #37 Codex, reproduced): `setChVol(0,0,now+1); stopMIDI(); setExpression(0,100)` cancels the queued mute, then the CC11 schedules gain 0 from the retained `vol[0]=0` (`logs/probe-codex.txt`). In the base build the mute was simply applied at `now+1`, so the state and the sound agreed.
- **Cause.** D-023's cancel is applied without undoing what the cancelled automation stands for: the transport position and the instance state. Seeks are unaffected because `locateMIDI()` rebuilds both.
- **Fix (recommended for (a)): rewind the transport in the caller's `stopMIDI()`** over the song events sent ahead and not yet due, so a resume sends them again. Prototype (`fix-proto/compact/`), inside `if(c){`:
  ```js
  for(;p && (v=s.ev[this.playIndex-1]) && v.m[0]!=0xff51 && (i=this.playTime-(this.playTick-v.t)*this.tick2Time)>c.currentTime;--this.playIndex)
    this.playTime=i, this.playTick=v.t;
  ```
  with `p=this.playing, s=this.song` read before `_halt()`. It does not cross a tempo event (rare inside 0.2 s). +196 B raw / +68 B gzip. With it, all 416 unit tests, all node tests and the three regressions pass, the mock probe hears CC7 and CC10 correctly after a resume, and the browser runs are in §3.3. Side effects: notes cut inside the lookahead are replayed on resume (upstream lost them), and `curTick` after a stop moves back by at most 0.2 s of ticks. A resume-as-seek alternative (`locateMIDI(playTick)` in `playMIDI`) is smaller (+61 / +13 B) but breaks T3's tested contract that a stopped song keeps manual overrides (6 transport unit tests fail), so it is not recommended.
- **For (b):** keep the instance values in step with what the graph will play. Either accept (b) as a documented residual of D-023 for caller-timed changes (the rewind fixes the transport-dispatched ones, which re-send their values on resume), or make `stopMIDI()` cancel and restore the state together (requires storing the applied volume/expression separately; pan and modulation have no stored state). Supervisor decision; (a) should not ship as is.

### F2 (LOW) `send()`'s resume coalescing is per instance, not per context

- **Where:** `webaudio-tinysynth.js:577-578` (`this._rq`).
- **Evidence** (PR #37 Codex, reproduced in `logs/probe-codex.txt`): construct on suspended context A and call `setAudioContext(B)` (B suspended) and `send()` in the same task. A's warm-up note sets `_rq`, so B is never asked to resume in that task; the base build asks B three times. This is the classic upstream pattern `new WebAudioTinySynth(); synth.setAudioContext(myCtx)` when run inside a gesture handler with a pre-existing context.
- **Impact:** the context is not resumed within the gesture's task. Later `send()` calls (the scheduler's, in later tasks) ask again, which recovers in the three tested engines (sticky activation, T4 start spec `readme-click`); an engine that requires transient activation would stay suspended.
- **Fix:** key the flag to the context: `if(this._rq!=c && ...){ this._rq=c; Promise.resolve().then(()=>{ this._rq=0; }); ... }` (a few bytes).

### F3 (LOW) Teardown waits for `ended` on a context the caller has already closed

- **Where:** `webaudio-tinysynth.js:629` (`now=close || this._off`).
- **Evidence** (PR #37 Codex, reproduced): a caller closes its injected context while voices exist, then calls `dispose()` (or replaces the context). `_drop()` defers each source's disconnection to `onended`, which a closed context never dispatches (T4's own dispose spec header records this for all three engines). Mock: 30 connections left (`logs/probe-codex.txt`). In the browser the reviewer's S6 shows no error or rejection on this path (it does not count routes).
- **Impact:** D-018's "disconnects graph and modulation routes" is not met on this caller-owned path; source and gain objects stay linked to each other and to the caller's closed context.
- **Fix:** `now=close || this._off || c && c.state=="closed"` (about +20 B raw).

### F4 (LOW) The 13 guarded methods report `length` 0 and `name` ""

- **Where:** `webaudio-tinysynth.js:1417-1420` (instance wrappers `(...a)=>...` assigned to a computed member, so no name is inferred).
- **Evidence** (`logs/probe-mock.json`): in both builds `send`, `noteOn`, `setProgram`, `setBendRange`, `setBend`, `setSustain`, `setModulation`, `setChVol`, `setPan`, `setExpression`, `loadMIDI`, `locateMIDI` and `playMIDI` have `length` 0 and `name` ""; the base build has the declared arity (`noteOn` 4) and the name. Source and min are consistent with each other.
- **Impact:** observable but rarely used (arity-based dispatch, logging, stack traces show anonymous functions). L-11 lists it.
- **Fix:** guard inside each method (`if(!this._live()) return;` as its first statement). Arity and name are then upstream's in both builds (checked on variant C5), detached methods stay guarded, and it is +23 B raw but **−43 B gzip** against the wrappers (§6). Wrapping with `Object.defineProperty(..., "length", ...)` costs +49 / +21 B and still loses the name.

### F5 (LOW) `reset()` creates the lazy context, contrary to the README

- **Where:** `webaudio-tinysynth.js:722-738` calls the guarded `setProgram` and channel setters; `README.md:136` says calls other than the listed ones do not create the context (T4.md §2 does not list `reset` either way).
- **Evidence:** `new WebAudioTinySynth({lazy:true}).reset()` creates one context (`logs/probe-mock.json`, both builds). Same as PR #37 Claude LOW.
- **Fix:** document it, or skip the audio setters in `reset()` while `!this.actx` (installing the graph runs `reset()` anyway).

### F6 (LOW, design) `loadMIDI()` counts as first use on a lazy synth

- **Where:** guard list `webaudio-tinysynth.js:1417`; `loadMIDI` ends with `locateMIDI(0,1)`, whose `reset()` needs the graph.
- **Evidence:** reviewer S6 (console-driven page, no `evaluate` before the click, D-011): `{lazy:true}` plus `loadMIDI()` at page load creates one context before any gesture, `suspended` in all three engines; a click then `resume()` and `playMIDI()` play correctly in all three engines.
- **Judgement:** parsing a song does not need audio, and "load at page load, play on tap" is the most common page pattern, so the current rule defeats `lazy`'s stated purpose (D-018: "lets a tap-to-start page create the context inside the gesture") for that pattern, though it stays functional. Variant L1 (`size/out/L1-…`): `loadMIDI` is guarded only against disposal, and when no context exists it sets `playIndex=0`/`playTick` itself instead of `locateMIDI(0,1)` (the later graph install runs `reset()`). +75 B raw / +18 B gzip; only the unit test asserting the current rule fails (2 of 136), and a lazy load-then-play keeps program 40 and CC7 (mock). Recommended if the supervisor wants `lazy` to cover that pattern; otherwise keep the README sentence.

### F7 (LOW) Offline direct scheduling silently drops notes beyond `voices`

- **Where:** `_limitVoices`, `webaudio-tinysynth.js:980-993` (outside T4's allowed scope); T4.md §10 risk 4.
- **Evidence:** reviewer S7: 100 notes at distinct times (0.25 s apart) on an injected `OfflineAudioContext` render only **64**; notes 0–35 are silent (stolen by count at `currentTime` 0 and stopped at time 0), in all three engines and both builds. With `voices:128` all 100 render.
- **Impact:** D-018 calls direct scheduling on an offline context "supported"; the README describes `voices` as "simultaneous voices", which is not what happens offline.
- **Fix:** now, one README sentence (offline: `voices` must be at least the number of notes scheduled before the render); later (T7 or a follow-up), make `_limitVoices` count only notes that overlap the new note on an offline context.
- **On `AUDIO_CONTEXT_OFFLINE`:** throwing from `playMIDI()` is the right choice for now. A supported mode would have to schedule the whole song up front (looping songs never end, and F7 would drop everything past 64 notes); the error is explicit, synchronous, documented and never thrown from a timer (a seek on an offline context cannot call `playMIDI()` because installing it stops playback).

### F8 (LOW, pre-existing) `setAudioContext()` during playback keeps the old context's clock

- **Where:** `webaudio-tinysynth.js:1301-1318` (`playTime` is not rebased; PR #37 Codex P2).
- **Evidence:** mock, both builds and the base: after 6 s of play, replacing with a fresh context leaves `play:1` and no note for the next 3 s (`playTime` 6.31 against the new clock 3.0). Upstream behaves the same; with T4 the old context's voices are now stopped too, so the gap is total silence.
- **Fix:** rebase (`this.playTime+=actx.currentTime-old.currentTime`) or stop playback on replacement; about 30 B.

### F9 (LOW) Calling `init()` again leaks an interval and orphans the synth's context

- **Where:** `webaudio-tinysynth.js:462-489`.
- **Evidence:** mock: a second `init()` before `dispose()` leaves two 60 ms intervals; `dispose()` clears one, and the first synth-created context is never closed (`logs/probe-mock.json`). Upstream also leaked the interval; `init()` is not documented in the README.
- **Fix:** `clearInterval(this._tid)` and `_drop()` at the start of `init()`, or return when `_tid` is set.

### F10 (INFO) `_gone` drops a voice on its first component's `ended`

PR #37 Codex LOW. Each component's own `onended` (`:976`) still disconnects that component when it ends, so a voice that leaves `_gone` early is only missed when a teardown closes the context between two components' `ended` events, and then only in the instrumentation's edge count. No action needed beyond what F3 changes; it disappears entirely if `_gone` is dropped (R8, §6).

### F11 (INFO) Test independence

- The browser specs are black box (only `chvol` and `song` are read), derived from the contract, and they are the real evidence; the reviewer's independent spec agreed with them on every shared point.
- D-023's controller cancel is only observed in the browser (`tests/browser/specs/dispose.js:278`, `t.observe`), not asserted: the reviewer's audible S4 (below) should be promoted to an assertion in T6 phase B.
- 11 of the 50 unit test bodies read internals (`_src` 16 times, `_gone` 4, `_pend` 2). They kill every mutant but also fail on behavior-neutral refactors (R7 and R8 in §6 fail 10 unit tests while the browser specs pass), which will matter for T7.
- "`dispose()` resolves after the close" has no discriminating browser check in T4's spec (it reads the state 500 ms later); the reviewer's S1b does, in Firefox and WebKit (§4).
- No test covers pause/resume after the D-023 cancel (F1), replacement within one task (F2), or a caller-closed context at teardown (F3).

## 2. D-018 / D-023 point by point

| Contract point | Result | Evidence |
| --- | --- | --- |
| Defaults legacy: eager context, warm-up note, `ready()` | pass | differential identical to upstream + tempo patch (8 files), unit "default construction is unchanged" |
| `context` / `destination` / `lazy` validation before side effects | pass | unit (12 invalid cases); `setAudioContext` invalid args throw first |
| Injected context: no extra context, routes to destination | pass | T4 start `inject-click` (exactly one context), offline gain 0.5 / 0 at the destination, S2 and S4 analyser destinations |
| `lazy`: no context before first use | pass, with F5, F6 | S6, T4 start `lazy-click`/`lazy-key` |
| `resume()` promise: creates lazily inside the gesture, resolves when running | pass | T4 start (3 engines × 2 builds) |
| Rejections observable; `send()` never leaves an unhandled rejection | pass, with F2 | S6 (suspended, no gesture; closed), T4 start `closed-click`, unit |
| Offline: resolve without action; no premature pruning | pass, with F7 | T4 offline spec, S7 |
| `dispose()` idempotent, same promise, terminal, safe no-ops | pass | S1 (every public method attached and detached, 1.5 s), T4 dispose |
| Timers cleared (interval, `ready()` polls) | pass, with F9 | S1, S2, T4 dispose and node exit tests |
| Every owned source stopped (melodic, percussion, LFO, warm-up) | pass | S2 (no source started after dispose, all ended), T4 dispose (`unstopped` empty) |
| Callbacks detached, routes disconnected, references released | pass, with F3 | S2, S3, S8 (no live connection), T4 dispose |
| Pending work: `ready()` resolves; T5 hook `_pend` | pass | S1 (`ready()` resolves; held URL load installs nothing in T4 dispose) |
| Only synth-owned contexts closed; resolves after the close | pass | S1/S1b (ordering verified in Firefox and WebKit; Chromium closes at once), S3 (`1,0,0,0,0,0,0` close calls) |
| `setAudioContext()` teardown and ownership | pass, with F8 | S3 (6 caller contexts, one re-installed, nothing left), T4 dispose |
| D-023: drums incl. scheduled, queued CC cancelled | pass | T4 STOP (silence), S4 (audible CC7 and CC10 cancel), S8 |
| D-023: load path keeps upstream trace | pass | differential and parser-compat; mutant `load-full-stop` fails the differential |
| D-023: caller-replaced `chvol` | pass | S8 (silence after stop, nothing left after dispose), unit |
| No regression of stop/play | **fail** | F1 |

## 3. Browser results

### 3.1 Declared matrix (candidate, `npm run test:browser:matrix`, exit 0, 953 s, 60 cases)

| Engine | embed | render | gesture | url | lifecycle | dispose | start | offline |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Chromium 153.0.8010.12 | 72/72 | 500/500 | 54/54 | 10/10 | 18/18 | 82/82 | 102/102 | 16/16 |
| Firefox 155.0 | 72/72 | 500/500 | 54/54 | 10/10 | 18/18 | 82/82 | 102/102 | 16/16 |
| WebKit 26.6 | 72/72 | 500/500 | 54/54 | 10/10 | 18/18 | 82/82 | 102/102 | 16/16 |

Identical to T4.md §8 (`results/full/results.json`, `logs/matrix-full-summary.txt`).

### 3.2 Reviewer spec (`scratch/repo/tests/browser/specs/review.js`), candidate, both builds

| Scenario | What is asserted | Chromium | Firefox | WebKit |
| --- | --- | --- | --- | --- |
| S1 post-dispose | `dispose()` resolves with the owned context already `closed`; 44 calls × attached/detached throw nothing, create no node, adopt no context, leave no interval; `ready()` resolves, `resume()` rejects `SYNTH_DISPOSED`; same promise | 9/9 ×2 | 9/9 ×2 | 9/9 ×2 |
| S1b close order | `dispose()` resolves after the owned context's own `close()` promise | 1/1 ×2 | 1/1 ×2 | 1/1 ×2 |
| S2 dispose mid-song, caller context, analyser destination | audible before (peak 1.7); exact silence 60–700 ms after; no new source; all ended; no synth connection; context running, never closed | 9/9 ×2 | 9/9 ×2 | 9/9 ×2 |
| S3 replacement chain | owned + 6 caller contexts (one re-installed): close calls `1,0,0,0,0,0,0`; 0 edges on every context; nothing playing; 7 contexts | 6/6 ×2 | 6/6 ×2 | 6/6 ×2 |
| S4 D-023 controller cancel (audible) | control: queued CC7=0 silences, CC10=0 pans hard left; after `stopMIDI()` the later note is audible (≈0.25) and centred | 6/6 ×2 | 6/6 ×2 | 6/6 ×2 |
| S5 stop then play | the scenario is valid (stop before the CCs were due); the resumed note's level within 10 % of a straight play at the same phase after its onset; CC10 pan kept (see F1) | **3/5 ×2** | **3/5 ×2** | **3/5 ×2** |
| S6 no gesture, suspended and closed contexts, lazy load (console-driven, real click) | no throw, no unhandled rejection; closed: `AUDIO_CONTEXT_CLOSED`, `dispose()` resolves; lazy synth loaded before the click plays after it | 5/5 ×2 | 5/5 ×2 | 5/5 ×2 |
| S7 offline, 100 notes | `voices:128` renders 100 (asserted); default renders 64 (observed, F7) | 3/3 ×2 | 3/3 ×2 | 3/3 ×2 |
| S8 consumer-swapped `chvol` | audible after the swap; silence after `stopMIDI()` with a hit scheduled ahead; nothing left after `dispose()` | 5/5 ×2 | 5/5 ×2 | 5/5 ×2 |

Totals with the final spec (`results/review-final2`): 47 of 49 checks per engine and build; the 2 failures are F1. Against the base build (`--source`/`--min` overrides; S1–S3 and S6–S8 need `dispose()` and are skipped) the S4 controls and all of S5 pass in 6 of 6 cases (`logs/review-base2.log`, 18/18 checks per engine): the base keeps queued CCs after a stop (as upstream) and resumes at the right level and pan.

### 3.3 Variants and the F1 prototype in the browser

Spec runs on T6's runner with `--source`/`--min` overrides, all three engines, both builds (`results/var-*/results.json`). "review" counts include S5, which fails on every build without the F1 fix.

| Build | Specs | Chromium | Firefox | WebKit | Reading |
| --- | --- | --- | --- | --- | --- |
| C5 (R1b + R2 + R6 + X1) | embed, render, gesture, url, lifecycle, dispose, start, offline, review | all pass but S5 (embed 72/72, render 500/500, gesture 54/54, url 10/10, lifecycle 18/18, dispose 82/82, start 102/102, offline 16/16) | same | same | the reductions change no browser-observable behavior |
| C6 (C5 + R7 + R8) | lifecycle, dispose, start, offline, review | all pass but S5 | same | same | `_gone` and the start-up oscillator tracking are not needed by any browser check |
| L1 (lazy `loadMIDI` without a context) | start, dispose, review | all pass but S5 | same | same | |
| F1 prototype (candidate + transport rewind) | dispose, start, offline, review | dispose, start, offline pass; review 98/98 (S5 passes: resumed level equals the straight play, right channel 0) | same | same | F1 fixed |
| C7 (C5 + F1 + F2 + F3 fixes) | embed, gesture, lifecycle, dispose, start, offline, review | embed, gesture, lifecycle, dispose, start, offline pass; review 98/98 | same | same | F1 fixed; F2, F3, F4 fixed (mock probes) |

S5's measurement window was corrected twice during the runs: a rewound transport replays the CCs first, so the resumed note starts about 1 s later, and the final spec measures the note at the same phase after its onset in both the straight and the resumed play (`logs/review-spec-final.sha256`). The F1-prototype and C7 results come from the final spec (`var-fixproto-review2`, `var-C7-review2`); their earlier fixed-window runs read silence (window before the note) or 1.14× (window including the attack) and are kept in `logs/var-fixproto.log` and `logs/var-C7.log`. On builds without the fix S5 fails under every window version.

## 4. Mutation results (reviewer's own mutants)

Each mutant is a scratch copy of the candidate with one change, rebuilt with the pinned build, then run through the lifecycle unit and node tests, the upstream differential, and the browser specs `dispose`, `start`, `offline` and the reviewer's `review` on Chromium, both builds (`mutation/run-mutations.py`; logs per mutant; S5 failures, present on the unmutated candidate, are excluded).

| Mutant | Area | Change | Unit failed (of 136) | Node | Differential | Browser checks failed, Chromium (specs) |
| --- | --- | --- | ---: | --- | --- | --- |
| `perc-dispose-skip` | percussion cleanup | `_drop()` skips `_src` (hits not stopped on dispose) | 10 | pass | pass | 18 (dispose, review) |
| `perc-ended-keeps-routes` | percussion cleanup | an ended hit does not disconnect its source and gain | 6 | pass | pass | 14 (dispose, review) |
| `perc-stop-sounding-only` | percussion, D-023 | `stopMIDI()` stops only hits already sounding, not scheduled ones | 8 | pass | pass | 4 (dispose D-023 silence, review S8) |
| `own-caller-marked-owned` | ownership | `setAudioContext()` marks the caller's context as synth-owned | 8 | fail | pass | 14 (dispose, review) |
| `own-create-not-owned` | ownership | `_create()` does not mark its context as synth-owned | 12 | pass | pass | 16 (dispose, offline, review) |
| `dispose-resolves-before-close` | ownership | `dispose()` resolves without waiting for `close()` | 2 | pass | pass | 0 in Chromium; Firefox and WebKit: 4 each (review S1 reads `running`, S1b `order:false`) |
| `cancel-volume-only` | D-023 | `stopMIDI()` cancels volume automation only (not pan or modulation) | 2 | pass | pass | 2 (review S4 only) |
| `drop-keeps-chmod` | teardown | `_drop()` leaves the `chmod` nodes connected (LFO and detune routes) | 10 | pass | pass | 16 (dispose, review) |
| `pend-not-run` | pending work | `dispose()` does not run the cancellers (`ready()` polls stay) | 2 | fail | pass | 4 (dispose: interval left) |
| `resume-closed-no-code` | `resume()` | a closed context is asked to resume (no `AUDIO_CONTEXT_CLOSED`) | 2 | pass | pass | 4 (start `closed-click`, review S6) |
| `load-full-stop` | D-023 load trace | `loadMIDI` uses the caller's full stop | 2 | pass | **fail** | not run |
| `no-gone` | size probe (R8) | pruned voices are not tracked in `_gone` | 6 | pass | pass | 0 |
| `no-dummy-tracking` | size probe (R7) | the start-up oscillator is not tracked in `_src` | 4 | pass | pass | not run (C6 covers it, §3.3) |

- All 11 behavioral mutants are killed by the unit tests (`load-full-stop` also by the upstream differential). Of the 10 run in browsers, 9 are killed in Chromium and the tenth in Firefox and WebKit. The percussion-cleanup and ownership mutants are killed by T4's own black-box dispose spec, so those expectations are independent, not mirrored.
- `cancel-volume-only` survives every T4 browser spec and is killed only by the reviewer's audible S4: the D-023 controller cancel is observed, not asserted, in `dispose.js` (F11).
- `dispose-resolves-before-close` survived the first browser run: in Chromium `ctx.state` already reads `closed` when an already-resolved promise's callback runs after `close()`, so neither T4's spec nor the reviewer's S1 could tell. In Firefox and WebKit the close takes a task: S1 and the added S1b kill the mutant in both builds, and the candidate passes both, so the ordering is verified there. T4's dispose spec reads the state 500 ms after the resolution and cannot kill it in any engine.
- The two size probes (`_gone`, start-up oscillator tracking) fail only white-box unit tests; no browser check depends on them (also C6 in §3.3).

## 5. Checks run

Run in the review worktree at `2fe1882` unless noted; Node 24.21.0 from `_evidence/t1-tooling`, browsers from `_evidence/t6-validation/env.sh`. Logs in `_evidence/t4-review/logs/` (`commands.tsv`).

| Command | Exit | Time | Result |
| --- | ---: | ---: | --- |
| `npm ci` | 0 | | `logs/npm-ci.log` |
| `npm run lint` | 0 | 0 s | |
| `npm run verify` | 0 | 1 s | distribution matches the pinned build |
| `npm run pack:check` | 0 | 0 s | |
| `npm test` | 0 | 130 s | unit 6 files / 416 tests, node 7 / 115, regressions 3 of 3 (differential, tempo, loop-end) |
| `npm run test:browser` | 0 | 5 s | 2 of 2 |
| `node scripts/browser-matrix.js --out=results/full` (= `npm run test:browser:matrix`) | 0 | 953 s | 60 cases, §3.1 |
| reviewer spec, candidate, Chromium (`review-dev1`) | 1 | | S5 only (F1) |
| reviewer spec, candidate, Firefox + WebKit (`review-ffwk`) | 1 | | S5 only (F1) |
| reviewer spec, base `b49e8ceb` builds, 3 engines (`review-base`) | 0 | | S4 controls and S5 pass |
| reviewer spec with S1b, candidate, 3 engines (`review-final`, then `review-final2` with the final S5 window) | 1 / 1 | 128 s / 129 s | S1b passes everywhere; 47/49 per engine and build, only S5 fails (F1) |
| reviewer spec, final, base builds (`review-base2`) | 0 | 50 s | 18/18 per engine (S4 controls, S5) |
| close-order mutant, Firefox + WebKit (`mut-close-ffwk`) | 1 | | killed by S1 and S1b in both engines and builds |
| F1 prototype and C7, reviewer spec, final (`var-fixproto-review2`, `var-C7-review2`) | 0 / 0 | 133 s each | 98/98 per engine |
| `scratch/probe-mock.cjs` (candidate, base) | 0 | | arity, lazy creation, `init()` re-call, pause/resume, replacement while playing |
| `scratch/probe-codex.cjs` (candidate, base, C7) | 0 | | F1b, F2, F3 |
| `scratch/exports.cjs` | 0 | | CommonJS, AMD, global, detached `dispose`/`resume`, both builds |
| `mutation/run-mutations.py` node-only (13 mutants) | 0 | | all killed (unit; `load-full-stop` also by the differential) |
| `mutation/run-mutations.py` browser (11 mutants, Chromium) | 0 | 49 min | §4 |
| `size/variants.py` | 0 | | every variant `node --check` 0 on source and min |
| C5: `npm test` in `size/test-C5` | 1 | | unit 412/416 (4 exact-message assertions); node all pass but the git-history test (no history in a scratch copy); regressions 3/3; lint 1 only for the reviewer's scratch spec |
| C7: unit / node / regressions in `size/test-C7` | 1 / 1 / 0 | | as C5 |
| F1 prototype: unit / node / regressions | 0 / 1 / 0 | | 416/416 unit; node only the git-history test |
| Browser runs of C5, C6, F1 prototype, L1, C7 | 1 | | §3.3 (only S5 fails where expected) |
| `gh pr view 37` (read only, twice) | 0 | | `logs/pr37-*.json` |

Not run: `npm run test:browser:observe` (T6's observe-only hang and variation specs; no T4 code path depends on them).

## 6. Size (D-024: the consumer's metric is `gzip -9`)

Candidate `ccc9403d…`: 40,310 B raw (+3,350, +9.1 %) and 11,075 B gzip (+1,127, +11.3 %) against `b49e8ceb…` (36,960 / 9,948); against T0 `5aa3edbc…` (37,060 / 9,444) cumulative +3,250 raw (+8.8 %) and +1,631 gzip (+17.3 %). All numbers below are measured on builds made with the pinned Terser options (`size/minify.cjs` reproduces the committed min.js byte for byte), and all 37 variants pass `node --check` on their source and min build (`size/out/sizes.json`, `logs/size-variants.txt`).

### 6.1 Where the bytes go (ablation: each row removes one feature from the candidate)

| Feature removed | raw | gzip |
| --- | ---: | ---: |
| Teardown `_drop()`: stop and re-hook every voice, hit, `_gone` entry and the LFO; disconnect the graph; release; close | 622 | 188 |
| Options `context`/`destination`/`lazy` checks, `_check()`, the `init(ctx,dest)` path (four `TypeError` messages included) | 553 | 181 |
| Percussion and start-up oscillator tracking in `_src`: push, timer filter, the stop loop, hiding on replay | 373 | 107 |
| `dispose()`, the `ready()` rewrite and `_pend`, the `_tid` handle, `init()`'s disposed check | 309 | 86 |
| `resume()` (two coded messages included) | 281 | 113 |
| Method guards: the 13-name wrapper loop and `_live()` | 280 | 97 |
| Ended-time disconnection in `_pruneNote` and percussion `onended`, with `_gone` | 205 | 54 |
| &nbsp;&nbsp;of which `_gone` alone | 99 | 27 |
| Offline rules: timer skip, `playMIDI()` error (message included), `_off` | 167 | 64 |
| D-023 cancel loop in `stopMIDI()` | 146 | 37 |
| `_wake()` coalescing (against upstream's inline `resume()`) | 140 | 53 |
| Sum of the feature rows | 3,076 | 980 |
| Candidate growth over `b49e8ceb` (the rest: `CodedError`, `_create`, the `_halt` split, `init` restructuring) | 3,350 | 1,127 |
| Cross-cutting: the seven lifecycle message texts, already counted in the rows above | 228 | 91 |

The largest items are the teardown and the option validation; messages are 8 % of the growth in gzip, guards 9 %, `_gone` 2 %.

### 6.2 Reductions that keep D-018 and D-023

| Variant | raw | Δ raw | gzip | Δ gzip | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| candidate `ccc9403d` | 40,310 | 0 | 11,075 | 0 | |
| R1a: short message texts (`"bad context"`, `"disposed"` …), codes kept | 40,152 | −158 | 11,009 | −66 | keeps descriptive `TypeError`s |
| R1b: a lifecycle `Error`'s message is its code; a `TypeError`'s message is the option name | 40,097 | −213 | 10,987 | −88 | D-018 mandates codes, not prose; 4 unit tests compare exact messages |
| R2: `ready()` returns `Promise.resolve()` (no 100 ms poll; `_pend` kept for T5) | 40,136 | −174 | 11,012 | −63 | README:123 already says the synth is ready when the constructor returns; resolves a microtask instead of ~100 ms later (observable timing only); no timer left to clear |
| R6: compact option checks (`const {context:c,destination:d,lazy:l}=opt\|\|{}`, one `TypeError` branch for the three combination errors) | 40,251 | −59 | 11,068 | −7 | same inputs accepted and rejected; one shared message for the combination errors |
| R5: `loadMIDI`'s `Fail` built on `CodedError` | 40,288 | −22 | 11,078 | +3 | no gain; not recommended |
| R7: do not track `playMIDI()`'s 1 ms start-up oscillator in `_src` (it still disconnects itself) | 40,252 | −58 | 11,058 | −17 | 4 white-box unit tests fail; browser in §3.3 |
| R8: drop `_gone` | 40,211 | −99 | 11,048 | −27 | 6 white-box unit tests fail; browser in §3.3 |
| X1: per-method guards (`if(!this._live()) return;` first in each of the 13 methods) instead of instance wrappers | 40,333 | +23 | 11,032 | **−43** | restores `length` and `name` (F4); detached methods stay guarded |
| X2: wrappers + `Object.defineProperty(…, "length", …)` | 40,359 | +49 | 11,096 | +21 | restores `length` only |
| X3: wrappers + `defineProperties` for `length` and `name` | 40,376 | +66 | 11,105 | +30 | restores both, dominated by X1 |
| L1: lazy `loadMIDI()` without a context (F6) | 40,385 | +75 | 11,093 | +18 | optional |
| F1 fix: transport rewind in `stopMIDI()` | 40,506 | +196 | 11,143 | +68 | needed |
| F2 fix: resume flag per context | 40,315 | +5 | 11,076 | +1 | needed |
| F3 fix: immediate teardown on a closed context | 40,332 | +22 | 11,078 | +3 | needed |
| C1 = R1b + R2 + R6 | 39,880 | −430 | 10,923 | −152 | |
| **C5 = R1b + R2 + R6 + X1** | 39,903 | **−407** | 10,880 | **−195** | behavior kept; fixes F4 |
| C5a = R1a + R2 + R6 + X1 (descriptive messages kept) | 39,954 | −356 | 10,903 | −172 | |
| C6 = C5 + R7 + R8 | 39,746 | −564 | 10,833 | −242 | depends on §3.3 |
| **C7 = C5 + F1 + F2 + F3 fixes** | 40,126 | **−184** | 10,952 | **−123** | recommended end state |
| C8 = C7 + R7 + R8 | 39,969 | −341 | 10,906 | −169 | see §3.3 |

Shared wrappers versus per-method guards: the wrapper loop is 23 B smaller raw, but the 13 repeated `if(!this._live())return;` statements compress better than the 13-name string plus the rest-parameter wrapper, so per-method guards win by 43 B gzip, the consumer's metric, and keep the API's arity and names.

Validation of C5 and C7 (scratch copies, `size/test-C5`, `size/test-C7`): `node --check` on source and min; the pinned build reproduces the measured min byte for byte; the regressions (differential, tempo, loop-end) pass; all node tests pass except the one that needs git history in the scratch copy (environmental); unit 412 of 416, the 4 failures being the exact-message assertions at `lifecycle.test.mjs:337` and `:840`. With C7, the F1, F2 and F3 probes all come out correct (`logs/probe-codex.txt` rerun, `resumeRequests` A then B, 0 edges left; pause/resume hears CC7 0.074 and pan −1), and the 13 methods have upstream arity and names. Browser runs: §3.3.

### 6.3 Recommendation

1. **Adopt C7 in a T4 follow-up commit:** C5's reductions (R1b code-only lifecycle messages, R2 `ready()` without polling, R6 compact option checks, X1 per-method guards) plus the F1, F2 and F3 fixes. Result: 40,126 B raw / 10,952 B gzip, which is **−184 B raw / −123 B gzip** against the candidate, or +3,166 / +1,004 B (+10.1 % gzip) over `b49e8ceb` instead of +3,350 / +1,127. It fixes F1 (resume path), F2, F3 and F4. Update the 4 exact-message unit assertions.
2. **Also drop `_gone` and the start-up oscillator tracking (R7 + R8; C8 = 39,969 / 10,906 B, −341 / −169 B against the candidate):** no browser check in three engines and both builds depends on them (C6, mutant `no-gone`); the 10 unit tests they fail read internals and should observe the call trace instead. They were added for a Chromium case (T4.md §5) that arose when pruned voices were disconnected immediately, which the ended-time disconnection already avoids. Supervisor's choice.
3. Variants on the choice of messages and `ready()`: R1a instead of R1b keeps descriptive messages (+23 B gzip against C5); dropping R2 keeps `ready()`'s ~100 ms delay (+63 B gzip).
4. Not recommended: R5 (no gain), X2 and X3 (dominated by X1). L1 (+75 / +18 B) only if the supervisor wants F6 changed.
5. What remains is the D-018 surface itself (teardown 188 B, option validation 181 B, `resume()` 113 B, percussion tracking 107 B gzip). No further cut was found that keeps the contract.
