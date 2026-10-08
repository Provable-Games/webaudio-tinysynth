/*
 * The first-attempt policy for rendered audio (#78, tests/browser/lib/first-attempt.js and the
 * browser specs built on it). A bad first result followed by a clean re-render must still fail:
 * a finite transient, a missing or quiet note, a non-finite sample and an intermittent
 * source/min mismatch, injected into the first attempt only. The re-renders are kept as
 * diagnostics: counted exactly, recorded apart from the verdict. The specs run against a scripted
 * page here (no browser); the same faults go through real engines with
 * TINYSYNTH_INJECT_FIRST_ATTEMPT_FAULT (tasks/T13.1.md).
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const FA = require("../browser/lib/first-attempt");
const renderSpec = require("../browser/specs/render");
const shortNotes = require("../browser/specs/short-notes");

const tol = { audiblePeak: 2e-4, follow: 2e-4 };
const clean = { D: 0.025, hold: 0.1, diff: 0, peak: 0.2, nf: 0 };
const NATIVE_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/* ------------------------------------------------------------------ the pure policy */

test("judgeHeld: each musical fault fails; a clean result passes", () => {
  assert.equal(FA.judgeHeld(clean, tol).ok, true);
  assert.deepEqual(FA.judgeHeld(FA.corruptSummary("quiet", clean), tol).ok, false);
  assert.match(FA.judgeHeld(FA.corruptSummary("quiet", clean), tol).reasons.join(), /too quiet/);
  assert.match(FA.judgeHeld(FA.corruptSummary("transient", clean), tol).reasons.join(), /differs from the uncut note/);
  assert.match(FA.judgeHeld(FA.corruptSummary("nonfinite", clean), tol).reasons.join(), /non-finite/);
  assert.equal(FA.judgeHeld({ D: 1, hold: NaN, diff: 0, peak: 1, nf: 0 }, tol).ok, false);
  assert.equal(FA.judgeHeld({ D: 1, hold: 1, diff: NaN, peak: 1, nf: 0 }, tol).ok, false);
});

test("judgeCompleted: a transient or a non-finite sample fails; the tolerance is not widened", () => {
  assert.equal(FA.judgeCompleted({ diff: 0, nf: 0 }, 1e-6).ok, true);
  assert.equal(FA.judgeCompleted({ diff: 1e-6, nf: 0 }, 1e-6).ok, true);
  assert.equal(FA.judgeCompleted({ diff: 1.1e-6, nf: 0 }, 1e-6).ok, false);
  assert.equal(FA.judgeCompleted({ diff: 0.5, nf: 0 }, 5e-4).ok, false);
  assert.equal(FA.judgeCompleted({ diff: 0, nf: 1 }, 5e-4).ok, false);
});

const render = (v) => ({ channels: [Float32Array.from(v), Float32Array.from(v)], whole: { nan: 0, inf: 0 } });
const wave = Array.from({ length: 4000 }, (_, i) => 0.3 * Math.sin(i / 7));

function float32FromBits(bits) {
  const bytes = new ArrayBuffer(bits.length * 4);
  const view = new DataView(bytes);
  bits.forEach((value, i) => view.setUint32(i * 4, value, NATIVE_LITTLE_ENDIAN));
  return new Float32Array(bytes);
}

function readTempFloatWav(file) {
  const wav = fs.readFileSync(file);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(20), 3, "IEEE float WAV");
  assert.equal(wav.readUInt16LE(34), 32, "32-bit samples");
  const channels = wav.readUInt16LE(22), sampleRate = wav.readUInt32LE(24), dataBytes = wav.readUInt32LE(40);
  assert.equal(dataBytes, wav.length - 44);
  assert.equal(dataBytes % (channels * 4), 0);
  return { wav, channels, frames: dataBytes / (channels * 4), sampleRate, data: wav.subarray(44) };
}

function interleavedBits(channels) {
  const bytes = Buffer.alloc(channels[0].length * channels.length * 4);
  let offset = 0;
  for (let frame = 0; frame < channels[0].length; ++frame) {
    for (const channel of channels) {
      const sample = new Uint8Array(channel.buffer, channel.byteOffset + frame * 4, 4);
      for (let byte = 0; byte < 4; ++byte) bytes[offset + byte] = sample[NATIVE_LITTLE_ENDIAN ? byte : 3 - byte];
      offset += 4;
    }
  }
  return bytes;
}

