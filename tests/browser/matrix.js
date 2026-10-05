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
  // Math.random seed for the test pages (tests/browser/page/prelude.js); --seed overrides it.
  seed: 0x5eed0001,
  // Seconds. A case still running at its deadline fails and its page is closed;
  // a worker (one engine) still running at engineDeadline is killed with its process group.
  caseDeadline: 60,
  engineDeadline: 1200,
  // What each spec covers. "assert" specs fail the run on any failed check;
  // "observe" specs record baseline behavior (JSON) and fail only if the
  // observation itself cannot be made. Observe-only specs run with --observe.
  specs: {
    embed: { kind: "assert", dims: ["build", "quality"], about: "inline script and MIDI, network blocked (setContent and data: URL), zero requests" },
    render: { kind: "assert", dims: ["build", "quality", "sampleRate"], about: "OfflineAudioContext renders: pitch, tuning, controllers, envelope, sustain, silence, finite samples, reverb, GM programs and drums, source/min parity, same-seed repeatability" },
    gesture: { kind: "assert", dims: ["build"], about: "default autoplay policy at an http origin: suspended before a real click/key, running and advancing after it (other start paths observed)" },
    url: { kind: "assert", dims: ["build"], about: "loadMIDIUrl against the controlled server: success asserted; non-200, network failure, malformed bytes and races observed (phase A; the #14 contract is asserted by api-url)" },
    lifecycle: { kind: "assert", dims: ["build"], about: "instrumentation self-check asserted; baseline graph, source and timer lifecycle observed" },
    dispose: { kind: "assert", dims: ["build"], about: "T4 (#11): dispose() and setAudioContext() cleanup on real nodes: timers, sources, connections, ownership, pending loads, cycles; stopMIDI() silence (D-023)" },
    start: { kind: "assert", dims: ["build"], about: "T4 (#12): default autoplay policy, real input: lazy and injected contexts start from resume(), the README path, observable rejections" },
    offline: { kind: "assert", dims: ["build"], about: "T4 (#12): OfflineAudioContext contract: repeatable renders with the timer running, playMIDI() throws, injected destination routing" },
    waves: { kind: "assert", dims: ["build", "quality", "sampleRate"], about: "T11 (#26): setSampleWave/setHarmonicWave offline renders: held tables, pitch, steps and edges, pitch envelope, FM, harmonics, registry lifecycle, consumer fixture" },
    parser: { kind: "assert", dims: ["build"], about: "#4/#6 (T2): truncated, malformed and unsupported files throw their D-013 code within an external deadline, keeping the previous song, playback and channel state; documented End-of-Track recovery; truncated URL response" },
    transport: { kind: "assert", dims: ["build"], about: "#8/#9/#10 (T3, D-019, F11) in a realtime context's instrumented graph: zero-duration loops play once, padded loopEnd loops, silent songs stay stopped, replay timing equals the tempo map, a replay keeps and a later seek stops the previous pass's notes" },
    seek: { kind: "assert", dims: ["build"], about: "#21 (T3, D-005, D-019): a seek reconstructs the song's state and is history-independent: after a completed play with manual overrides and caller-scheduled automation, and while playing with queued automation" },
    seed: { kind: "assert", dims: ["build", "quality", "sampleRate"], about: "T8 (#7, D-004): seeded convBuf/n0/n1 hashes per sample rate against tests/browser/specs/seed-expected.js, across loads, and pairwise different across seeds; the library never calls Math.random; same-seed renders repeat, other seeds differ" },
    "api-url": { kind: "assert", dims: ["build"], about: "T5 (#14): loadMIDIUrl() promise: success (installed when it resolves), status policy, malformed bytes, network failures, cancellation, races, dispose, fire-and-forget" },
    "short-notes": { kind: "assert", dims: ["build"], about: "T13 (#59, D-039): notes released before an attack ends: every program sounds while held at 0.025-0.3 s in both qualities and its hold is the uncut attack; each operator releases from its own ramp value; zero-length notes play their release; the suspend() lookahead emulation (Chromium, WebKit); completed attacks render as with upstream's release" },
    hang: { kind: "observe", dims: ["build"], about: "external deadlines on real hangs (#4 truncated file, #8 zero-duration loop)" },
    variation: { kind: "observe", dims: [], about: "source build: run-to-run variation across launches and seeds, scheduler effect, generated buffer hashes (tolerance evidence)" },
    filters: { kind: "assert", dims: ["build", "sampleRate"], about: "T12 (#27): fixed operator filters: getFrequencyResponse and rendered tone probes against an independent RBJ biquad (Q in dB and linear, key tracking, the 0.45 x SR clamp, drums), the consumer fixture's band energies, and release of every filter connection on the instrumented graph (steals, drums, stopMIDI, all-sound-off, replacement, dispose)" },
  },
};

module.exports = { MATRIX };
