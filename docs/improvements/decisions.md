# Decisions

Supervisor-owned. Each entry records the decision, the reason and evidence, the affected tasks, and what would make us reconsider it. GitHub issues hold the specifications. This file records how the supervisor resolved choices the issues left open. Newest entries go at the bottom.

## D-001 Execution topology (2026-10-02)

- Integration branch `improve/integration`, created from `b70ba90` (= `origin/main`), in the worktree `/workspace/webaudio-tinysynth-worktrees/integration`. The user's checkout `/workspace/webaudio-tinysynth` stays on `main` with its untracked `AGENTS.md` and `IMPLEMENTATION_PLAN.md` untouched.
- Each subagent works in its own supervisor-created worktree `/workspace/webaudio-tinysynth-worktrees/<task>`, on branch `tN/<topic>` with an explicit base SHA. Agents never use the user's checkout.
- Large logs and browser artifacts go in `/workspace/webaudio-tinysynth-worktrees/_evidence/<task>/` (outside the repo and the session scratchpad). Small evidence and summaries are committed under `docs/improvements/`.
- The supervisor integrates accepted task branches with a signed `git merge --no-ff` into `improve/integration`, then reruns the affected checks.
- Commits are GPG-signed by config. Non-interactive signing was verified at kickoff. Agents use `timeout 60 git commit … </dev/null` and fall back to `--no-gpg-sign` only if signing fails, reporting it. The supervisor re-signs on integration.
- Reconsider if signing breaks or worktree disk use becomes a problem.

## D-002 Remote actions authorization (2026-10-02)

The user authorized pushing task branches to `Provable-Games/webaudio-tinysynth` and opening PRs, draft until ready, so CI and the Codex/Claude reviews run for real at each gate. Excluded: merging PRs on GitHub, releases, tags, npm publication, ruleset or secret changes, and onchain uploads. These need separate explicit authorization.

- Pushing the locally integrated `improve/integration` is a push, not a GitHub PR merge. Task PRs target `improve/integration`. An umbrella PR `improve/integration → main` shows the cumulative change for the user to merge.
- Ruleset facts at kickoff: `protect main` requires signed commits and a PR, with 0 approvals and no required status checks. Making the new checks required is a ruleset change; it is reported, not performed.

## D-003 Distribution regeneration on task branches (2026-10-02)

The plan says the supervisor regenerates distributions after accepted changes. Once T1 lands, CI fails any branch whose committed `webaudio-tinysynth.min.js`/map differ from a fresh pinned build, so source-changing task branches would always fail their PR checks. Decision: a source-changing task branch ends with one "Rebuild webaudio-tinysynth.min.js and source map" commit produced by the pinned `npm run build`. On integration, the supervisor reruns `npm run verify` and, after any merge-resolved conflict, regenerates the distribution instead of hand-merging minified bytes. Agents never hand-edit minified output.

## D-004 #7 default-seed policy: fixed default seed (2026-10-02)

Decision: built-in random buffers (reverb impulse `convBuf`, `n0`, `n1`) become deterministic by default with a documented fixed seed. A constructor option `seed` overrides it. This is a deliberate, versioned sound change from upstream, recorded in ledger entry L-07.

Reasons:
- The issue's author (the user) proposed "a fixed default seed so every load is deterministic". The consumer README states `WhiteNoise`/`MetallicNoise` become "Deterministic once fork issue #7 lands" and promises the same sound for the same class hash, settings and MIDI.
- The consumer page could pass a seed itself. A deterministic default, however, gives every caller the repeatability property and keeps the consumer page smaller. No known caller depends on per-load randomness.