function planarBitsFromWav(wav) {
  const bytes = Buffer.alloc(wav.data.length);
  for (let channel = 0; channel < wav.channels; ++channel) {
    for (let frame = 0; frame < wav.frames; ++frame) {
      const source = (frame * wav.channels + channel) * 4;
      const target = (channel * wav.frames + frame) * 4;
      wav.data.copy(bytes, target, source, source + 4);
    }
  }
  return bytes;
}

function tempSaveHarness() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "tinysynth-first-pcm-"));
  return {
    out,
    save(rel, data) {
      const file = path.join(out, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
      return file;
    },
    clean() { fs.rmSync(out, { recursive: true, force: true }); },
  };
}

test("compareRenders: identical, summation order (within the measured tolerance) and mismatch are separate", () => {
  const a = render(wave);
  assert.equal(FA.compareRenders(a, render(wave), 5e-4).category, "identical");
  const near = render(wave.map((x, i) => (i === 10 ? x + 4e-4 : x)));
  const c = FA.compareRenders(a, near, 5e-4);
  assert.equal(c.category, "summation");
  assert.equal(c.ok, true);
  const far = FA.compareRenders(a, render(wave.map((x, i) => (i === 10 ? x + 6e-4 : x))), 5e-4);
  assert.equal(far.category, "mismatch");
  assert.equal(far.ok, false);
  assert.equal(far.firstDifferingSample, 10);
});

test("compareRenders: every injected fault is a mismatch, the NaN one included", () => {
  const a = render(wave);
  for (const kind of ["transient", "quiet", "nonfinite"]) {
    const c = FA.compareRenders(a, FA.corruptRender(kind, a), 1e-6);
    assert.equal(c.ok, false, kind);
  }
  assert.equal(FA.corruptRender("nonfinite", a).whole.nan, 1);
  assert.equal(FA.compareRenders(a, render(wave.slice(1)), 1).ok, false); // a different length
});

for (const kind of ["transient", "quiet", "nonfinite"]) {
  test("comparePair: a " + kind + " in the first source/min pair fails although the re-render is clean", async () => {
    const min = render(wave), source = render(wave);
    const budget = FA.makeBudget(3), seen = [];
    let reruns = 0;
    const res = await FA.comparePair({
      a: FA.corruptRender(kind, source), b: min, tolerance: 5e-4, budget,
      rerenderA: async () => { ++reruns; return source; }, rerenderB: async () => { ++reruns; return min; },
      onDiagnostic: (r) => { seen.push(r); return r; },
    });
    assert.equal(res.ok, false, "the first attempt decides");
    assert.equal(res.outcome, FA.OUTCOMES.INTERMITTENT);
    assert.equal(res.attempts, 2);
    assert.equal(reruns, 2); // one re-render of each side
    assert.equal(seen.length, 2);
    assert.deepEqual(res.diagnostics.map((d) => [d.attempt, d.ok]), [[2, true]]);
    assert.ok(res.diagnostics[0].info.newAvsFirstB === 0, "the retried source agrees with the first min: the first source was the bad render");
    assert.ok(res.diagnostics[0].info.firstAvsNewB > 0);
    assert.equal(budget.left, 2);
  });
}

test("comparePair: a glitch in the first reference render is intermittent when both sides are re-rendered", async () => {
  const good = render(wave);
  const res = await FA.comparePair({ a: good, b: FA.corruptRender("transient", good), tolerance: 5e-4, budget: FA.makeBudget(1), rerenderA: async () => good, rerenderB: async () => good });
  assert.equal(res.ok, false);
  assert.equal(res.outcome, FA.OUTCOMES.INTERMITTENT);
  assert.equal(res.diagnostics[0].info.newAvsFirstB > 0, true, "the retried repeat disagrees with the first reference: the reference was the bad render");
  assert.equal(res.diagnostics[0].info.firstAvsNewB, 0);
  // With only the repeat side retried, the retained faulty reference makes the same glitch look reproduced.
  const one = await FA.comparePair({ a: good, b: FA.corruptRender("transient", good), tolerance: 5e-4, budget: FA.makeBudget(1), rerenderA: async () => good, rerenderB: null });
  assert.equal(one.outcome, FA.OUTCOMES.REPRODUCED);
});

