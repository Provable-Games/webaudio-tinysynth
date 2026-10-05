# Contracts and compatibility ledger

Supervisor-owned. The GitHub issues are the specifications; this file summarizes the contracts that tasks must honor and records every intentional behavior change. Decisions referenced as D-nnn are in [decisions.md](decisions.md).

## Governing references

| Reference | Pinned revision |
| --- | --- |
| Fork baseline | `b70ba90d63c5ea657cb67ca98de90d7f778c29bd` (`origin/main` at kickoff, 2026-10-02) |
| Upstream reference | `3d75aee4b3f43cbd932265e7d60201fd5b770397` (g200kg/webaudio-tinysynth) |
| Plan | `/workspace/webaudio-tinysynth/IMPLEMENTATION_PLAN.md` (untracked, user-owned), sha256 `9383cb5bcb0f2275a5608345ee60fea594a77a2e21fa9b85b840011daff2116f` |
| Local agent guidance | `/workspace/webaudio-tinysynth/AGENTS.md` (untracked, user-owned, partly outdated), sha256 `b16618332cebca7eb1a02cfe3ab94b6e16a35349ae5112dce312a6cf00acc4d4` |
| Consumer | `/workspace/onchain-tinysynth` at `71fce2853d52f40f081d834a086f72f98068de60`; `src/types.cairo` sha256 `911bcb358176116fc14d29b573b3e2aab8f0335dead3c2efdb819ded5dadc908`; `README.md` sha256 `21f3208aa6acea543ab9ab44917b3a8a71ae9ffcfd42f6309d33ba40167cd4ab`. This matches the reviewed reference. |
| AI review structure reference | `/workspace/death-mountain-client` at `ceff9d86054db893032178bc0cba67ac234a5159`; secondary references `game-token@a585c3d` and `super-death-mountain@b01b9a0` |

### Issue revisions used for dispatch

The snapshots (full JSON) are in `/workspace/webaudio-tinysynth-worktrees/_evidence/issues/`. The hash is the first 16 hex digits of sha256(body). No issue had comments at kickoff. Recheck `updatedAt` before each dispatch; a changed issue is reconciled here before dependent work proceeds.