Contract, implemented in T8 and validated in T6:
- PRNG: mulberry32 (32-bit state). Seed: an unsigned 32-bit integer, 0 to 2^32−1. Any other value is rejected with a descriptive error (T5 validation rules). There is no `Math.random` override in production code.
- Independent streams: each buffer gets its own generator, seeded by a documented mix of `(seed, streamId)` with stream IDs `conv`, `n0`, `n1`. Lazy or skipped generation of one buffer (for example reverb disabled, under #18) must not change another buffer's samples.
- A documented buffer-generation version number. It starts at 1, and any change to generated data increments it.
- Same seed, version and context sample rate produce identical Float32 buffer data. Different sample rates produce different data, which is documented. Rendered PCM equality across browser engines is not promised. T6 sets tolerances.
- Upstream compatibility fixtures stay untouched. Seeded expectations are added separately. No cache may retain a disposed context.
- Reconsider if the user asks for upstream stochastic defaults, or if a consumer needs a per-token seed (which is additive: pass `seed`).

## D-005 #21 seek policy and #10 replay semantics (2026-10-02)

Decision: a seek is history-independent.

- Baseline: `locateMIDI(tick)` first restores the state that `loadMIDI` installs. That means `reset()` defaults on all 16 channels (program 0, bend range 2 semitones, modulation 0, volume 100, pan 64, expression 127, sustain off, bend centred, RPN null, channel tuning 0, scale tuning 0, rhythm only on channel 10) plus master tuning 0, and the MIDI default tempo of 120 BPM.
- It then applies, in event order, every retained state event with `t < tick` (the legacy strictness): tempo, program change, every controller the live `send()` path handles (including RPN/NRPN data entry, bend range, fine/coarse tuning, and reset-all-controllers), pitch bend, and the SysEx messages `send()` supports: master tuning, scale tuning and the GS rhythm part. `send()` has no GM/GS reset handler, so none is replayed. Wording corrected after T3. No note-on/off or other sound is produced, and there is no note chase. All sounding notes stop, as in legacy `stopMIDI()`.
- Manual overrides do not survive a seek. Channel state set by the caller (`setProgram`, `setBend`, `send()` …) is replaced by the song-derived state. Engine-level settings are not channel state and are unaffected: `masterVol`, `reverbLev`, `quality`, `voices`, `loop`, `loopEnd`, the timbre tables (including `setTimbre` custom timbres), the waveform registry (#26), and `seed`.
- Positioning keeps the legacy next-event behavior. After `locateMIDI(tick)`, playback resumes at the first retained event with `t ≥ tick`. `getPlayStatus().curTick` reports that event's tick, and `playMIDI()` schedules it at `currentTime + 0.1 s`. Any rest between `tick` and that event is not reproduced. Rationale: do not silently change audible alignment. Requested-tick positioning could later be an additive option. Seeking at or beyond the last event keeps the legacy result (`curTick = maxTick`, restart from the beginning on play). The `loopEnd` wrap timing is unchanged.
- #10: `playMIDI()` on a completed song (`curTick ≥ maxTick`) begins a new pass equivalent to `locateMIDI(0)` followed by play. Tempo returns to the song's initial tempo and channel state to the seek baseline, so a replay sounds the same as the first play after `loadMIDI`. This deliberately deviates for songs whose end state differs from their start state; songs that set their state at tick 0 are unaffected (ledger L-05).
- Unchanged: `stopMIDI()` then `playMIDI()` before completion resumes with the current state. The default loop wrap (`loopEnd = 0`) keeps the upstream-compatible behavior: channel state carries over and the tempo is not reset, which the upstream differential tests assert. The `loopEnd > 0` wrap keeps the fork's tempo reset. The documentation recommends `loopEnd` for exact looping.
- Reconsider if a caller documents a need for manual overrides to survive seeking (this could become an opt-in flag).

## D-006 #26 consumer waveform registry contract (2026-10-02)

Additive API: `setHarmonicWave(name, real, imag)` and `setSampleWave(name, samples)`. Implemented in T11 after T7/T8. Verified spec facts (Web Audio 1.0): a PeriodicWave sums harmonics from k = 1, so index 0 (DC) is ignored. Default normalization scales the peak to 1. Buffer resampling is UA-defined.

- Name grammar: `^w[A-Za-z_][A-Za-z0-9_]{0,30}$` for harmonic waves and `^n[A-Za-z_][A-Za-z0-9_]{0,30}$` for sample waves. Names whose second character is a digit are reserved for built-ins, including `w9999`, `n0` and `n1`, and future ones. Lookups must be safe against prototype keys (use `Map` or an own-property check).
- Harmonics: `real` and `imag` are equal-length arrays of finite numbers, from 2 to 257 entries (DC slot plus 1–256 harmonics). Index 0 is DC; it is accepted but ignored, and the engine forces it to 0. Default Web Audio normalization applies (peak 1), as for the built-in `w9999` and oscillator types.
- Samples: a single-cycle array of finite numbers in [−1, 1], from 2 to 1024 entries. Values outside the range are rejected, not clamped.
- Pitch basis: the existing `n*` path (`playbackRate = freq/440`, with the pitch envelope and FM scaling on the same basis) is kept. A sample wave is stored at the context sample rate SR as an exact-period loop of `L = SR/gcd(SR, 440)` frames holding `K = 440/gcd(SR, 440)` cycles (2205 frames/22 cycles at 44.1 kHz, 1200/11 at 48 kHz). That makes its fundamental exactly 440 Hz at `playbackRate` 1 for integer sample rates. Frame `j` holds `samples[floor(N · frac(j·K/L))]` (sample-and-hold). Non-integer or pathological rates must use a documented bounded fallback with at most 1 s of frames and a measured pitch error.
- Fidelity: the stored Float32 tables are deterministic for fixed inputs, SR and algorithm version, and their hashes are recorded. Rendered playback is resampled and interpolated by the browser, so exact stepped output at arbitrary pitches is not promised. Interpolation, aliasing and loop seams are documented with T6-measured tolerances. A short repeated LFSR table is a noise texture, not authentic NES noise clocking. No AudioWorklet/WASM.
- Registry: the instance owns copies of the caller's arrays as context-independent definitions. The PeriodicWave/AudioBuffer objects are built per context, eagerly on registration or context install, or lazily before the first note. They are rebuilt on context replacement and released on dispose (#11). Registering an existing name replaces it transactionally: validation happens before any mutation. Active voices keep their old object, and new notes use the new one. Bounds: at most 256 registered names. Total sample-buffer memory is bounded, and T11 measures and documents the bound.
- Unknown names: `setTimbre` rejects a timbre that references an unregistered or unknown wave (#13 validation, extended by T11). `_note` resolves every operator's wave before allocating any node, so no partial voice is possible.
- Quality: definitions survive `setQuality()` and context replacement. `setQuality()` still resets program and drum timbres to the built-ins, so custom timbres must be reinstalled after it. The consumer already documents this.
- Consumer conversion, done in the consumer page and exercised by our pinned fixture: `Harmonics` element `i` is harmonic `i+1`, so `imag = [0, h0/S, h1/S, …]`, `real` is all zeros, and S is any positive scale (normalization makes S irrelevant). `Samples` `i8` maps by `s/128` (standard signed 8-bit PCM: −128 → −1.0, 0 → 0, 127 → 0.9921875). The consumer README's "−128..=127 to −1.0..=1.0" wording needs this clarification as a consumer follow-up.
- Reconsider if T6/T11 measurements show unacceptable pitch or seam error at 44.1/48 kHz, or if the consumer needs a different prefix.

## D-007 #27 fixed operator filter contract (2026-10-02)

New optional fields on an operator whose output goes to audio (`g:0`). Implemented in T12 after T11. Verified spec facts: low-pass and high-pass use `α_QdB = sin ω0 / (2·10^(Q/20))`, so `Q` is in dB for them. Band-pass uses a linear `α_Q = sin ω0 / (2Q)`. The `frequency` AudioParam's nominal range is [0, Nyquist].

- `fl`: `"lowpass"`, `"highpass"` or `"bandpass"`. When absent, no filter node is created and the graph is identical to before.
- `fq`: conventional linear quality factor, range 0.1 to 30 (matching the consumer), default `Math.SQRT1_2`. The engine sets Web Audio `Q = 20·log10(fq)` for low-pass and high-pass, and `Q = fq` for band-pass. Tests check both conversions against an independent RBJ biquad response.
- `fk`: 0 or 1, default 0. With `fk:0`, `ff` is Hz in [20, 20000]. With `fk:1`, `ff` is a multiple from 0.25 to 16 of the tuned note-on frequency. That frequency is the `f` computed at the top of `_note`: master, channel and scale tuning included, excluding operator ratio/offset, bend, pitch envelope and modulation. For drums, `f` derives from the drum note number, so fixed Hz is documented as the normal choice. The filter stays fixed for the life of the note.
- Nyquist: the engine explicitly clamps the computed cutoff to `[10 Hz, 0.45 × sampleRate]`. This constant and its rationale are documented and tested at 44.1/48 kHz, including key-tracked high notes. The engine does not rely on implicit browser clamping. T12 may refine the constant with measured evidence via a recorded decision.
- Validation (#13 style, transactional): `ff`, `fq` or `fk` without `fl` is rejected, filter fields on a modulator (`g ≠ 0`) are rejected, and non-finite or out-of-range values are rejected. No partial state on failure.
- Routing: oscillator → `g[i]` → BiquadFilter → channel output. FM/AM modulation paths are never filtered.
- Lifecycle: the filter belongs to the voice. It is disconnected and released on melodic release/prune, voice stealing, all-sound-off, percussion `onended`, context replacement, dispose and failed allocation, using the #11 ownership tracking (percussion voices are not in `notetab`).
- Response tests replace the broad 24 dB criterion with a calibrated fixture: a declared SR, cutoff, Q, input spectrum, bands, window and normalization, compared with the expected biquad response (`getFrequencyResponse` checks plus offline renders with reverb disabled).
- Consumer conversion: `Filter.kind` maps to `fl`, `cutoff/10000` to `ff`, `key_track` to `fk`, and `q/10000` to `fq`. The ranges are equal to the consumer's.
- Reconsider if the consumer revises `Filter.q` semantics or the ranges, or if measurements justify a different Nyquist margin.

## D-008 Toolchain, runners and package ownership (2026-10-02)

- Node: pin the current Node 24 LTS patch, resolved from `https://nodejs.org/dist/index.json` at T1 time (local is 24.19.0), via `.nvmrc`/`engines`/CI. Install with `npm ci` from a committed lockfile. `package-lock.json` is currently in `.gitignore`; T1 removes that entry (#5).
- Runners: GitHub-hosted `ubuntu-24.04-arm` by default. It is already used in the org, and hosted ARM runners are free for this public repository. A job falls back to x64 only with a recorded, verified reason, for example a Playwright browser being unavailable on linux-arm64.
- One owner for `package.json`/`package-lock.json` at a time: the T1 tooling agent during T1, and later whichever agent the supervisor names. Other agents request package changes through the supervisor.
- Package contents: a `files` whitelist (library, min.js, map, types when shipped, LICENSE, NOTICE, README). `docs/improvements/**`, tests and plans are excluded (#5/#20).

## D-009 AI review configuration (2026-10-02)

- The central control surface is the organization Actions variables, already defined and visible to this repo: `CODEX_REVIEW_MODEL`, `CODEX_REVIEW_EFFORT`, `CLAUDE_REVIEW_MODEL`, `CLAUDE_REVIEW_EFFORT`. Values at kickoff are recorded in `contracts.md`; they are configuration, not secrets. There are no in-repo defaults. Missing or invalid values fail the review and the gate with a clear error. Changing a variable changes execution with no file edits.
- The organization variable `CODEX_CLI_VERSION` is currently `latest`, which #25 forbids. The Codex CLI version and the Claude action are pinned in-repo, to an exact npm version and a full commit SHA, and that org variable is not read.
- Credentials are the existing org secrets `CODEX_AUTH_DOT_JSON` and `CLAUDE_CODE_OAUTH_TOKEN`, used by name only.
- The repository is public, so fork PRs receive no secrets. The aggregate gate must fail with an explicit "AI review unavailable for fork PRs" message rather than skip, because a skipped job satisfies a required check. Draft PRs skip review intentionally, and the gate states that. Missing variables or credentials, failed runs, incomplete or malformed output, and stale heads all fail the gate.
- Structure references: Death Mountain client `ceff9d8` (primary, per #25), plus `game-token@a585c3d` and `super-death-mountain@b01b9a0`, which already consume the four variables. Every CLI flag (for example Claude `--effort` and Codex `model_reasoning_effort`) must be verified against official documentation for the pinned versions, not copied from those repositories.

## D-010 Consumer schema reconciliation after T0 (2026-10-02)

Inputs: the T0 consumer mapping (`tasks/T0.md` §7, Q1–Q16) and `onchain-tinysynth@71fce28`. Principle: the engine keeps the built-in timbre semantics. Where the consumer's documentation disagrees with measured engine behavior, the consumer corrects its documentation or validation, which is its scope. These items are listed as consumer follow-ups and appear in the T10 handoff. Engine changes happen only where an issue already requires them.

| Q | Resolution | Owner |
| --- | --- | --- |
| Q1 Harmonics | Covered by D-006. The engine takes Web Audio `real`/`imag` arrays with index 0 = DC (ignored); its 257-entry limit covers 64 harmonics. The consumer maps element `i` to `imag[i+1]` (sine phase, as `_createWave` does) and sets `real` to zeros. u16 values are relative amplitudes: default normalization makes the scale irrelevant, so raw values and /10000 are equivalent. Unsigned values cannot express alternating-sign series. The engine accepts signed values; whether to use a signed type is a consumer follow-up. | consumer |
| Q2 Samples | `s/128` (D-006). The consumer must qualify "exact sample-and-hold" to the #26 tolerance contract, because the browser interpolates buffer playback. | consumer |
| Q3 Filter Q | Linear Q with the documented dB conversion for LP/HP (D-007). | engine T12 |
| Q4 Key tracking | Tuned note-on frequency basis; explicit clamp to [10 Hz, 0.45·SR] (D-007). | engine T12 |
| Q5 Reverb % | Engine unchanged: wet gain = `reverbLev × 8`. Recommended consumer mapping: `reverbLev = reverb/100`, so its default 30 equals the engine default 0.3. "0 = off" means `setReverbLev(0)`. The consumer may use `useReverb:0` at construction to avoid the convolver, and documents its choice. T8 may skip impulse generation when reverb is unused (#18), without shifting other streams (D-004). | consumer, T8 |
| Q6 Master volume % | Engine unchanged. The consumer maps `masterVol = master_vol/100` (its default 40 → 0.4) and documents that 100 % is twice the engine default. | consumer |
| Q7 Modulator frequency | Engine unchanged: an FM/AM operator's frequency is `target_frequency × t + f`. The consumer documentation must say so. | consumer |
| Q8 Operator-0 lifetime | Engine unchanged (built-in compatibility): a melodic voice ends 3.5·r[0] after note-off, and a drum stops 3.5·d[0] after note-on. The consumer should require drum operator 0 to have `decay > 0` and document the operator-0 rule. T9 documents it in the engine README. #27 filters follow the same voice lifetime. | consumer, T9 |
| Q9 Drum slots | Confirmed: drum notes 35–81, used only on rhythm channels (channel 10 by default; GS SysEx may change them). | contract |
| Q10 Voice pruning | Engine unchanged: released notes are pruned first, and drum hits prune melodic voices. The consumer documentation must not say "the oldest note is cut". | consumer, T9 |
| Q11 d/r cap | Consumer range scope. 32 built-in timbres use d or r up to 12; the consumer may widen its caps. | consumer |
| Q12 Routes | `setTimbre` validation rejects FM/AM targets that are not earlier operators, with no partial state (#13, T5). Routes 9–10 being unreachable with at most 8 operators is a consumer range note. | engine T5, consumer |
| Q13 Determinism | Resolved by D-004: the reverb impulse, `n0` and `n1` all become deterministic by default. | engine T8 |
| Q14 Quality type | T5 defines the coercion contract under #13. Preferred: accept 0/1 and numeric strings via `Number()`, and reject anything else descriptively. T5 records the legacy `setQuality("0")` → quality 1 behavior as a ledger entry if it changes. | engine T5 |
| Q15 setTimbre references | Ledger L-09: T5 copies and normalizes timbres; caller arrays are no longer mutated. | engine T5 |
| Q16 Startup | #12 (T4): constructor context injection and an additive lazy/explicit start for tap-to-start pages. | engine T4 |

T0 also measured mangling at 35,964 / 9,199 bytes (raw / gzip), against 37,060 / 9,444 at baseline: −3.0 % raw and −2.6 % gzip. T1 evaluates enabling it under #5.

## D-011 T9A audit outcomes (2026-10-02)

Inputs: `tasks/T9A.md` §7, and the T0 embedding evidence.

1. **Gesture reconciliation, accepted.** T0's offline embedding check (`setContent`/`data:` pages under the smoke's flags) shows that the script and MIDI load and run with zero requests. It does not show normal gesture startup. At an `http://127.0.0.1` origin under the default autoplay policy the context stays `suspended` until a real gesture, and `page.evaluate` itself confers user activation. T6's #12 gesture tests must deliver a real input event (`page.click`/keyboard) before any `evaluate` touches audio, and must assert the suspended state first. README usage (T9) must start audio from a gesture (#12's `resume()`).
2. **Vendoring location: option A.** Keep the path `bower_components/webaudio-controls/webaudio-controls.js`, vendored at upstream `282610a` (byte-identical to what the demos load today, sha256 recorded in T9A), and delete the unused Polymer 1 files. This is #19 scope: the AGENTS.md "avoid unrelated edits" note does not apply to #19's own vendoring.
3. **Editor and `setTimbre`.** T5's assignment must keep the soundedit round trip working (#13 acceptance). T5 states whether unknown keys (`b`, `c`) and placeholder operators are accepted or stripped, and how the editor re-applies patches after `setQuality()`. T9 adapts the editor to that contract.
4. **Attribution in the minified build.** The user's kickoff requirement is to "preserve licensing, NOTICE, and upstream attribution", and the baseline min.js carries no attribution string. Lean: keep a short `/*! … */` attribution header in the minified output, about 150 bytes, a one-time hash change before any release. Final decision at G0 using T1's measurement.
5. **Package name and version.** `webaudio-tinysynth@1.1.4` collides with upstream on npm. This is a release and publication decision for the user and is not blocking. P1 (the fork's repository, bugs and homepage URLs) can land through the package owner.
6. **Editor scope.** No editor support for #26 waves, #27 filters or a patch-import path. Those features are documented only (#19/#20 do not require them).
7. **AGENTS.md.** It is user-owned and untracked, so it stays unmodified. T9 may add tracked contribution guidance (T9-15), and the §5 proposals go to the user at delivery.
8. **Firefox and WebKit gesture behavior** belongs to T6's matrix.

## D-012 Visible provider heading on every review comment (2026-10-02)

The user observed that PR #28's clean Claude comment showed a bare `lgtm`, with the provider and model only in hidden HTML metadata (`review_lib.render_comment`). Decision: every review comment, including a clean one, starts with a visible heading of the form "**Provider review** · model `…` · effort `…` · head `…`", rendered from the result record (no literals). This deliberately departs from the github-ci skill's "visible body only `lgtm`" convention for comments. The model-output contract is unchanged: a complete clean review's output is exactly `lgtm`, and the gate reads parsed result records, never comment text. Affects T1-ai-review (#25).

## D-013 Error and failure contract for loading and API misuse (2026-10-02)

Needed before T2 (#4/#6), and followed by T5 (#13/#14).

- **`loadMIDI(data)` failures throw.** The library throws an `Error` with a stable `code` string and a descriptive message: `SMF_INVALID_HEADER`, `SMF_UNSUPPORTED_FORMAT` (format 2 or unknown), `SMF_UNSUPPORTED_DIVISION` (SMPTE/high-bit or zero PPQ), `SMF_TRUNCATED` (data ends inside a chunk, event or variable-length quantity, or fewer chunks than declared) and `SMF_MALFORMED` (an over-long VLQ, an invalid status or data byte, a missing running status, or a bad meta or SysEx length, including tempo length ≠ 3 or tempo 0). The thrown error carries `track` (0-based index of the `MTrk` chunk; unknown chunks are not counted) and `offset` (absolute byte offset) where applicable. A meta or SysEx length that runs past the chunk end is reported as `SMF_TRUNCATED` (wording corrected after the T2 review, F4).
- **Failed loads are transactional and side-effect free.** The previous song, playback state and channel state stay as they were, and no partial event is installed. The parser builds a temporary song and installs it only after full validation. A successful load keeps today's effects: stop, install, then `locateMIDI(0)`. Since T3, `locateMIDI(0)` performs the `reset()` itself, as the seek baseline, and the WebAudio call order still matches upstream.
- **Legacy differences** are ledger L-01, L-02 and L-03:
  - Non-`MThd` input used to return silently after stopping playback; it now throws without side effects.
  - Running status is per track and cancelled by meta and SysEx events, per the SMF specification. The legacy file-wide initial `0x90` running status is removed, and T2 characterizes any valid-file impact.
  - A missing End-of-Track is accepted only when the declared chunk ends exactly on an event boundary and the chunk is followed by end of file or by another `MTrk` chunk. That track then ends at its last event's tick. This is documented recovery. Otherwise the result is `SMF_MALFORMED`; after the T2 review (F5), this catches understated lengths that land on event boundaries.
  - Unknown chunk types are skipped, as the SMF specification requires.
- **The asynchronous path wraps errors.** `loadMIDIUrl` exceptions surface through #14's promise (T5). Until T5 lands, an exception inside the XHR `onload` is an uncaught error in the console, an accepted interim state on the unreleased integration branch.
- **API misuse** (T5, #13): direct calls with invalid argument types or ranges throw `TypeError` or `RangeError` with descriptive messages, before any mutation. Malformed raw messages passed to `send()` are no-ops (#13). Useful numeric coercions are characterized and kept.
- Reconsider this if a consumer needs a non-throwing load API. An additive `tryLoadMIDI` would be the route.

## D-014 AI review hardening after the G0 review and real runs (2026-10-03)

Inputs: G0 independent review of `1eff7ba` (`g0/review` `03003e9`, `tasks/G0-review.md`) and PR #28's round-three real reviews at `848bae6` (Codex HIGH, plus a Claude review that failed closed on incomplete output).

- Credential-bearing steps must not load configuration from the PR checkout. Bun and the Claude action run from a trusted empty directory. Claude reads the checkout as data through `--add-dir`. The inherited environment is preset to trusted values. Result and gate steps verify trusted files after the credential step. A model mismatch fails. (H1, L3)
- Bootstrap (using the head's review configuration when the base has none) is allowed only for base `main`, the one-time path by which the configuration reaches `main`. Any other base without the configuration fails. (M3)
- Dependabot PRs are treated like fork PRs: the gate fails with an explicit "AI review unavailable" message. Dependabot secrets would be an org decision, reported to the user and not performed. (L6)
- The leak guard covers common encodings of the Codex credential's tokens. Split copies remain a documented residual risk. The fork message no longer advises mirroring fork content. (M2)
- A model output that is clean apart from leading prose is handled per the implementer's documented choice. The contract stays fail-closed: `lgtm` plus prose, and prose between or after findings, are never accepted.
- The native test suite must fail when zero tests run or a file exits early (M4, T1-tooling).
- Codex ChatGPT-credential rotation is an org-level prerequisite. Authentication failures name `CODEX_AUTH_DOT_JSON` explicitly.

## D-015 Required checks and credential follow-ups (2026-10-03)

- The user added the six checks to the `protect main` ruleset (id 24398919) as required status checks from GitHub Actions (integration 15368): `test`, `lint`, `build-verify`, `browser-smoke`, `Claude review gate` and `Codex review gate`, with the strict policy off.
- Finding: the ruleset's `conditions.ref_name.include` is empty, and `GET /repos/…/rules/branches/main` returns no rules. So no rule in that ruleset (required checks, signed commits, PR requirement, deletion and non-fast-forward protection) is in effect on `main`. This corrects D-002's kickoff note, which read the rules from the ruleset definition rather than from their effective application. Enforcement needs the target set to `~DEFAULT_BRANCH` (or `refs/heads/main`); that is the user's ruleset change.
- The user acknowledged the Codex ChatGPT-credential rotation risk and the Dependabot policy (AI review gates fail on Dependabot PRs without Dependabot secrets). No change is planned. Both remain documented in `.github/scripts/README.md`.
- Update (2026-10-03): the user retargeted the ruleset to `~DEFAULT_BRANCH`. `GET /rules/branches/main` now returns `deletion`, `non_fast_forward`, `required_signatures`, `pull_request` and `required_status_checks` (`test`, `lint`, `build-verify`, `browser-smoke`, `Claude review gate`, `Codex review gate`). Enforcement on `main` is verified. `improve/integration` has no rules, as intended.

## D-016 NOTICE and source-header policy (2026-10-03)

The T2 independent review (F6) and both of PR #32's AI reviews flagged that NOTICE and the source header's modification list were not updated for the parser change. The contract (contracts.md) requires NOTICE updates per modification set. The source header is kept in the minified build (T1, +347 B), so a header that enumerates changes grows the onchain artifact with every task.

Decision:
- `NOTICE` gets one bullet per modification set, added by the implementing task. NOTICE is not part of the minified build.
- The source header becomes a fixed attribution: the upstream author and URL, the Apache-2.0 line, and "Modified by Provable Games (fork URL); see NOTICE for the changes". This satisfies Apache-2.0 §4(b) ("prominent notices stating that You changed the files") without growing per task. T2 makes the change. Later tasks only add NOTICE bullets and do not touch the header.
- T9 reviews the final NOTICE and README wording (#20).

## D-017 T6 phase A as an integrated increment; upstream observations kept (2026-10-03)

- T6 phase A (the browser and rendered-audio infrastructure, plus baseline characterization; no runtime changes) is integrated once its PR passes CI, the arm64 browser matrix, and the AI review gates. T3–T5 then get browser and audio coverage as they land. Full T6 acceptance remains at G1, after the phase-B assertions (T6.md §13) are added on top of the integrated T2–T5. The G1 independent review covers all of T6.
- **Bend-range unit.** The engine converts the stored bend range with `brange*100/127` cents. MIDI's RPN 0 value is `semitones*128 + cents`, so the default 2-semitone range plays as 201.57 cents, not 200. This is upstream behavior that the differential tests assert, and no registered issue covers it. It is kept unchanged and listed as a future recommendation, since any change would be an unscoped sound change.
- **Drum peaks.** In quality 1, drums 49 and 55 peak at 1.16–1.29 at the default volume. These are upstream timbre levels, kept unchanged (no timbre redesign). The consumer's suggested `master_vol` of 40 % leaves headroom. This is listed as an observation for the consumer and in the final recommendations.
- **Offline renders.** The library's 60 ms timer prunes voices during `OfflineAudioContext` renders, so T6 tests stop it as a test control. T4 (#12: "Define supported suspended, closed, and OfflineAudioContext behavior") must define the real behavior.

## D-018 Lifecycle API contract for T4 (#11, #12) (2026-10-03)

The additions are opt-in. Default construction (`new WebAudioTinySynth()` or `new WebAudioTinySynth({quality, useReverb, voices})`) keeps today's behavior: an internally created context is installed immediately, and `ready()` works as before.

- **Constructor options:**
  - `context`: a caller-owned `BaseAudioContext`, either an `AudioContext` or an `OfflineAudioContext`. When given, no internal context is created.
  - `destination`: an `AudioNode` in that context. It defaults to `context.destination`.
  - `lazy: true`: defer creating the internal context until the first `resume()` or the first call that needs audio. This lets a tap-to-start page create the context inside the gesture.

  Invalid values throw `TypeError` before any side effect (D-013 style).
- **Ownership.** Contexts passed through `context` or `setAudioContext()` are caller-owned and are never closed by the synth. Contexts the synth creates, eagerly or lazily, are synth-owned.
- **`resume()` returns a promise.** It creates the lazy context if needed, calls `context.resume()` when the context is suspended, and resolves once the context is running.
  - It rejects observably: with the underlying error, or with an `Error` whose `code` is `AUDIO_CONTEXT_CLOSED` for a closed context.
  - For an `OfflineAudioContext` it resolves without action.
  - The internal `resume()` call in `send()` must never produce an unhandled rejection.
- **`dispose()` returns a promise and is idempotent.** Repeated calls return the same promise. It:
  - clears every instance timer (the scheduler interval, and `ready()` polling)
  - stops every owned source: melodic voices, percussion voices, the LFO and the warm-up note
  - detaches `onended` callbacks, disconnects graph and modulation routes, and releases references
  - aborts or invalidates pending work; T5's `loadMIDIUrl` promise must reject or settle on dispose
  - closes the context only if the synth owns it, and resolves after that close

  After `dispose()` the instance is terminal. Public methods are documented, safe no-ops that never throw from a timer, and `ready()` resolves. T4 documents the exact behavior of each method.
- **`setAudioContext(ctx, dest)`.** Tear down the previous graph before installing the new one, closing the previous context only if the synth owns it. The new context is caller-owned.
- **OfflineAudioContext.** Direct note scheduling with explicit times is supported and must not be pruned prematurely by the realtime timer (T6 observation, D-017). Realtime MIDI sequencing (`playMIDI`) on an offline context is defined and documented by T4: either a supported mode or an explicit `Error`, chosen with evidence.
- **Cleanup evidence** comes from T6's browser instrumentation (`tests/browser/page/instrument.js`), not from the mock alone. The mock's `stop()` does not simulate node completion.

## D-019 T3 transport refinements (2026-10-03)

- #8: a pass wraps only if `loopEnd > 0` or the last retained event's tick is later than the first's. A song whose events all share one tick T > 0 with 0 < `loopEnd` ≤ T keeps looping, because each pass advances T ticks of leading time. Otherwise a non-advancing song plays once and stops with `{play:0, curTick:maxTick}`. Each timer callback handles at most 1000 events, and the rest continue in order on later callbacks.
- #9: if a song has no retained events other than tempo, `playMIDI()` does nothing: no node is created and the status is unchanged.
- Deliberate extension within the D-005 seek baseline: scale tuning is cleared on every load and seek.
- A seek cancels queued channel-controller automation from the current time on every seek except the internal `locateMIDI(0)` inside `loadMIDI`, and then applies the reconstructed state. This covers caller-scheduled `send(msg, futureTime)` and timed setters, as D-005 requires, because manual overrides do not survive a seek. The `queued` bookkeeping is dropped (T3 review F3). Loads stay trace-identical to upstream, which the differential test pins. Seeks are deliberately not trace-identical to upstream (#21), so the earlier wording claiming so was wrong.
- Replay of a completed song (#10) reconstructs tempo and channel state, and cancels queued automation, exactly as `locateMIDI(0)` does. It does **not** silence notes still sounding or already scheduled from the previous pass, matching upstream audio continuity. Before this change, a replay right after the status flipped to stopped dropped the previous pass's last notes (T3 review F4). This supersedes the earlier "replay cuts release tails" extension.
- Accepted residuals (documented in T3.md): channel automation queued before a load can still fire into the new song. This is upstream behavior on the load path (F5), and changing it would break load-trace identity. Untrusted looping MIDI with sub-microsecond passes causes sustained CPU and garbage audio, but each callback is bounded and the page stays responsive (F6).
- Deferred: validation of negative and non-finite `loopEnd` goes to T5 (#13, F8). One `resume()` call per seek event through `send()` goes to T4 (F9).
- Known, for T4: percussion hits already scheduled in the lookahead window are not in `notetab`, so `stopMIDI` and seek do not stop them. T4's percussion voice tracking must stop scheduled percussion on stop, seek and dispose.

## D-020 Agents respond to their own PR comments (2026-10-03)

At the user's request ("instruct all subagents responsible for an open PR to review comments and respond appropriately"), task agents may now push fast-forward commits to their own task branch and post replies on their own PR. They decide accept or reject for every review comment on the evidence, fix the accepted findings with tests, and reply to each with "fixed" plus the commit SHA and how it was verified, or "not changed" plus the reason. They handle at most one more round after the re-run, then report to the supervisor. Still excluded: force-pushes, pushes to other branches, merging, closing, approving, editing PR metadata, and touching other PRs. Integration into `improve/integration` stays with the supervisor. Owners: #33 is T6, #34 is T3, and #31's findings (umbrella, supervisor-owned) go to the T1-tooling agent via `fix/umbrella-review`.
- Addendum (2026-10-03), from the review of umbrella PR #31: a task that changes public behavior also adds one concise bullet to the README's "What behaves differently" list, alongside its NOTICE bullet (D-016). The README loadMIDI note landed in #35, together with replacing `engines` by a warn-only `devEngines` so consumer installs are not restricted. T3's branch predates that README section, so the supervisor adds the T3 bullet at integration. T9 does the full documentation pass.
- Final T3 acceptance (2026-10-03, review 0cf4495): F3 and F4 are fixed. F11 (no test for a later seek stopping the old notes after a replay) goes to T6 phase B. F12 is accepted as a residual: on replay, a song whose last note is fading out has its channel volume reset at replay time, so that note briefly sounds at full volume. Future recommendation: apply the reconstructed state at the new pass's start time.

## D-021 #26 storage superseded by the issue owner's decision: one cycle per wave with its own home pitch (2026-10-03)

Source: the #26 comment by the issue owner (id 5965255502, 2026-10-03T03:50:58Z; snapshot in `_evidence/issues/updates/`). It supersedes D-006's exact-period 440 Hz loop for sample waves:

- `setSampleWave(name, samples)` stores exactly one cycle, the table itself with no expansion or resampling, as an `AudioBuffer` at the context's sample rate. It records the wave's home pitch, `base = sampleRate / samples.length`.
- In `_note`, every place a buffer operator uses the fixed 440 Hz basis uses that buffer's own `base` instead: the initial `playbackRate = fp / base`, the pitch envelope target `fp / base * p`, and FM depth scaling on `playbackRate` (`sc = fp / base`). Built-in `n0` and `n1` keep `base = 440`, so their behavior is unchanged.
- Tests: a 64-step 4-bit triangle at A4 measures 440 Hz within 1 cent, with equal step widths of `sampleRate / (440 × 64)` frames, ±1 frame from resampling. 93- and 256-sample tables play at the right pitch. A pitch envelope reaches the expected target, for example `p:0.28` from 160 Hz. FM on a sample-wave operator gives the same depth in cents as on an oscillator. `n0`/`n1` and every built-in render identically to before.
- Out of scope: long-mode LFSR noise (32,767 steps exceeds the 256-sample cap), so Beasts uses the deterministic built-in noise from #7.
- Everything else in D-006 stands: the API names, name grammar and reserved names, harmonic conversion and normalization, input validation, registry ownership and bounds, survival across `setQuality()` and context replacement, unknown-name rejection, and the tolerance-based fidelity statement. The sample-count cap follows the issue (2–256 consumer samples). The engine's 1024 limit from D-006 remains acceptable unless T11 finds a reason to lower it.
- Consumer schema change noted in its README: `SynthSettings.waves: Span<WaveDef>` with `Waveform::Custom(u8)`, a shared wave table registered once per entry. T11 and T12 must re-read the consumer at its then-current HEAD (`45169ea` or later; 71fce28 was the kickoff pin) and refresh the pinned consumer fixture.

## D-022 Keep the plan order and process (2026-10-03)

The consumer (onchain-tinysynth) is blocked on #7, #26, #27 and a tagged release. The supervisor estimated about 30–40 h of agent wall-clock time to umbrella PR #31 on the plan order, against about 12–16 h for a consumer fast-track (#7, #26, #27 right after T4). It also described the leaner scope and process options. The user chose to "stay the course for now": the plan order (T4 → T5 → T6-B → G1 → T7 → T8 → T11 → T12 → T9/T1B → T10 → G2) and the current review process are unchanged. Revisit this if the user asks to fast-track or slim the scope.