test("comparePair: within the summation tolerance there is no failure and no re-render", async () => {
  let reruns = 0;
  const res = await FA.comparePair({ a: render(wave), b: render(wave.map((x, i) => (i === 3 ? x + 1e-4 : x))), tolerance: 5e-4, budget: FA.makeBudget(1), rerenderA: async () => { ++reruns; } });
  assert.deepEqual([res.ok, res.attempts, reruns], [true, 1, 0]);
});

test("comparePair: first PCM retention saves the actual mono/stereo first pair before a clean diagnostic", async () => {
  const io = tempSaveHarness();
  try {
    const firstA = { channels: [float32FromBits([0x3f800000, 0x7fc12345, 0x7f800000, 0xff800000, 0x00000001])] };
    const firstB = { channels: [
      float32FromBits([0x3f800000, 0x7fc54321, 0x7f800000, 0xff800000, 0x00000001]),
      float32FromBits([0xbf000000, 0x80000000, 0x00000000, 0x7f800000, 0xff800000]),
    ] };
    const diagnostic = { channels: [Float32Array.from(wave.slice(0, 5)), Float32Array.from(wave.slice(0, 5), (x) => -x)] };
    const retainer = renderSpec.createFirstPcmRetainer(io, { quality: 1, sampleRate: 44100 });
    const events = [];
    let retained;
    const result = await FA.comparePair({
      a: firstA, b: firstB, tolerance: 0, budget: FA.makeBudget(1),
      onFirstFailure: async (first) => {
        events.push("retain-start");
        assert.strictEqual(first.a, firstA);
        assert.strictEqual(first.b, firstB);
        retained = retainer({ ...first, label: "reverb source/min", roles: { a: "source", b: "min" } });
        await Promise.resolve();
        events.push("retain-complete");
        return retained;
      },
      rerenderA: async () => {
        events.push("rerender-a");
        assert.ok(retained.saved, "both first renders must be written before diagnostics start");
        return diagnostic;
      },
      rerenderB: async () => { events.push("rerender-b"); return diagnostic; },
    });
    assert.deepEqual(events, ["retain-start", "retain-complete", "rerender-a", "rerender-b"]);
    assert.equal(result.ok, false, "a clean diagnostic does not change the first verdict");
    assert.equal(result.outcome, FA.OUTCOMES.INTERMITTENT);
    assert.equal(result.attempts, 2);
    assert.equal(result.firstFailure, retained);
    assert.equal(retained.status, "saved");
    assert.equal(retained.saved, true);
    assert.deepEqual(retained.roles, { a: "source", b: "min" });
    assert.match(retained.a.path, /^first-attempt-pcm\/q1-44100\/pair-001-first-a\.wav$/);
    assert.match(retained.b.path, /^first-attempt-pcm\/q1-44100\/pair-001-first-b\.wav$/);

    const wavA = readTempFloatWav(path.join(io.out, retained.a.path));
    const wavB = readTempFloatWav(path.join(io.out, retained.b.path));
    assert.deepEqual([wavA.channels, wavA.frames, wavA.sampleRate], [1, 5, 44100], "L-only PCM remains mono");
    assert.deepEqual([wavB.channels, wavB.frames, wavB.sampleRate], [2, 5, 44100]);
    assert.deepEqual(wavA.data, interleavedBits(firstA.channels),
      "the saved mono WAV retains the exact original Float32 bits, including NaN payload and infinities");
    assert.deepEqual(wavB.data, interleavedBits(firstB.channels), "stereo samples retain their original interleaved Float32 bits");
    for (const [side, wav, pcm] of [[retained.a, wavA, firstA.channels], [retained.b, wavB, firstB.channels]]) {
      assert.equal(side.channels, pcm.length);
      assert.equal(side.frames, 5);
      assert.equal(side.pcmBytes, 5 * pcm.length * 4);
      assert.equal(side.wavBytes, wav.wav.length);
      assert.equal(side.wavSha256, crypto.createHash("sha256").update(wav.wav).digest("hex"));
      assert.equal(side.planarPcmSha256, crypto.createHash("sha256").update(planarBitsFromWav(wav)).digest("hex"));
      assert.equal(retained.planarPcmEncoding, "IEEE-754 binary32 little-endian; planar channel order");
      assert.equal(side.saved, true);
    }
    const log = FA.createLog(FA.makeBudget(1));
    log.add("reverb source/min", result);
    assert.equal(log.summary().failures[0].firstAttempt.pcmRetention.pairIndex, 1);
    assert.equal(log.summary().failures[0].firstAttempt.pcmRetention.a.wavSha256, retained.a.wavSha256);
  } finally {
    io.clean();
  }
});