| Issue | updatedAt | Comments | Body hash | Title |
| --- | --- | --- | --- | --- |
| #4 | 2026-10-03T00:14:07Z | 0 | `db6bb6feafd04303` | loadMIDI hangs the page on a track without End-of-Track or a truncated file |
| #5 | 2026-10-03T00:44:54Z | 0 | `9b1dbcb728bbb29a` | Pin the minifier and publish the SHA-256 of the minified build |
| #6 | 2026-10-03T00:14:16Z | 0 | `5a6d53f403e25e94` | SMPTE time division is accepted but produces a garbage timebase (low priority) |
| #7 | 2026-10-03T00:17:17Z | 0 | `6cf29e0b688d650a` | Reverb and noise buffers use Math.random, so the same MIDI sounds slightly different on every load |
| #8 | 2026-10-03T00:14:46Z | 0 | `86c3cf4136f0b835` | Prevent zero-duration MIDI loops from hanging the scheduler |
| #9 | 2026-10-03T00:14:51Z | 0 | `364d08d6db1f4abb` | Keep empty MIDI songs stopped instead of reporting perpetual playback |
| #10 | 2026-10-03T00:14:54Z | 0 | `74b5154fac188443` | Restore initial tempo when replaying a completed MIDI song |
| #11 | 2026-10-03T00:14:58Z | 0 | `da6f7c140a27099f` | Add disposal and clean up audio graphs when replacing AudioContexts |
| #12 | 2026-10-03T00:16:41Z | 0 | `d078521aeb53cab7` | Support injected AudioContexts and explicit user-gesture audio startup |
| #13 | 2026-10-03T00:15:05Z | 0 | `a3e7aabf5e190b23` | Validate public MIDI inputs and timbres before mutating synth state |
| #14 | 2026-10-03T00:16:46Z | 0 | `5c24b2d00d5f4042` | Make MIDI URL loading observable, cancellable and safe against stale responses |
| #15 | 2026-10-03T00:15:36Z | 0 | `e6673c872937c7db` | Remove unused node-minify and its vulnerable development dependency tree |
| #16 | 2026-10-03T00:44:59Z | 0 | `47baf5dfecc4346c` | Automate browser and rendered-audio validation for both quality modes |
| #17 | 2026-10-03T00:15:43Z | 0 | `1a95f27e1f4b66d2` | Separate source responsibilities and add types while retaining the single-script API |
| #18 | 2026-10-03T00:16:58Z | 0 | `953b64ea9c1f5a0f` | Measure and reduce initialization cost without changing timbres or retaining contexts |
| #19 | 2026-10-03T00:17:03Z | 0 | `46269beafaf9b0a9` | Modernize demo dependencies and prevent stuck notes and silent loading failures |
| #20 | 2026-10-03T00:15:55Z | 0 | `d2126c352e5d3b8c` | Align fork metadata, contribution instructions and documentation with implemented behavior |
| #21 | 2026-10-03T00:17:08Z | 0 | `137220174413e75d` | Reconstruct tempo and channel state deterministically when seeking MIDI |
| #22 | 2026-10-03T00:43:50Z | 0 | `440cf0e5f0f1ff8b` | Add a standard ESLint configuration as the initial implementation phase |
| #23 | 2026-10-03T00:43:54Z | 0 | `591cea541a27db93` | Add Vitest with focused initial unit tests before synth changes |
| #24 | 2026-10-03T00:43:59Z | 0 | `ae4a37d537f91e93` | Add initial native Node.js integration tests and preserve existing regressions |
| #25 | 2026-10-03T00:44:05Z | 0 | `3e13f34c17fb3f73` | Add Codex and Claude review workflows with centralized model and effort controls |
| #26 | 2026-10-03T01:10:54Z | 0 | `946b1d5203c160f9` | Public API for custom waveforms: harmonic waves and single-cycle sample waves |
| #27 | 2026-10-03T01:10:56Z | 0 | `cfbde7a1dca0d3ec` | Optional fixed biquad filter per operator (low-pass, high-pass, band-pass) |

The table is generated from `_evidence/issues/revisions.md`; T0 copies it into `tasks/T0.md`.

## Deployment contract (all tasks)

