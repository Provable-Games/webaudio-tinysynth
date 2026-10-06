/*
 * The declared browser matrix (#16). This is the only place that lists the
 * engines, builds, quality modes, sample rates, specs and deadlines; the
 * runner (scripts/browser-matrix.js) prints it with the results.
 *
 * Every engine listed here must launch. A missing browser or system library
 * fails the run; no engine, build or spec is ever skipped silently.
 */
"use strict";

const MATRIX = {
  engines: ["chromium", "firefox", "webkit"],
  builds: ["source", "min"],
  qualities: [0, 1],
  sampleRates: [44100, 48000],
  shards: 3,
  // Math.random seed for the test pages (tests/browser/page/prelude.js); --seed overrides it.
  seed: 0x5eed0001,
  // Seconds. A case still running at its deadline fails and its page is closed;
  // a worker (one engine) still running at engineDeadline is killed with its process group.
  caseDeadline: 60,
  engineDeadline: 1200,
  // What each spec covers. "assert" specs fail the run on any failed check;
  // "observe" specs record baseline behavior (JSON) and fail only if the
  // observation itself cannot be made. Observe-only specs run with --observe.
  // seconds: the spec's measured duration in CI, used only to balance the
  // shards (--shard=K/N in scripts/browser-matrix.js). Every spec needs one.
  // Measured: Browser matrix run 37273741105 (28fba52, ubuntu-24.04-arm), the
  // slowest engine's time from the spec's first case to the next spec's,
  // rounded up. The "browser matrix" job's summary prints current times.
  specs: {
    embed: { seconds: 15, kind: "assert", dims: ["build", "quality"], about: "inline script and MIDI, network blocked (setContent and data: URL), zero requests" },
    render: { seconds: 346, kind: "assert", dims: ["build", "quality", "sampleRate"], about: "OfflineAudioContext renders: pitch, tuning, controllers, envelope, sustain, silence, finite samples, reverb, GM programs and drums, source/min parity, same-seed repeatability" },
    gesture: { seconds: 26, kind: "assert", dims: ["build"], about: "default autoplay policy at an http origin: suspended before a real click/key, running and advancing after it (other start paths observed)" },
    url: { seconds: 10, kind: "assert", dims: ["build"], about: "loadMIDIUrl against the controlled server: success asserted; non-200, network failure, malformed bytes and races observed (phase A; the #14 contract is asserted by api-url)" },
    lifecycle: { seconds: 14, kind: "assert", dims: ["build"], about: "instrumentation self-check asserted; baseline graph, source and timer lifecycle observed" },
    dispose: { seconds: 32, kind: "assert", dims: ["build"], about: "T4 (#11): dispose() and setAudioContext() cleanup on real nodes: timers, sources, connections, ownership, pending loads, cycles; stopMIDI() silence (D-023)" },
    start: { seconds: 30, kind: "assert", dims: ["build"], about: "T4 (#12): default autoplay policy, real input: lazy and injected contexts start from resume(), the README path, observable rejections" },
    offline: { seconds: 37, kind: "assert", dims: ["build"], about: "T4 (#12): OfflineAudioContext contract: repeatable renders with the timer running, playMIDI() throws, injected destination routing" },
    waves: { seconds: 37, kind: "assert", dims: ["build", "quality", "sampleRate"], about: "T11 (#26): setSampleWave/setHarmonicWave offline renders: held tables, pitch, steps and edges, pitch envelope, FM, harmonics, registry lifecycle, consumer fixture" },
    parser: { seconds: 16, kind: "assert", dims: ["build"], about: "#4/#6 (T2): truncated, malformed and unsupported files throw their D-013 code within an external deadline, keeping the previous song, playback and channel state; documented End-of-Track recovery; truncated URL response" },
    transport: { seconds: 72, kind: "assert", dims: ["build"], about: "#8/#9/#10 (T3, D-019, F11) in a realtime context's instrumented graph: zero-duration loops play once, padded loopEnd loops, silent songs stay stopped, replay timing equals the tempo map, a replay keeps and a later seek stops the previous pass's notes" },
    seek: { seconds: 22, kind: "assert", dims: ["build"], about: "#21 (T3, D-005, D-019): a seek reconstructs the song's state and is history-independent: after a completed play with manual overrides and caller-scheduled automation, and while playing with queued automation" },
    seed: { seconds: 26, kind: "assert", dims: ["build", "quality", "sampleRate"], about: "T8 (#7, D-004): seeded convBuf/n0/n1 hashes per sample rate against tests/browser/specs/seed-expected.js, across loads, and pairwise different across seeds; the library never calls Math.random; same-seed renders repeat, other seeds differ" },
    "api-url": { seconds: 10, kind: "assert", dims: ["build"], about: "T5 (#14): loadMIDIUrl() promise: success (installed when it resolves), status policy, malformed bytes, network failures, cancellation, races, dispose, fire-and-forget" },
    "short-notes": { seconds: 169, kind: "assert", dims: ["build"], about: "T13 (#59, D-039): notes released before an attack ends: every program sounds while held at 0.025-0.3 s in both qualities and its hold is the uncut attack; each operator releases from its own ramp value; zero-length notes play their release; the suspend() lookahead emulation (Chromium, WebKit); completed attacks render as with upstream's release" },
    hang: { seconds: 7, kind: "observe", dims: ["build"], about: "external deadlines on real hangs (#4 truncated file, #8 zero-duration loop)" },
    variation: { seconds: 282, kind: "observe", dims: [], about: "source build: run-to-run variation across launches and seeds, scheduler effect, generated buffer hashes (tolerance evidence)" },
    filters: { seconds: 21, kind: "assert", dims: ["build", "sampleRate"], about: "T12 (#27): fixed operator filters: getFrequencyResponse and rendered tone probes against an independent RBJ biquad (Q in dB and linear, key tracking, the 0.45 x SR clamp, drums), the consumer fixture's band energies, and release of every filter connection on the instrumented graph (steals, drums, stopMIDI, all-sound-off, replacement, dispose)" },
    "full-mix": { seconds: 50, kind: "assert", dims: ["build", "sampleRate"], about: "#79: first-attempt cold full-song fixtures, independently matched native voice creation, raw stereo Float32/headroom, fixed-target mixed-bus downbeat band and isolated patch-aware pitch/envelope, engine-specific measured references, no-alignment source/min tolerance; fixture-only evidence" },
  },
};

module.exports = { MATRIX };