test("comparePair: first PCM retention works with no rerender budget and reports its cap", async () => {
  const io = tempSaveHarness();
  try {
    const good = render(wave.slice(0, 8));
    const retainer = renderSpec.createFirstPcmRetainer(io, { quality: 0, sampleRate: 48000 });
    const metadata = [];
    let rerenders = 0;
    for (let i = 0; i < 7; ++i) {
      const result = await FA.comparePair({
        a: FA.corruptRender("transient", good, 2), b: good, tolerance: 1e-6,
        budget: FA.makeBudget(0),
        onFirstFailure: (first) => {
          const item = retainer({ ...first, label: "case " + i, roles: { a: "repeat", b: "kept source" } });
          metadata.push(item);
          return item;
        },
        rerenderA: async () => { ++rerenders; return good; },
        rerenderB: async () => { ++rerenders; return good; },
      });
      assert.equal(result.ok, false);
      assert.equal(result.outcome, FA.OUTCOMES.NOT_RERENDERED);
      assert.equal(result.attempts, 1);
    }
    assert.equal(rerenders, 0, "retention still runs when diagnostic re-render budget is empty");
    assert.equal(metadata.length, 7, "each first mismatch is captured once");
    assert.ok(metadata.slice(0, 6).every((pair) => pair.saved && pair.status === "saved"));
    assert.deepEqual(metadata[6].roles, { a: "repeat", b: "kept source" });
    assert.equal(metadata[6].saved, false);
    assert.equal(metadata[6].status, "budget-exhausted");
    assert.match(metadata[6].reason, /budget exhausted/);
    assert.equal(fs.existsSync(path.join(io.out, metadata[6].a.path)), false);
    assert.equal(fs.readdirSync(path.join(io.out, "first-attempt-pcm", "q0-48000")).length, 12,
      "the six-pair cap bounds output to twelve WAVs");
  } finally {
    io.clean();
  }
});