- **Classic script.** `webaudio-tinysynth.js` and its minified build are self-contained classic scripts with no runtime dependencies, module fetches, network access or audio downloads. They must remain inline-embeddable in an HTML `<script>` inside a base64 `data:` URI (the consumer's `animation_url`). The minified output must not contain `</script`, `<script` or `<!--` in any letter case. T0 found none at baseline, and an inline `data:` URI page played both builds with zero requests; T1's verify step enforces this.
- **Exports.** CommonJS `module.exports`, AMD `define`, and the global `window.WebAudioTinySynth`, with the `(function(window){…})(this)` wrapper semantics. Optional ESM or types are additive only (#17).
- **Public API.** Method and property names, documented defaults, and constructor options are preserved. Methods remain detached-safe: they are instance-bound arrow functions, so `const {noteOn} = synth` works. Both quality modes, the GM program and drum tables, controllers and tuning (RPN, master and scale tuning SysEx), fractional tempo, and the corrected `loopEnd` behavior are preserved.
- **Artifact identity.** The consumer embeds the exact minified bytes and publishes their SHA-256. Builds are reproducible from the pinned toolchain (#5). Raw and gzip size changes are recorded against T0. Growth over 5% triggers supervisor review; there is no invented hard limit, and none has been established from the consumer.
- **Licensing.** LICENSE, NOTICE, the source header attribution and upstream provenance are preserved, and NOTICE is updated for each modification set.

## Ownership contract

- **AudioContext.** A caller-supplied context (`setAudioContext`, or the constructor injection from #12) is caller-owned and is never closed by the synth. A context the synth creates internally is synth-owned and may be closed by `dispose()` (#11).
- **Timbres.** Built-in tables are immutable shared data. Caller timbre objects passed to `setTimbre` are copied and normalized (#13, ledger L-09) and are no longer mutated in place.
- **Waveform registry (#26).** The instance owns copies of the definitions. Context objects are rebuilt per context and released on dispose (D-006).
- **Timers and voices.** The instance owns its interval timers, melodic and percussion voices, the LFO, filters and connections, and releases them on dispose or replacement (#11, #27).

## Source contract

- Until T7, `webaudio-tinysynth.js` is the single editable source. The minified file and map are generated only by the pinned `npm run build` (D-003). If T7 makes the root script a generated artifact, it updates contribution docs and build checks atomically (#17).
- Style: two-space indentation, semicolons, double quotes, compact expressions. Do not restyle the timbre tables, and do not add a formatter (#22).
- `bower_components/webaudio-controls/` is vendored; only #19 may change it.

## Consumer setup contract (#26/#27)

The consumer passes `SynthSettings`. Its page sets the quality, then registers waves, then installs custom timbres with `setTimbre` (after `setQuality`, because that resets the tables). Units are fixed-point with a scale of 10,000. The conversions are in D-006 and D-007; T0 records the full field mapping (`tasks/T0.md` §7, `evidence/T0/consumer-mapping.json`), and D-010 resolves its questions; consumer follow-ups are listed there. A pinned representative consumer setup fixture lives in this repository; T11/T12 add it and T10 validates it against the exact generated min.js. It covers a 64-sample 4-bit stepped triangle lead, LFSR-style noise drums, 12.5% and 25% pulse waves, and a high-passed metallic hat. Consumer page and contract implementation stay in `onchain-tinysynth`.

## Determinism versus rendered audio (#7, #16, #26, #27)

- **Deterministic generated data.** Identical inputs, seed, generation version and sample rate produce byte-identical Float32 buffers and tables. Hashes are recorded.
- **Rendered-audio repeatability.** Same-engine offline renders are checked for repeatability. Cross-engine and cross-rate results use measured pitch, envelope, energy and spectral tolerances declared by T6. Exact stepped output at arbitrary pitches and byte-identical PCM across browsers are not promised. Strict chip-hardware emulation and an AudioWorklet/WASM rewrite are out of scope.

## AI review configuration (#25)

The central control is the organization Actions variables (D-009). Values at kickoff, for the record only (never copy them into files):
`CODEX_REVIEW_MODEL`, `CODEX_REVIEW_EFFORT=high`, `CLAUDE_REVIEW_MODEL`, `CLAUDE_REVIEW_EFFORT=medium`; all four are defined. Secrets present by name: `CODEX_AUTH_DOT_JSON` and `CLAUDE_CODE_OAUTH_TOKEN` (organization level, visible to the repository).

## Compatibility ledger

Each intentional behavior change gets an entry. The status is `planned`, `implemented (task, commit)`, or `verified (evidence)`. Baseline reproductions are in [tasks/T0.md §5](tasks/T0.md) and `evidence/T0/probes/` (accepted; all confirmed on both builds).

| ID | Issue | Change | Baseline behavior (reproduction) | Expected behavior | Tests | Affected callers | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| L-01 | #4 | Bounded, transactional SMF parsing | Missing End-of-Track or a truncated file hangs `loadMIDI` (T0 probes) | Every read is bounded. An incomplete event or truncated track fails with a descriptive error that includes track and byte context, and the last valid song is kept. A missing End-of-Track on an otherwise complete track loads, as documented recovery. | T2 parser tests with an external deadline | Callers passing malformed data; consumer MIDI is required to be valid | implemented (T2, e128330; details in tasks/T2.md §3) |
| L-02 | #6 | Reject SMPTE and zero-PPQ divisions | `0xE728` gives a garbage timebase | Descriptive error, previous song kept | T2 | none known (consumer uses PPQ) | implemented (T2, e128330; details in tasks/T2.md §3) |
| L-03 | #4 | Reject SMF format 2 | Independent sequences are merged silently | Descriptive error | T2 | none known | implemented (T2, e128330; details in tasks/T2.md §3) |
| L-04 | #8 | Non-advancing loop detection and bounded scheduler work | A tick-zero-only song with `loop=1` hangs the callback | Stops or rejects predictably; a padded `loopEnd` still works; dense songs continue over later callbacks | T3, external deadline | none known | implemented (T3, 99177f4; tasks/T3.md, D-019) |
| L-05 | #10 | Replay of a completed song equals `locateMIDI(0)` plus play | The replay uses the ending tempo (0.5 s vs 0.25 s in #10) | Initial tempo and the seek-baseline channel state are restored (D-005) | T3 against an independent tempo map | songs whose end state differs from their start | implemented (T3, 99177f4; tasks/T3.md, D-019) |
| L-06 | #21 | History-independent seek | Manual `setProgram` survives `locateMIDI(0)`; a backward seek keeps the later tempo | Seek baseline plus song state before the target (D-005). Manual overrides are not kept. Next-event positioning is kept. | T3 | callers that override channels and then seek | implemented (T3, 99177f4; tasks/T3.md, D-019) |
| L-07 | #7 | Deterministic built-in buffers with a fixed default seed | `Math.random` on every context install | mulberry32 per-buffer streams, fixed default seed, `seed` option, generation version (D-004) | T6 seeded expectations, T8 | all: reverb and noise texture changes once | implemented (T8-seed, squash 19cb982, PR #42) |
| L-08 | #9 | Empty song stays stopped | `play: 1` forever | Stopped; no dummy node; tempo-only and metadata-only songs handled consistently | T3 | completion waiters | implemented (T3, 99177f4; tasks/T3.md, D-019) |
| L-09 | #13 | Validate and copy timbres; validate public inputs | `setTimbre` fills defaults into caller objects; invalid input reaches audio params | Descriptive errors for direct API misuse, no-ops for malformed raw MIDI, no partial state. Caller objects are not mutated. `setQuality("0")` selects quality 0. A negative or fractional `loopEnd` throws (D-019 F8); T3's scheduler scenario now expects the `RangeError` (supervisor-approved, `8f6a95a`). | T5 | soundedit round trips, callers relying on mutation | implemented (T5, squash 8f7b600, PR #48; tasks/T5.md §2–§8) |
| L-10 | #14 | `loadMIDIUrl` returns a promise; cancellation; stale-response protection | No result; non-200 is ignored silently | Promise resolves on install and rejects on error; a fire-and-forget call does not cause an unhandled rejection | T5 against a controlled server | URL loaders | implemented (T5, squash 8f7b600, PR #48; tasks/T5.md §5) |
| L-11 | #11, #12 | `dispose()`, context ownership, injection, `resume()` | No dispose; a leaked interval; the old graph stays alive | Idempotent dispose; caller contexts stay open; no extra context when one is injected | T4, T6 browser | lifecycle callers | implemented (T4, 25c4f79; tasks/T4.md, D-018/D-023/D-025) |
| L-12 | #26, #27 | Waveform registry and operator filters (additive) | Unknown `w*` names throw in `_note` | New APIs. Graphs without them are unchanged. Unknown names are rejected at `setTimbre`. | T11, T12 | consumer | #26 implemented (T11, squash 4b99a2b); #27 implemented (T12, squash b198d6c) |
| L-13 | #5 | Minified bytes change: pinned Terser 5.51.2, ordinary mangling with `keep_classnames`, and the source license header kept | `5aa3edbc…`, 37,060 B / 9,444 B gzip (T0) | `782e9b92a8f26f383fc0f8830a6a1e5d4e7dce2d0ab23bf29ab48e06814301b2`, 36,372 B / 9,422 B gzip (−1.9 % raw). Reproducible from a clean clone; exports, class name and detached methods are equivalent (T1 node tests); embedding check enforced by `npm run verify` | T1 verify, equivalence tests, browser smoke | consumer hash pin (no release yet) | implemented (T1, 5457966) |
| L-14 | #21 (D-023) | With `loopEnd > 0`, the first pass keeps the leading rest; `getPlayStatus().startTime` is added | The first event plays immediately; tick 0 can only be derived from internals | Tick 0 sounds at the pass start, and the first event at its own tick; `startTime` gives the time of tick 0 | T3.1 unit, node and browser tests | the consumer (must drop its `playTick`/`playTime` rewrite) | implemented (T3.1, b4335c8; merge b9882f1) |
| L-15 | #59 (D-039) | A note released before an operator's attack ends: the operator ramps on to its own value `v·(T − t)/a` at the note-off and is released from there | `_releaseNote` cancelled the whole ramp, so the operator was silent until the note-off (11 quality-1 programs silent with a 0.07 s note, among them 40–44; 119 and 125 at 0.3 s), and set every operator from the last operator's attack (quality-1 programs 23, 50, 86, 88, 123); in realtime the lookahead cut a slow attack 0.2 s early (T6 §18.5, `scripts/short-notes.js` in `_evidence/t6-phase-b2`) | Each operator sounds along its attack until the note-off and is released from its own value; a pedal-up during the attack releases at its own time; a second release keeps the release running. Notes released after every attack has ended make upstream's calls exactly. A zero-length note releases an operator with `a = 0` from its level, so it plays its release where upstream dropped it whenever the last operator had an attack (supervisor decision C1, tasks/T13.md §11). The install's velocity-1 warm-up note in quality 1 leaves an inaudible tail in Firefox (peak 8.2e-6, −102 dBFS) | T13: `tests/unit/short-notes.test.mjs` (AudioParam rules over every program, edge cases, trace identity with raw upstream for completed attacks), two `FORK_PATCHES` entries for the differential, browser spec `short-notes` | anyone relying on silent short notes on slow-attack timbres | implemented (T13, branch `t13/short-notes`; tasks/T13.md) |
| L-16 | #18 | Cheaper context install: `n1` is generated once per context installation, when first needed (`playMIDI()` before it reads the clock, `prewarm()`, or the first note that plays it); no reverb impulse with `useReverb: 0`; the constructor installs the built-in timbres once | Every install generated the impulse (`convBuf`, even with reverb off), `n0` and `n1` (64 passes of sine products, 41–45 ms of the 43–49 ms install in Chromium 153); the constructor ran `setQuality(1)` and then `setQuality(q)` | `n1` is a lazy property of `noiseBuf`: the first note that plays it, or a read of `synth.noiseBuf.n1`, generates it, once, with the seeded data (same bytes for every seed, `bufferVersion` 1: its stream is its own); it is a plain data property after that or after an assignment, and `Object.keys(noiseBuf)` is unchanged. A synth disposed or replaced before the read never generates it. New public `prewarm()`: synchronous, returns `undefined`, plays nothing, creates or resumes no context, a no-op before a context exists, after `dispose()` or when built. `playMIDI()` calls it after its eligibility checks and before reading the clock, so the first play per installation waits the build (20-47 ms on a desktop) and nothing within the song shifts. `convBuf` is `null` and no convolver exists with `useReverb: 0`; `useReverb` is read at each install. One `setQuality` in the constructor. Nothing global is cached, so no context is retained | `tests/unit/init-cost.test.mjs` and `tests/node/init-cost.test.cjs` (both builds), `tests/unit/seed.test.mjs`, browser spec `seed` (no `convBuf` with `useReverb: 0`) | code that reads `convBuf` with `useReverb: 0` (now `null`); the first cymbal or hi-hat note after construction starts after the generation, once (41–47 ms in Chromium 153, 26–29 ms in Firefox 155, 20–29 ms in WebKit 26.6), with its full envelope (`noteOn()` resolves the buffer before it reads the onset); a caller who wants it earlier reads `noiseBuf.n1` | implemented (T8-perf, branch `t8/perf`; tasks/T8.md) |
