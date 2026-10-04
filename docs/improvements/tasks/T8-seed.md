# T8-seed: deterministic built-in buffers (#7, D-004, ledger L-07)

| Item | Value |
| --- | --- |
| Task | T8-seed (#7 runtime): replace every `Math.random()` call in the library with seeded per-buffer mulberry32 streams, so the reverb impulse (`convBuf`), `n0` and `n1` are deterministic by default; add a `seed` constructor option, a read-only seed and a buffer generation version. The #18 performance work is not part of this task. |
| Base commit | `d1f0e26d997dccb27b5dec1f77e944f39b62c8e9` (head of `t4/lifecycle`) |
| Branch / worktree | `t8/seed` in `/workspace/webaudio-tinysynth-worktrees/t8-seed` |
| Assignment | `_evidence/assignments/T8S.md` and `CONCURRENCY.md` (rules 1–9), plus the supervisor's notices: the resume after the container crash (rebuild, re-run the interrupted validation, commit, report), rule 8 (heavy browser runs under a shared lock) and rule 9 (signing) |
| Records read | `decisions.md` (D-003, D-004, D-013, D-018, D-024, D-028 to D-030; D-024 and later read from `improve/integration`), `contracts.md` (determinism contract, L-07), `tasks/T0.md` (Q13, Math.random count), `tasks/T4.md`, `tasks/T6.md` (§13 phase-B row for #7, §14.5) |
| Evidence outside the repo | `/workspace/webaudio-tinysynth-worktrees/_evidence/t8-seed/`: `logs/` (command logs; `logs/final/` the final runs after the crash), `results/<run>/results.json` (matrix records), `scratch/` (`reference.js`, `hashes.js`, `characterize.js`), `characterization/` (L-07 statistics), `mutation/` (script, per-mutant logs, `summary.txt`, `browser/`) |
| Toolchain | Node 24.21.0 / npm 11.19.0 (`_evidence/t1-tooling/tools`); `playwright-core` 1.63.0; Chromium 153.0.8010.12, Firefox 155.0 and WebKit 26.6 through `_evidence/t6-validation/env.sh` |

## Issue revisions

Rechecked live with `gh issue view 7 --json updatedAt,body,comments` (read only) before starting: unchanged, no comments.

| Issue | updatedAt | sha256(body)[:16] |
| --- | --- | --- |
| #7 | 2026-10-03T00:17:17Z | `6cf29e0b688d650a` |

## 1. Commits

All GPG-signed. Signing was down for a while after the crash; no commit was made in that window, so nothing needed re-signing.

| Commit | Subject | Files |
| --- | --- | --- |
| `041b48d` | Generate the reverb and noise buffers from a seed (#7) | `webaudio-tinysynth.js` |
| `86a7e57` | Add seeded buffer tests and expectations, and raise the test floors | `tests/unit/seed.test.mjs`, `tests/node/seed.test.cjs`, `tests/browser/specs/seed-expected.js` (new), `package.json` (floors) |
| `aeceb6d` | Add the browser seed spec and pass the render pages' seed to the library | `tests/browser/specs/seed.js` (new); T6 files: `tests/browser/matrix.js` (one line), `tests/browser/page/render.js` (one line and its comment), see §5 |
| `83021df` | Rebuild webaudio-tinysynth.min.js and source map (D-003) | `webaudio-tinysynth.min.js`, `webaudio-tinysynth.min.js.map` |
| this record | Record T8-seed execution | `docs/improvements/tasks/T8-seed.md` |

The container crashed during the first full matrix run (after commit `aeceb6d`; the rebuilt min.js was not yet committed). After the restart the pinned `npm run build` produced byte-identical files (`logs/min-before-rebuild.txt`), committed as `83021df`, and every command in §7 was re-run from `npm ci` on that head.

## 2. Implementation as built

**Generator.** mulberry32 (Tommy Ettinger), 32-bit state: per draw the state advances by `0x6D2B79F5` (mod 2^32) and the output is a hash of the state, divided by 2^32, so every draw is an exact `k / 2^32` in [0, 1). It is a module-private function `mulberry32(a)` in `webaudio-tinysynth.js`; the state is kept with `|0`, so it stays exact for any number of draws. No global is touched and `Math.random` is not used or overridden anywhere in the library.

**Streams and the seed mix.** Each buffer has its own generator. Stream `k` starts at state `(seed + k · 2^30) mod 2^32`:

| Stream ID | k | Buffer | Draws per buffer (blen = floor(sampleRate / 2)) |
| --- | --- | --- | --- |
| `conv` | 0 | `convBuf` (2 channels) | about 2 · blen (one density draw per sample, two more per retained sample) |
| `n0` | 1 | `noiseBuf.n0` | blen |
| `n1` | 2 | `noiseBuf.n1` | 128 (64 frequency pairs) |

Because `2^30 · 0x6D2B79F5 ≡ 2^30 (mod 2^32)`, stream `k` is exactly the seed's own mulberry32 sequence started `2^30 · k` draws on. The three streams are therefore disjoint segments of one sequence for every seed, as long as a buffer draws fewer than 2^30 values; the most any buffer draws is about 3 · 384,000 at the Web Audio maximum of 768 kHz. Generating, skipping or reordering one buffer cannot change another's samples. The formulas per buffer are upstream's, unchanged (sparse exponentially decaying stereo impulse; uniform white noise `2r − 1`; 64 sine-product pairs with frequencies `440 · (10r + 1)` per half-second buffer, summed `/8`). Upstream drew the impulse and `n0` values interleaved from one stream; version 1 splits them.

**Buffer generation version.** `bufferVersion = 1`. Any change to the generated data must increment it, with a new expectations table.

**Default seed.** `0`. A plain documented constant, chosen before measuring; §6 characterizes it against upstream's distribution and does not re-pick it.

**API.**
- Constructor option `seed`: an unsigned 32-bit integer, 0 to 4294967295. Absent or `undefined` means the default 0. Anything else is rejected before anything is created (no context, node, timer or trace entry; tested), alongside T4's option checks:
  - a non-number (`null`, strings, BigInt, booleans, objects, arrays, functions, symbols) throws `TypeError("seed must be a number")`;
  - a number that is not an integer in range (negative, fractional, NaN, ±Infinity, ≥ 2^32) throws `RangeError("seed must be an integer from 0 to 4294967295")`.
  - Normalization: none beyond `seed >>> 0`, which only maps `-0` to `0`. No coercion of strings or other types.
- Read-only instance properties `seed` (the effective seed) and `bufferVersion` (1): own, enumerable, non-writable, non-configurable. Assigning throws in strict code and is ignored otherwise.
- The buffers are generated in `setAudioContext()` exactly when they were before: at every context install (eager, lazy or replacement), at the new context's sample rate, from the instance's seed. There is no cache: every synth and every context gets new `AudioBuffer`s, and `dispose()` releases them as T4 does (tested).
- `useReverb: 0` still generates `convBuf`, as before; skipping it is #18's work. The stream design already makes that safe: the tests show `n0` and `n1` equal their streams generated alone.

**Sample rate and engines.** The data depends on the sample rate because the buffers are 0.5 s long (44.1 and 48 kHz give different hashes, as D-004 expects). The same seed, version and rate gave identical Float32 data in Node (V8), Chromium, Firefox and WebKit (§3). That relies on `Math.exp` and `Math.sin` agreeing to Float32 precision; it held for every tested seed and both rates, but it is an observation, not a promise: rendered audio across engines is compared with T6's tolerances, never sample by sample (D-004).

## 3. Hashes

SHA-256 of the buffer's Float32 data, little-endian, channels in order (`convBuf` left then right). Full values in `tests/browser/specs/seed-expected.js`, computed by an independent reference (BigInt uint32 mulberry32 written from the C reference, plus the documented formulas; `scratch/reference.js`, and again inside `tests/unit/seed.test.mjs`), not read back from the library.

| Rate | Seed | `convBuf` | `n0` | `n1` |
| --- | --- | --- | --- | --- |
| 44100 | 0 (default) | `568ec5af82edc750…` | `0421a211b484bd5d…` | `e4ff95d4e406ca64…` |
| 44100 | 1 | `7b42349da3d95c6a…` | `a8297643d75fa6ab…` | `82e1110724341dde…` |
| 44100 | 0x5eed0001 | `a9e354d667c6f28f…` | `550b553c3c5fe568…` | `cd651f5c0bc02eb1…` |
| 44100 | 0xffffffff | `74f41279333feb4f…` | `b2862f9123f133b0…` | `4c0421f82004f01b…` |
| 48000 | 0 (default) | `1701f8b601236bb5…` | `32c62ee579dc5118…` | `d9cee503e9ad32a5…` |
| 48000 | 1 | `d41c7d1f3703bd27…` | `cb0b1cac1cfadd85…` | `096c889a37040676…` |
| 48000 | 0x5eed0001 | `3ae12f7d0ae1d5ba…` | `5e4f7ca5df344f5f…` | `3e9e3f2982e41b33…` |
| 48000 | 0xffffffff | `8c40085f3bb64a70…` | `248d4a263deecba5…` | `14f295ce435b3975…` |

Default seed, full values: 44.1 kHz `convBuf` `568ec5af82edc750bac5a4ccbe5d7bf0b387087af473b679a954257e8f0448cf`, `n0` `0421a211b484bd5ddc91a962edb4dbc410cf05987bde6b9a7eba52d63e206641`, `n1` `e4ff95d4e406ca64e26904749a4e800b064e32f47ab5f7edf3c36f91e6389d21`; 48 kHz `convBuf` `1701f8b601236bb5b18b613606a73b5da0f3891573e60f7c56ade018907bed7a`, `n0` `32c62ee579dc5118464b6346d16ee6322f1c328d729bf380cd56239b82b89ad7`, `n1` `d9cee503e9ad32a5c4c1de0844c04a73e499a6f2a61458aabac7f6f17cd75fce`.

## 4. Tests

| File | What it checks |
| --- | --- |
| `tests/unit/seed.test.mjs` (22 tests) | The table equals the independent reference for every seed and rate; the 2^30 stream spacing identity. For both builds on the mock, with a `Math.random` that counts and throws loaded first: default `seed` 0 and `bufferVersion` 1, read-only; buffers equal the table at 44.1 and 48 kHz for the default and every listed seed; each buffer equals its stream generated alone by the reference (sample for sample); `useReverb: 0`, quality 0, lazy start, `setQuality()` and context replacement give the same buffers; repeated construction repeats the data, with new `AudioBuffer`s per synth and context (no cache), and `dispose()` releases them; six seeds, including ones 2^30 apart, differ in every buffer; edge seeds (0, -0, 2^31, 2^32 − 1); 18 invalid seeds throw the right error before any trace entry or timer, with and without `lazy`; no `Math.random` call through construction, noise drums and programs in both qualities, MIDI playback, replacement and disposal; the mock trace is identical for different seeds. |
| `tests/node/seed.test.cjs` (2 tests) | Each build loaded with `require()` in two fresh Node processes whose global `Math.random` throws: both loads give the table's hashes at both rates for the default seed and 0xffffffff, and the same output. |
| `tests/browser/specs/seed.js` (8 cases per engine: build × quality × rate) | Pages get a throwing, counting `Math.random` before the library. Two loads: buffers for the default seed, every listed seed and `useReverb: 0` equal the table (SHA-256 computed in Node from the page's Float32 data); `seed` and `bufferVersion` read back. The realtime default path `new WebAudioTinySynth()` gives the default-seed buffers for its context's rate on both loads. Renders of noise drums (n0 and n1 timbres) plus a reverb note at seed 0 repeat across loads within the engine's same-engine tolerance (non-reproducible differences re-rendered, as in `specs/render.js`); seed 1 changes the render by more than `seedEffect`; all renders finite and audible; zero `Math.random` calls, page errors or unhandled rejections. |
| `tests/browser/specs/seed-expected.js` | The seeded expectations (data only), kept apart from the upstream fixtures. |

**Fixtures and traces.** The upstream differential, tempo and loop-end regressions pass unchanged (§7). The mock records `createBuffer` calls but never sample data (T0 already noted it; the unit test "the mock trace does not depend on the seed" asserts identical traces for seeds 0 and 0xffffffff), so #7 cannot change those traces. No upstream fixture or expectation was edited; the seeded table is a new file.

## 5. T6 files touched outside the enumerated list

Both are one-line changes, required because the library no longer reads `Math.random`; revert them if the supervisor prefers another route.
- `tests/browser/matrix.js`: declares the `seed` spec. A spec file is not run unless it is declared there.
- `tests/browser/page/render.js`: `t6.render()` now passes its `spec.seed` to the constructor as `seed` (`Object.assign({ seed: spec.seed }, spec.options)`; an explicit `options.seed` wins). Without it, `specs/render.js`'s check "seed N+1 changes the noise-based output (the seeding is effective)" fails on this branch, since the prelude's Math.random seed no longer reaches the library. T6.md §13 names "prelude seeding" as what the #7 row replaces. Builds without the option ignore it, so T6-B's vacuity runs on older builds are unaffected.

Consequences, observed (full matrix `results/full3`; variation spec on Chromium, `logs/final/variation-chromium.log`): the render spec and the runner's cross-engine "generated buffers identical across engines" check now run with library seed `0x5eed0001` (the matrix seed) instead of the prelude stream. The variation spec's per-seed observations vary with the library's seed again ("distinct generated buffers across seeds 1..6" = 6, repeat renders identical), and its `randomCalls` observation is 0. `scripts/browser-matrix.js` still prints "test pages only; Math.random replaced before the library loads" for the seed; that line is T6's and was left as is.

## 6. L-07: the sound change, characterized

Before: every context install drew new buffers from `Math.random`. After: version 1 data from seed 0. To check the default is a typical draw, not an outlier, `scratch/characterize.js` measured buffer statistics for 500 upstream loads (upstream `3d75aee`, native `Math.random`) and for seeds 1–500 under version 1, at 44.1 and 48 kHz (`characterization/l07-*.json`).

| Metric (44.1 kHz) | Upstream, 500 loads: mean ± sd [p5, p95] | Seeds 1–500: mean ± sd | Default seed 0 (percentile of upstream) |
| --- | --- | --- | --- |
| `convBuf` energy (dB) | 21.062 ± 0.040 [20.998, 21.125] | 21.062 ± 0.039 | 21.067 (53) |
| `convBuf` energy centroid (ms) | 66.96 ± 0.42 [66.29, 67.64] | 66.95 ± 0.45 | 67.06 (57) |
| `convBuf` density | 0.5001 ± 0.0027 | 0.4999 ± 0.0027 | 0.5000 (50) |
| `convBuf` L/R correlation | −0.0002 ± 0.013 [−0.021, 0.020] | −0.0005 ± 0.013 | −0.012 (18) |
| `n0` RMS (dB) | −4.771 ± 0.027 [−4.813, −4.725] | −4.770 ± 0.027 | −4.808 (8) |
| `n1` RMS (dB) | −5.991 ± 0.048 [−6.057, −5.906] | −5.998 ± 0.045 | −6.010 (40) |
| `n1` peak | 4.58 ± 0.22 [4.22, 4.96] | 4.58 ± 0.23 | 4.46 (28) |
| `n1` zero-crossing rate (Hz) | 7622 ± 248 [7204, 8059] | 7596 ± 244 | 7997 (93) |

At 48 kHz the default's percentiles are 21 (impulse energy), 10 (impulse density), 14 (`n0` RMS), 48 (`n1` RMS) and 94 (`n1` zero-crossing rate); all metrics are in `characterization/l07-48000.json`. Findings:
- Version 1 keeps upstream's statistical character: across seeds, every metric's mean and spread match upstream's.
- Seed 0 lies inside upstream's 5–95 % range on every metric at both rates. Its most atypical traits are a metallic noise (`n1`) on the bright side (93rd/94th percentile of zero-crossing rate, about 1.5 sd above the mean) and white noise 0.04 dB quieter than average (8th percentile). Both are within normal load-to-load variation, which T6 measured at render level as up to 1.5 dB (Chromium, WebKit) or 2.8 dB (Firefox) in drum energy and 4 dB in the reverb tail across seeds.
- **Render level.** On Chromium with library seeds 1–6, the variation spec measured a drum RMS spread of at most 0.77 dB and a reverb-tail spread of 6.7 dB (T6 measured 1.5 dB and 4.0 dB with six prelude seeds). The tail metric (`specs/render.js` "reverb": a 300 Hz sine, RMS 0.1–0.45 s after note-off) is a narrow-band projection of the impulse, so it varies widely from draw to draw. To place seed 0 on it, `scratch/reverb-tail.js` computes the same window by direct convolution of the impulse (a proxy without the envelope and fixed gains; it follows the browser renders, seed-to-seed differences agree within 1.4 dB) for 150 upstream loads and seeds 1–150 (`characterization/l07-reverb-tail-44100.json`). Upstream: sd 2.4 dB, 5–95 % range 7.9 dB. Seeds: sd 2.1 dB. Seed 0 is at the 81st percentile of upstream's loads, 2.2 dB above the mean and inside the band. The matrix seed `0x5eed0001` is near the 3rd percentile; the render spec's reverb check still passes with it, by a 10× margin.
- So listeners hear one fixed draw from the distribution upstream sampled on every load. It differs from any particular upstream load the way two upstream loads differ from each other, and then stays the same.

## 7. Commands and results (final, after the crash, head `83021df`)

| Command | Result |
| --- | --- |
| `npm ci` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run verify` | PASS: committed distribution matches the pinned build |
| `npm test` | exit 0. Unit 7 files, 458 tests (floors raised 6/436 → 7/458); node 8 files, 117 tests (7/115 → 8/117); regressions: differential (identical `_note` sequences and call traces against upstream plus patches), tempo and loop-end PASS |
| `npm run pack:check` | PASS |
| `npm run test:browser` | 2 of 2 PASS |
| `npm run test:browser:matrix` (full T6 matrix, all assert specs, 3 engines; run under the shared lock, CONCURRENCY.md rule 8) | PASS: 84 cases (`results/full3`, `logs/final/matrix-full3.log`). Chromium 153.0.8010.12, Firefox 155.0 and WebKit 26.6 each pass embed 72/72, render 500/500, gesture 54/54, url 10/10, lifecycle 18/18, dispose 96/96, start 102/102, offline 16/16 and seed 88/88. Cross-engine: generated buffers identical in every render case (library seed `0x5eed0001` through the render page: 44.1 kHz `53c404b6…`/`41e583b8…`/`9f871ffe…`, 48 kHz `33e7566d…`/`f49f8633…`/`30b1ff71…`, page cyrb53 hashes); GM per-slot energy spread at most 5.57 dB (tolerance 7 dB); linear-level gain spread 0.0000 dB. The render spec's alternate-seed check ("seed N+1 changes the noise-based output") passes with the library seed. |
| seed spec per engine | Chromium 153.0.8010.12, Firefox 155.0 and WebKit 26.6: 8 of 8 cases, 88 of 88 checks each (in every full run and in the development runs). Buffers equal the table in all three engines (cross-engine identity of the data); the realtime default context ran at 44.1 kHz and gave the default-seed hashes; same-seed renders across loads were bit-identical in all three engines (no re-render was needed); seed 1 changed the render by 0.38 to 0.83 (`seedEffect` 0.01); zero Math.random calls |

**Runs that did not count.** The first full run (`logs/matrix-full1.log`) was cut off by the container crash. The second (`results/full2`) failed only on three Chromium render cases with "Target crashed", plus the cross-engine checks that need them. While those ran, the host had about 460 MB of free memory and swap was full: WebKit content processes from another agent's vacuity run on a pre-T2 build held 18 to 35 GB each. Everything else in that run passed, including the seed spec in all three engines. Stopping only this task's own run was refused by the permission system, so it ran to its end. The third run, under the new shared lock with a healthy host (load average about 4), passed everything.

PulseAudio: the shared null sink died with the container; this task restarted it with `_evidence/t6-validation/tools/pulse-start.sh` (PID 13044, `logs/pulse.pid`) and leaves it running for the other agents.

**Mutation check** (`mutation/run-mutants.sh`; each mutant is a scratch copy with one change to `webaudio-tinysynth.js`; the repository is never modified):

| Mutant | Seed unit tests (source build) | Node seed test | Browser seed spec (Chromium, `--source`) |
| --- | --- | --- | --- |
| shared stream: `n0` continues the `convBuf` stream (`r=rnd(1)` removed) | 5 fail | 1 fails | all 4 source cases fail (12 of 88 checks: `n0` hashes differ on both loads, and the realtime default path); the unmutated min cases pass |
| stray `Math.random`: `dn[i]=Math.random()*2-1` | 9 fail | 1 fails | all 4 source cases fail: construction throws "Math.random called (#7: …)"; min cases pass |
| same start: every stream starts at `seed` | 5 fail | 1 fails | |
| seed ignored: streams start at `k · 2^30` | 5 fail | 1 fails | |
| validation removed (TypeError branch) | 1 fails | passes (not its scope) | |
| `seed` writable | 1 fails | passes (not its scope) | |

## 8. Sizes (against the base `d1f0e26`)

| File | Base bytes / gzip (Node level 9) / gzip -9 -n | T8-seed | sha256 (T8-seed) |
| --- | --- | --- | --- |
| `webaudio-tinysynth.js` | 67,531 / 16,958 / 16,836 | 68,900 / 17,620 / 17,489 | `0d01b8ecd4edacf6411b11a0dfceaf1462126d48635f60928ae9604f7fa34983` |
| `webaudio-tinysynth.min.js` | 40,138 / 11,067 / 10,963 (`7a6bc3e9…`) | 40,694 / 11,334 / 11,222 (+556 / +267 / +259) | `683d7cc5c7fff58dceb7a8b952dd830c96d24b9409a379241501aeec2da6d27f` |
| `webaudio-tinysynth.min.js.map` | 64,972 / 13,650 | 65,890 / 13,976 | `10900477200fbee64bbcfd1e00b1e46513f9f72a4d7100b7a36f334e7efefc83` |

The min.js growth is the generator, the split loops, the two error messages and the property definitions; comments are not kept. D-024: the consumer's metric is gzip, with no engine budget.

## 9. Draft README/NOTICE text (for the supervisor, CONCURRENCY.md rule 4)

README, "What behaves differently" bullet:

> - The reverb and noise sounds are the same on every load. The reverb impulse and the two noise buffers (`n0`, used by most drums, and `n1`, the metallic noise of cymbals and hi-hats) are generated from a seed instead of `Math.random`, so a given seed, sample rate and library version always produce the same buffer data. The default seed is `0`; pass `seed` to the constructor to choose another. Compared with upstream, the reverb and noise texture changes once and then stays fixed. Upstream drew new random buffers each time an AudioContext was installed. Rendered audio can still differ slightly between browsers and between sample rates.

README, constructor options (after **lazy**):

> **seed** : an integer from `0` to `4294967295` that fixes the reverb impulse and the noise buffers (`n0`, `n1`). default is `0`. The same seed gives the same buffer data on every load and in every instance at a given sample rate; the data differs between sample rates (the buffers are 0.5 s long). Any other value throws a `TypeError` (not a number) or a `RangeError` before anything is created.

README, Properties table (two rows) and note:

> |**seed**           | 0        | seed of the reverb and noise buffers (constructor option, read-only) |
> |**bufferVersion**  | 1        | version of the buffer generation (read-only). A library change that alters the generated buffers increments it. |

> * The buffers are generated with mulberry32, one stream per buffer starting at `seed + k·2^30` (k = 0 reverb, 1 `n0`, 2 `n1`), so changing or skipping one buffer never changes another.

NOTICE bullet:

> - webaudio-tinysynth.js: the reverb impulse and the n0/n1 noise buffers are generated from seeded mulberry32 streams (one per buffer) instead of Math.random, with a fixed default seed of 0, a `seed` constructor option and read-only `seed` and `bufferVersion` properties. The generated reverb and noise texture differs from upstream once and is then the same on every load.

## 10. Integration notes and risks

- **Merge order** (D-030: after T4, T3.1 and T11; before T12 and T5). Expected conflicts: the constructor (T4 lines are unchanged; the seed check is a separate block after `this._check(c,d)`, so a T11 or T5 option line next to it may conflict mechanically), `setAudioContext()` (only the three generation loops changed; T11's registry rebuild sits further down), `tests/browser/matrix.js` (adjacent spec lines from T6-B.1, T11, T12) and the two floor lines in `package.json` (recompute from the runners' output, CONCURRENCY.md rule 5). After any conflict, rebuild with `npm run build` (D-003).
- **T5** should fold the seed check into its general option validator, keeping the two error types and the `seed must be …` messages, which the tests match with `/^seed must be /`.
- **#18** may skip `convBuf` when `useReverb` is 0, or generate lazily: the per-buffer streams make that safe, and `tests/unit/seed.test.mjs` will catch a change to any remaining buffer. The test "useReverb: 0 … give the same buffers" checks `convBuf` too, so it must be relaxed for `convBuf` only if #18 stops generating it.
- **Cross-engine data identity** depends on `Math.exp`/`Math.sin` agreeing to Float32 precision. It held in V8, SpiderMonkey and JavaScriptCore for every tested case. A future engine could differ, so equal hashes across engines are recorded and tested as a matter of fact, not promised to users.
- **Cost unchanged.** Generation takes as long as before: the `n1` loop dominates. Measuring and reducing it is #18.
- **Consumer.** Under D-023's notice rule, the integration SHA sent to onchain-tinysynth should say that the reverb and noise texture changed once (L-07), and that `noiseBuf` contents are now fixed per seed and rate. TinyChip's `nNOI` fallback to `n0` becomes deterministic (D-027).