test("comparePair: clean first comparisons retain no PCM and output-disabled failures are never marked saved", async () => {
  const io = tempSaveHarness();
  try {
    const good = render(wave.slice(0, 8));
    const retainer = renderSpec.createFirstPcmRetainer(io, { quality: 1, sampleRate: 44100 });
    let callbacks = 0;
    const cleanResult = await FA.comparePair({
      a: good, b: render(wave.slice(0, 8)), tolerance: 0, budget: FA.makeBudget(1),
      onFirstFailure: (first) => { ++callbacks; return retainer({ ...first, label: "clean", roles: { a: "source", b: "min" } }); },
    });
    assert.equal(cleanResult.ok, true);
    assert.equal(callbacks, 0);
    assert.equal(fs.existsSync(path.join(io.out, "first-attempt-pcm")), false);

    let writes = 0;
    const noOutput = { save() { ++writes; return "/must-not-exist.wav"; } };
    const noOutputRetainer = renderSpec.createFirstPcmRetainer(noOutput, { quality: 1, sampleRate: 44100 });
    const failed = await FA.comparePair({
      a: FA.corruptRender("transient", good, 1), b: good, tolerance: 1e-6, budget: FA.makeBudget(0),
      onFirstFailure: (first) => noOutputRetainer({ ...first, label: "no output", roles: { a: "source", b: "min" } }),
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.firstFailure.status, "output-disabled");
    assert.equal(failed.firstFailure.saved, false);
    assert.equal(failed.firstFailure.a.saved, false);
    assert.equal(failed.firstFailure.a.wavSha256, null);
    assert.equal(writes, 0, "without t.out, the retainer does not call save or fabricate a file");
  } finally {
    io.clean();
  }
});

test("comparePair: a diagnostic failure does not invoke the first-failure callback again", async () => {
  const first = render(wave.slice(0, 16));
  const bad = FA.corruptRender("transient", first, 2);
  let captures = 0, rerenders = 0;
  const result = await FA.comparePair({
    a: bad, b: first, tolerance: 1e-6, budget: FA.makeBudget(1), retries: 2,
    onFirstFailure: () => { ++captures; return { status: "captured", saved: true }; },
    rerenderA: async () => { ++rerenders; return bad; },
    rerenderB: async () => { ++rerenders; return first; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, FA.OUTCOMES.REPRODUCED);
  assert.equal(result.attempts, 3);
  assert.equal(rerenders, 4);
  assert.equal(captures, 1);
});

test("comparePair: a retention callback error is recorded without replacing the first failure", async () => {
  const first = render(wave.slice(0, 16));
  const result = await FA.comparePair({
    a: FA.corruptRender("transient", first, 2), b: first, tolerance: 1e-6,
    budget: FA.makeBudget(0), onFirstFailure: () => { throw new Error("disk full"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, FA.OUTCOMES.NOT_RERENDERED);
  assert.deepEqual(result.firstFailure, { status: "capture-error", saved: false, reason: "disk full" });
});

test("attempts: a failure that reproduces is reported as reproduced, with every attempt counted", async () => {
  let reruns = 0;
  const res = await FA.attempts({ first: 1, judge: () => ({ ok: false, reasons: ["bad"] }), rerun: async () => { ++reruns; return 1; }, budget: FA.makeBudget(1) });
  assert.equal(res.ok, false);
  assert.equal(res.outcome, FA.OUTCOMES.REPRODUCED);
  assert.equal(res.attempts, 3);
  assert.equal(reruns, 2);
});

test("attempts: a spent diagnostic budget limits the re-renders, never the verdict", async () => {
  const budget = FA.makeBudget(1);
  const log = FA.createLog(budget);
  let reruns = 0;
  for (let i = 0; i < 4; ++i)
    log.add("item " + i, await FA.attempts({ first: i, judge: () => ({ ok: false, reasons: ["bad"] }), rerun: async () => { ++reruns; return i; }, budget }));
  const s = log.summary();
  assert.equal(s.firstAttemptFailures, 4);
  assert.equal(s.reproduced, 1);
  assert.equal(s.notRerendered, 3);
  assert.equal(s.diagnosticRenderAttempts, 2);
  assert.equal(reruns, 2);
});

test("attempts: a clean first attempt is never re-rendered", async () => {
  let reruns = 0;
  const res = await FA.attempts({ first: 1, judge: () => ({ ok: true, reasons: [] }), rerun: async () => { ++reruns; }, budget: FA.makeBudget(3) });
  assert.deepEqual([res.ok, res.attempts, reruns, res.outcome], [true, 1, 0, FA.OUTCOMES.CLEAN]);
});

test("faultInjector: arms one site, once, and only through the environment", () => {
  const env = { [FA.FAULT_ENV]: "held:transient" };
  const held = FA.faultInjector("held", env), other = FA.faultInjector("render", env);
  assert.equal(held.take(), "transient");
  assert.equal(held.take(), null);
  assert.equal(other.take(), null);
  assert.equal(FA.faultInjector("held", {}).take(), null);
  assert.equal(FA.faultInjector("held", { [FA.FAULT_ENV]: "held:nonsense" }).take(), null);
});

/* ------------------------------------------------------------------ the short-notes spec on a scripted page */

/*
 * A page whose renders are scripted: `held` and `completed` answer the program's numbers; the
 * `bad` hook corrupts the FIRST call of one kind only. Everything after is clean.
 */
function scriptedShortNotes({ badHeld = null, badCompleted = null, allBad = false } = {}) {
  const calls = { held: 0, completed: 0 };
  const shared = { engine: "webkit", matrix: { builds: ["source"], qualities: [0, 1] }, options: { overrides: {}, seed: 1 } };
  const evaluate = async (_fn, [name, arg]) => {
    if (name === "attacks") return Array.from({ length: 128 }, () => [0.01]);
    if (name === "held") {
      const n = ++calls.held;
      return (arg.durations || [0.025, 0.07, 0.3]).map((D, i) => {
        const x = Object.assign({}, clean, { D });
        return (allBad || (n === 1 && i === 0)) && badHeld ? FA.corruptSummary(badHeld, x) : x;
      });
    }
    if (name === "completed") {
      const n = ++calls.completed;
      const x = { diff: 0, peak: 0.2, nf: 0 };
      return (allBad || n === 1) && badCompleted ? FA.corruptSummary(badCompleted, x) : x;
    }
    throw new Error("unscripted " + name);
  };
  const checks = [], observed = {};
  const t = {
    engine: "webkit",
    shared,
    check: (name, ok, detail) => checks.push({ name, ok: !!ok, detail }),
    observe: (name, value) => { observed[name] = value; },
    newPage: async () => ({ page: { setContent: async () => {}, evaluate }, pageErrors: [] }),
  };
  const find = (id) => shortNotes.cases(shared).find((c) => c.id === id);
  return { t, checks, observed, calls, find };
}
const diagnostics = (o) => Object.entries(o).find(([k]) => k.startsWith("first-attempt failures"))[1];

test("short-notes held: a clean run passes with no diagnostics", async () => {
  const s = scriptedShortNotes();
  await s.find("short-notes held source").run(s.t);
  assert.ok(s.checks.every((c) => c.ok), JSON.stringify(s.checks.filter((c) => !c.ok)));
  const d = diagnostics(s.observed);
  assert.equal(d.firstAttemptFailures, 0);
  assert.equal(d.diagnosticRenders, 0);
  assert.equal(s.calls.held, 256);
});

for (const [kind, failing] of [["transient", "until the note-off the short note renders as the uncut note"], ["quiet", "sounds while held"], ["nonfinite", "every held render is finite"]]) {
  test("short-notes held: a " + kind + " in the first attempt fails the run although the re-render is clean", async () => {
    const s = scriptedShortNotes({ badHeld: kind });
    await s.find("short-notes held source").run(s.t);
    const failed = s.checks.filter((c) => !c.ok);
    assert.ok(failed.some((c) => c.name.includes(failing)), "failed: " + JSON.stringify(failed.map((c) => c.name)));
    assert.match(failed.map((c) => c.detail).join(" "), /a re-render was clean/);
    const d = diagnostics(s.observed);
    assert.equal(d.firstAttemptFailures, 1);
    assert.equal(d.intermittent, 1);
    assert.equal(d.reproduced, 0);
    assert.equal(d.diagnosticRenderAttempts, 1);
    assert.equal(d.diagnosticRenders, 2); // one held item = a short and an uncut render
    assert.equal(d.failures[0].attempts, 2);
    assert.equal(d.failures[0].diagnostics[0].ok, true);
    assert.equal(s.calls.held, 257); // 256 first attempts and one diagnostic re-render
  });
}

for (const kind of ["transient", "nonfinite"]) {
  test("short-notes completed: a " + kind + " in the first attempt fails the run although the re-render is clean", async () => {
    const s = scriptedShortNotes({ badCompleted: kind });
    await s.find("short-notes completed source").run(s.t);
    const failed = s.checks.filter((c) => !c.ok);
    assert.equal(failed.length, 1, JSON.stringify(failed));
    assert.match(failed[0].name, /renders as with upstream's release/);
    assert.match(failed[0].detail, /a re-render was clean/);
    const d = diagnostics(s.observed);
    assert.deepEqual([d.firstAttemptFailures, d.intermittent, d.diagnosticRenderAttempts, d.diagnosticRenders, d.firstAttemptRenders], [1, 1, 1, 2, 2 * s.calls.completed - 2]);
  });
}

test("short-notes completed: the attempts are counted as they happen, and the budget is capped", async () => {
  const s = scriptedShortNotes({ badCompleted: "transient", allBad: true });
  await s.find("short-notes completed source").run(s.t);
  assert.equal(s.checks.filter((c) => !c.ok).length, 1);
  const d = diagnostics(s.observed);
  assert.equal(d.firstAttemptFailures, s.calls.completed - d.diagnosticRenderAttempts);
  assert.equal(d.reproduced, 6); // MAX_DIAGNOSED items, two re-renders each
  assert.equal(d.diagnosticRenderAttempts, 12);
  assert.equal(d.diagnosticRenders, 24);
  assert.equal(d.notRerendered, d.firstAttemptFailures - 6);
  assert.ok(d.notRerendered > 0);
});
