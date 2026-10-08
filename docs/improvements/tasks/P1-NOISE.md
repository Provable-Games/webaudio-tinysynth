# P1-NOISE: bounded #91 noise-path investigation

| Item | Value |
| --- | --- |
| Issue | [#91: investigate intermittent WebKit sample-render shifts and qualify the production noise path](https://github.com/Provable-Games/webaudio-tinysynth/issues/91) |
| Base | `5c71dd213d85232aa9bc498a615d7e95fd8bb2ab` |
| Branch / worktree | `p1/noise-path` / `/workspace/webaudio-tinysynth-worktrees/p1-noise-path` |
| Scope | Investigation scripts, pure PCM analysis, fault tests and this record. No engine-source or shipped-audio change. |
| Status | **Incomplete.** The cause and a production-safe remedy are not established; physical-device and final production-bank qualification remain pending. |
| Evidence | `/workspace/webaudio-tinysynth-worktrees/_evidence/p1-noise-path/` |

## 1. Question and claim limits

The reducer investigates the first-attempt discrepancies documented by T13.1 §4. It captures one terminating render per fresh `OfflineAudioContext`, records the effective source and graph configuration, retains the first successful PCM and every divergent first-attempt PCM, and never retries. Disagreement counts describe these bounded captures relative to their first PCM; the first PCM may itself be shifted, so the counts are not event probabilities or listener-risk estimates.

The WebKit runs are native headless Linux WebKit/WPE renders through Playwright. They are not mock-WebAudio results, physical Safari/iOS runs, real-time audio, or evidence of what a listener hears. The exact-zero flag is true only when every sample is finite and numerically equal to `0`; positive and negative zero both count. It does not use a near-zero or audibility threshold. No clipping judgment or composer listening check was performed.

## 2. Reducer and analysis contract

`scripts/noise-path-reducer.js` is an investigation CLI, not a pass/fail gate. It requires an absolute, caller-selected `--out` path and accepts an optional `--evidence-root`; it has no fixed evidence path. It accepts only 44,100 or 48,000 Hz and 1–6,000 contexts per condition. It creates a fresh context for each first attempt, recycles pages after at most 32 contexts, records all returned attempts and errors, and keeps the first PCM plus all non-finite, exact-zero or differing PCM. Source-buffer bytes and hashes are captured before synth disposal. A separate external deadline wraps each command; browser-side page timeouts are not treated as render deadlines.

The optional `--instrument-scheduler=true` mode wraps the existing interval callback and `_releaseNote`, `_limitVoices` and `_pruneNote` methods only in the reducer's library graph. Wrappers preserve receiver, arguments, return value and exceptions and record `performance.now()`, context time, and voice `t`, `s`, `e` and release fields. It is diagnostic instrumentation; it is not used in the rare-event campaigns.

`scripts/noise-path-analysis.js` scans both channels and all samples for non-finite values, distinguishes bitwise signed-zero differences from numerical differences, and locates the first numeric sample and render quantum. Correlation and lag alignment are calculated only for finite divergent PCM. They are diagnostics: every record preserves the original unaligned comparison. `scripts/noise-path-pair-analysis.js` fails closed on missing/duplicate trials, incomplete first-reference data, malformed PCM, hash mismatches, source/buffer/rate/graph mismatches or incomplete metadata. An omitted later PCM falls back to the first payload only when its recorded digest proves byte identity with that reference.

The reducer metadata marks its output “investigation only.” Exact-zero output is not used as a proxy for near-zero audibility. `scripts/noise-path-capture-analysis.js` accepts only complete all-rendered finite captures, requires trial 0 as the unique first-success reference, validates bounded duration before PCM sizing, and checks each retained attempt's finite, exact-zero and disagreement flags plus summary totals against decoded PCM. It also validates PCM lengths and digests before producing within-capture first-reference diagnostics. It never changes the reducer's original disagreement fields. Earlier raw JSONL captures retain the reducer's original metadata phrase “bitwise numerical silence only”; the predicate was numerical equality to zero, including both signed-zero encodings. The wording was corrected in source after those records were captured, without changing PCM or verdict logic, and the raw records remain unchanged.

## 3. Reproduction from a fresh checkout

Use Node `>=24.11 <25`, install the repository's pinned development dependencies with `npm install`, and make the matching Playwright browser available. The reducer resolves `playwright-core` and Terser through normal Node module resolution. Set `PLAYWRIGHT_BROWSERS_PATH` to the Playwright-managed browser directory that matches the installed Core version. The native captures in this report used Core 1.64.0-alpha-2026-10-05 with WebKit revision 2370/WPE; the initial controls used Core 1.63.0 with revision 2359/WPE. A matching installed browser is required; no browser is downloaded by the reducer.

The reducer requires a caller-selected absolute output and optionally confines it under `--evidence-root`. Start with a bounded one-context recorder check or a small control. For example, after WebKit is installed:

```sh
EVIDENCE="$(mktemp -d)"
export PLAYWRIGHT_BROWSERS_PATH="/absolute/path/to/matching/playwright-browsers"
export NODE_OPTIONS="--max-old-space-size=1024"
node scripts/run-with-deadline.js 180 node scripts/noise-path-reducer.js \
  --engine=webkit --library=source --graph=manual-no-compressor-no-detune-connection \
  --scenario=gm-noise --sr=44100 --n=1 --batch-size=1 \
  --duration=0.5 --start=0.05 --hold=0.07 --loop=true \
  --variant=baseline --instrument-scheduler=false \
  --evidence-root="$EVIDENCE" --out="$EVIDENCE/manual.jsonl"
```

The available graphs are `library`, `manual-chain`, `manual-no-compressor`, `manual-no-compressor-no-detune-connection`, `manual-no-panner`, and `manual-direct`. `--loop=true|false` is limited to manual graphs and defaults to `true`; it records and sets the manual BufferSource loop flag. The only scenarios are `gm-noise` and the pinned-fixture `tinychip-bass`; the latter is fixture data, not final production mapping. The CLI restricts contexts to 1–6,000 per condition and sample rates to exactly 44,100 or 48,000 Hz. Every render command should have an external deadline; a page timeout is not a render deadline.

For within-capture audit and a paired library/manual-chain comparison:

```sh
node scripts/run-with-deadline.js 180 node scripts/noise-path-reducer.js \
  --engine=webkit --library=source --graph=library --scenario=gm-noise \
  --sr=44100 --n=1 --batch-size=1 --duration=0.5 --start=0.05 --hold=0.07 \
  --variant=baseline --instrument-scheduler=false \
  --evidence-root="$EVIDENCE" --out="$EVIDENCE/library.jsonl"
node scripts/run-with-deadline.js 180 node scripts/noise-path-reducer.js \
  --engine=webkit --library=source --graph=manual-chain --scenario=gm-noise \
  --sr=44100 --n=1 --batch-size=1 --duration=0.5 --start=0.05 --hold=0.07 \
  --variant=baseline --instrument-scheduler=false \
  --evidence-root="$EVIDENCE" --out="$EVIDENCE/manual-chain.jsonl"
node scripts/run-with-deadline.js 180 node scripts/noise-path-capture-analysis.js \
  --capture="$EVIDENCE/manual-chain.jsonl" --max-lag=512 \
  --evidence-root="$EVIDENCE" --out="$EVIDENCE/manual-analysis.jsonl"
node scripts/run-with-deadline.js 180 node scripts/noise-path-pair-analysis.js \
  --library="$EVIDENCE/library.jsonl" --manual="$EVIDENCE/manual-chain.jsonl" \
  --max-lag=512 --evidence-root="$EVIDENCE" --out="$EVIDENCE/paired-analysis.jsonl"
```

The pair command expects a `graph=library` capture and a `graph=manual-chain` capture with matching input metadata. Both analysis tools preserve the first unaligned comparison; lag alignment is diagnostic only. Focused data-only checks run with `node --test tests/node/noise-path-analysis.test.cjs`.

## 4. Measured native Linux WebKit results

All GM captures below use quality 0 program 126 (Applause), note 60, velocity 100, start `0.05 s`, hold `0.07 s`, a looped `n0` source at effective rate `0.10000000149011612`, and a `0.5 s` render unless otherwise stated. The operator definition is `{w:"n0",v:0.5,a:0.2,d:11,t:0,f:44,g:0,h:0.01,s:0,r:0.05,p:1,q:1,k:0}`. The 44.1 kHz source buffer is 22,050 frames with SHA-256 `0421a211b484bd5ddc91a962edb4dbc410cf05987bde6b9a7eba52d63e206641`; the 48 kHz buffer has SHA-256 `32c62ee579dc5118464b6346d16ee6322f1c328d729bf380cd56239b82b89ad7`.

**Initial controls, Playwright Core 1.63.0 / WebKit revision 2359 / WebKit 26.6:** source and fresh-min each rendered 128/128 contexts at each sample rate with zero within-graph disagreements, finite nonzero PCM and the same source hash within a rate. The paired library/manual-chain control had 128 pairs at each rate: all 128 per rate were numeric signal matches, with signed-zero bit-pattern differences only. These controls show recorder and graph parity in those samples; they do not resolve a rare event.

**Bounded stage 1, revision 2359, 44.1 kHz:** the library graph and the manual-chain graph each rendered 1,024/1,024 contexts. The library graph had first-reference disagreements at trials 61, 515, 537 and 813; the manual graph had none in this separate run. Strict pairing compared 1,024/1,024 trial IDs with matching source-buffer hashes, effective rates and graph readbacks; it retained four numeric divergences. Trial 813's best lag was −128 frames (correlation 0.859), but the aligned overlap still had 39,160 numeric sample differences. This does not identify where in the graph the discrepancy originates.

**Bounded stage 1, revision 2370, 44.1 kHz:** the library graph and manual-chain graph each rendered 1,024/1,024 contexts. The library graph disagreed with its first PCM once (trial 185); the manual graph did so three times (trials 349, 573 and 636). The strict pair analyzer compared all 1,024 pairs: four numeric divergences, no source-hash, effective-rate or graph-setting mismatch, and 1,020 numeric signal matches with signed-zero-only bit differences. Numeric first differences began at frame 4,488 (quantum 35, offset 8), 8,712 (quantum 68, offset 8), 3,208 (quantum 25, offset 8), and 5,472 (quantum 42, offset 96). Three selected ±128-frame lags; after alignment each still retained tens of thousands of numerical sample differences. The manual graph has no TinySynth instance, timer or warm-up voice, so a synth scheduler or synth constructor is not required for every observed discrepancy. This remains a WebAudio graph, not a reproduction without `AudioBufferSourceNode`.

**Manual compressor ablation, revision 2370, 44.1 kHz:** one additional 1,024-context condition removed only the `DynamicsCompressorNode` from the manual chain. It retained the same looped mono `n0` buffer and effective rate, operator envelope, LFO and zero-gain detune connection, channel/master gains and stereo panner. It rendered 1,024/1,024 with no recorder or finite-sample errors and disagreed with its own first PCM nine times. First numeric differences began at frames 3,328, 13,824, 3,456, 3,584, 3,840, 3,968, 4,352, 16,512 and 4,096; these are all multiples of 128. Seven finite lag diagnostics selected +128 frames (correlation 0.705–0.966), while alignment still left 39,688 numeric differences in each of those overlaps. Two later, lower-amplitude tails selected lag 0. The maximum absolute sample difference was 0.10691. The connected 1,024-context manual run was separate and not interleaved; the counts cannot establish relative event rates. The observation shows that the compressor is not necessary for every discrepancy, while its presence changes the observed difference shape.

**Zero-gain detune-connection ablation, revision 2370:** a four-context numeric parity smoke rendered one connected and one unconnected graph at each sample rate. The unconnected variant omits only `modulation.connect(source.detune)` while keeping the LFO, modulation gain `0`, `source.detune.value` `0`, envelope, gains, panner and no-compressor output. At each rate the source hash, effective rate, graph readbacks other than the connection flag, and full PCM SHA-256 were identical in the two single attempts. This small parity check is not rare-event evidence.

One approved 1,024-context campaign then rendered the unconnected condition at 44.1 kHz. It completed 1,024/1,024 with zero errors and one within-capture first-reference disagreement at trial 93. The first numeric difference was frame 4,224 (quantum 33, offset 0), with maximum absolute sample difference 0.10691. The finite lag diagnostic selected +128 frames at correlation 0.834; the aligned overlap still had 39,688 numeric differences. This condition confirms that removing the zero-gain connection does not eliminate the observed discrepancy in this workload. Its single observed disagreement is descriptive only; it does not prove whether the connection changes frequency or cause.

**Loop flag parity and bounded condition, revision 2370:** an eight-context smoke used two attempts per `loop=true`/`false` condition at each rate on the same minimal graph. All eight renders completed without errors or within-condition disagreements. Actual loop readbacks were true and false as requested; the source-buffer hashes matched by rate (`0421…6641` at 44.1 kHz and `32c6…89ad7` at 48 kHz), the effective rate was `0.10000000149011612`, and the other graph readbacks matched. The first stereo PCM hashes were identical between loop settings at each rate. The follow-up `loop=false` condition rendered 1,024/1,024 fresh contexts at 44.1 kHz with zero errors, all finite nonzero output, and zero disagreement with its first PCM. The strict self-capture audit checked every unique trial ID and retained PCM digest. This is one bounded zero-disagreement capture and cannot establish that looping caused prior events or a remedy; it is not an event-rate estimate and is not directly rate-comparable to the separate loop=true run.

In a separate four-context observer smoke, one baseline and one instrumented library render were compared at each sample rate at `2.6 s` duration. The PCM hashes matched within each pair. The observer captured `_off=true`, one voice's release end `e=0.295 s`, and the `_releaseNote`/`_limitVoices` calls. No interval callback or `_pruneNote` was recorded. The native source at `webaudio-tinysynth.js` lines 531–533 also returns from the timer body when `_off` is true. The timer-prune hypothesis is therefore unsupported for the injected offline-context workload; no no-scheduler campaign was run.

## 5. Browser and input provenance

The older captures used Node `v24.21.0`, Playwright Core `1.63.0` from `/workspace/webaudio-tinysynth-worktrees/t13-1-flake/node_modules/playwright-core`, and the T6 shared, read-only WebKit path `/workspace/webaudio-tinysynth-worktrees/_evidence/t6-validation/ms-playwright/webkit-2359`. Its `browsers.json` SHA-256 is `545d52f8382c391e605562c330e9c1c534a16045898203037a49bb8bd769a946`. The alpha comparison used Playwright Core `1.64.0-alpha-2026-10-05` from `/workspace/webaudio-tinysynth-worktrees/_evidence/p1-noise-path/tools/playwright-alpha/node_modules/playwright-core`, private WebKit path `/workspace/webaudio-tinysynth-worktrees/_evidence/p1-noise-path/tools/playwright-alpha-browsers/webkit-2370`, package tarball SHA-256 `73ddd765a5bc23def9ee85f83806fe574e83837d57b6c900a43cc623fc4b3bc6`, and `browsers.json` SHA-256 `8f7459e04f5896ebb0633011fe12e34382b6820f60db535c3d561fffe7f6666e`. The two Playwright metadata files pin WebKit revisions 2359 and 2370 respectively; both report browser version 26.6.

The installed native backend in each path is WPE. Revision 2359's `minibrowser-wpe/bin/MiniBrowser` SHA-256 is `7c71efed38fb0d916f5edb7db9a98cdf218642dd8dce02375730eb9ad5510751`; revision 2370's is `cabd927f18f32bc22280fc5f730b84d035dd2bfb71cb53fad3ed1c3e2f3de5ef`. Their `WPEWebProcess` binaries are identical (`70683ba57c05ce81d43601e1c89701e7016c76136ae810b000cd786085091b4a`), while `libWPEWebKit-2.0.so.1.12.0` differs (`830ab277f4de888a75b576ef89efde5f7daa45436e9f4a90b677da120baffea3` at 2359; `e1c35931370da388933f3701a5d037d9e26d6701bbb0f65ca1b8ae6741be685d` at 2370). The outer `pw_run.sh` hash is `a85baad3d8c07173ac387a59b41500c382b21ed692afe0964d29aac247ccc63b` for each path. The alpha package's inner WPE shell wrapper originally replaced `LD_LIBRARY_PATH`; only the private revision-2370 wrapper was changed to append the approved T6 local libraries. Its original and patched hashes are recorded with the scripts under `_evidence/p1-noise-path/tools/`; the shared 2359 install and browser cache were not modified. Failed alpha setup attempts are retained alongside successful records.

All primary reducer captures record the source SHA-256 `0a54b09d8cbadcdfbc3ed3ba99d05ba24fc3203dde4f4e859f2827e8140a8441`, fresh-min SHA-256 `bcb498b915beb397f0333b22a59a4485d00025ff1e098cbf65823b9646759d74`, browser version, source-buffer digest, effective playback rate and graph parameter readbacks. The manually constructed page does not load the library script (`browserLibraryLoaded:false`); its operator values are read from the pinned source table in Node.

## 6. TinyChip and production coverage

The reducer can build the repository's pinned TinyChip fixture scenario. The available `tests/fixtures/consumer/waves-setup.json` SHA-256 is `e062eb826c7a083f7d1bb2799b59eaf17de225296a265238754750c698629eee`; `waves-song.mid` is `1b298eb5b7ff1fcafabb1ced28ca99e2a93983f495b56fca0d17809d800da012`. This is fixture-only old-format provenance (consumer `d7357936754b5753ee4e9cc9134a0d373b75c099`, TinyChip `b16c8ef3f0c8cc0ed252497eb2f21b91aea03389`), not the current producer's final settings. No TinyChip stress capture was used as production certification.

The read-only Casey development snapshot at `3ecad45345e5883bbac8dfa107f4de175867f8e7` contains candidate `brute`, `hunter`, `magic` and mega settings under `offchain/beast-sound/onchain/tinychip/settings/`. It exposes custom sample voices plus `WhiteNoise` and `MetallicNoise` drum definitions. For example, fixed-point offsets `/10000` give 264 Hz for `WhiteNoise` (`offset_hz:2640000`, n0 rate 0.6 at reference pitch) and 6160 Hz for `MetallicNoise` (`offset_hz:61600000`, n1 rate 14). These are development-snapshot examples, not a finalized score-to-bank mapping or qualification of any production track.

No finalized production score/bank pair, physical Safari/iOS/Android device run, real-time output check, or composer audition is attached. Those remain #76 and #80 dependencies. The affected production path is therefore not certified.

## 7. Current interpretation and next discriminator

The manual-chain and manual-no-compressor captures show that the discrepancies do not require a TinySynth instance or its compressor in this measured OfflineAudioContext graph. Removing the zero-valued LFO-to-detune connection did not eliminate the observed discrepancy in its separate 1,024-attempt run. The loop=false condition had no within-capture disagreement, but that bounded result does not establish looping as a cause or remedy. Correlation sometimes identifies a ±128-frame alignment, but large residuals remain; alignment does not turn these attempts into matches. The alpha comparison is not a controlled upgrade verdict: revision 2370 shows events in both graphs, while the 2359 and 2370 runs were separate workloads with different event counts.

No engine-source remedy is supported, and no tolerance, retry or acceptance policy was changed. No further exploratory render is planned for this wave. The loop=false test was one bounded condition with a separate loop=true comparator, so it does not establish relative rates or causal necessity.

## 8. Validation and artifacts

Focused analysis tests cover non-finite PCM, exact-zero reporting, signed zero, first-reference failures, malformed PCM, first numeric frame, lag alignment and retained residuals. Pair CLI fault tests cover missing/half/malformed/hash-mismatched PCM, duplicate/missing attempts, multiple first references, seed/buffer-version/rate and graph-readback mismatches. Capture CLI tests also reject promoting a later trial to the reference, invalid duration, contradictory per-attempt PCM flags and inconsistent summary totals.

Key task-owned raw and derived files:

- 128-context source/min and manual-chain controls: `source-q0-126-44100-controls-v3.jsonl`, `source-q0-126-48000-controls-v3.jsonl`, `min-q0-126-44100-controls-v3.jsonl`, `min-q0-126-48000-controls-v3.jsonl`, `source-paired-q0-126-*-v4.jsonl`, `manual-paired-q0-126-*-v4.jsonl`, and `paired-q0-126-*-v5-analysis.jsonl`.
- Revision-2359 first stage: `source-rare-stage1-q0-126-44100-n1024.jsonl`, `manual-rare-stage1-q0-126-44100-n1024.jsonl`, `paired-rare-stage1-q0-126-44100-n1024-analysis.jsonl`.
- Revision-2370 first stage: `source-alpha-rare-stage1-q0-126-44100-n1024.jsonl`, `manual-alpha-rare-stage1-q0-126-44100-n1024.jsonl`, `paired-alpha-rare-stage1-v2-analysis.jsonl`.
- Compressor, detune and loop controls: `manual-alpha-no-compressor-rare-stage-q0-126-44100-n1024.jsonl`, `manual-alpha-no-compressor-self-analysis.jsonl`, `detune-link-smoke-*.jsonl`, `manual-alpha-no-compressor-no-detune-rare-stage-q0-126-44100-n1024.jsonl`, `manual-alpha-no-detune-self-analysis.jsonl`, `loop-parity-{true,false}-q0-126-{44100,48000}.jsonl`, `loop-parity-smoke-analysis-v2.json`, `manual-alpha-no-compressor-no-detune-loop-false-rare-stage-q0-126-44100-n1024.jsonl`, and the original and tightened audits `manual-alpha-loop-false-portable-analysis.jsonl` and `manual-alpha-loop-false-portable-analysis-v2.jsonl`.
- Scheduler observer smoke: `scheduler-observe-*.jsonl`.
- Reproduction commands and failed setup attempts are retained under the same evidence root, including `run-rare-event-stage1.sh`, `run-alpha-rare-1024.sh`, `run-alpha-manual-no-compressor-1024.sh`, `run-alpha-detune-connection-smoke.sh`, and `run-alpha-manual-no-detune-link-1024.sh`.

The captures are native Linux browser measurements; the unit tests and synthetic analyzer fixtures are Node data-only checks. The earlier complete `npm test` run passed before the final strict capture-audit check was added: unit tests passed the configured 14-file/1,052-test completeness floor, Node tests passed 17 files/222 tests, and all 3 regression scripts passed. After that analyzer/test change, the focused file passed 29/29, `npm run test:node` passed 17 files/223 tests, `npm run lint` passed, and `git diff --check` plus `node --check` on all four tools passed.

The required final locked three-engine matrix completed with exit 1: 341/342 engine cases and all 12 cross-engine comparisons passed. Chromium 153.0.8010.12 and Firefox 155 passed all 114 cases each. WebKit 26.6 passed 113/114 cases; its only failure was the first source/min comparison for quality-0 GM program index 125 (one-based GM #126) at 44.1 kHz (`gm-programs-96-127`), maximum difference 0.393272 at frame 61,858 (1.402676 s from render start), against tolerance `1e-6`. The test uses C4/60, velocity 100, starts at 0.25 s, releases at 1.45 s, and renders 1.6 s. Its quality-0 patch is `{w:"n0",v:0.4,d:1,t:0,f:22,s:1}`; the source formula gives a requested rate of `22/440 = 0.05`, but this standard matrix did not capture the native AudioParam readback. The diagnostic re-render was clean, and the first-attempt verdict remains failed. This is a separate standard-matrix case, not evidence of the #91 cause. The standard runner retained the combined source WAV at `final-three-engine-matrix/webkit/renders/q0-44100/gm-programs-96-127.wav` (SHA-256 `dfa49d873250604fde362656b5b5d91d6d6faa56cc577173c84b63b6450a48fc`) and source-side matrix fingerprint for program index 125 (`17c7180fd795d862`); it did not retain first min PCM or its hash. The mismatch cannot be reclassified from its clean diagnostic. Full matrix log and JSON are `final-three-engine-matrix.log` and `final-three-engine-matrix/results.json` in the evidence root.

These artifacts support investigation only and do not meet #91 completion criteria.
