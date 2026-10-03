/*
 * Scheduler safety (issue #8) and songs with nothing to play (issue #9), run
 * in child processes with an external deadline.
 *
 * At the T0 baseline a looping song whose events all share one tick hung the
 * scheduler callback (no in-process timeout can stop that), and a tempo-only
 * song with looping on did too. So each build's cases run in a child process
 * (this file, started with TINYSYNTH_TRANSPORT_CHILD set) that is killed after
 * DEADLINE_MS. The child prints a line before each case, so a hang names it.
 *
 * Contract under test (tasks/T3.md):
 *   - A pass wraps only if the next pass advances: loopEnd > 0, or the last
 *     retained event is later than the first. Otherwise the song ends after one
 *     pass as if looping were off: play 0, curTick maxTick.
 *   - One scheduler callback handles at most 1000 events. The rest follow on
 *     later callbacks, in order, at their own scheduled times.
 *   - A song with no retained event other than tempo (empty, metadata-only,
 *     tempo-only) stays stopped: playMIDI() creates no node and changes nothing.
 *
 * Expected times come from the MIDI tempo map (120 BPM until the first tempo
 * event) and playMIDI's documented start, currentTime + 0.1 s.
 */
"use strict";
const H = require("../harness");

const PPQ = 480;
const LIMIT = 1000; // events per scheduler callback
const { noteOn, noteOff, tempo } = H.midi;
const cc = (tick, ch, n, v) => ({ tick, bytes: [0xb0 | ch, n, v] });
const meta = (tick, type, text) => ({ tick, bytes: [0xff, type, text.length, ...Buffer.from(text, "latin1")] });

/* A file with one track whose End-of-Track is at `eotTick` (raw writer, so it can come after the last event). */
function withEot(events, eotTick) {
  const body = H.trackBytes(events, false);
  const last = events.reduce((m, e) => Math.max(m, e.tick), 0);
  return H.smf(0, PPQ, [[...body, ...H.vlq(eotTick - last), 0xff, 0x2f, 0x00]]);
}

/* `n` control changes at `tick`, spread over 16 channels, each with a distinct value. */
const batch = (tick, n) => Array.from({ length: n }, (_, i) => cc(tick, i % 16, 7, (i >> 4) % 128));

/* Dense finite song: a note every 10 ticks over `ticks`, tempo changes every 4 bars. */
function denseSong(ticks) {
  const ev = [];
  for (let t = 0; t < ticks; t += 10) ev.push(noteOn(t, t % 3, 48 + (t / 10) % 36, 90), noteOff(t + 5, t % 3, 48 + (t / 10) % 36));
  const tempos = [];
  for (let t = 0, i = 0; t < ticks; t += 16 * PPQ, ++i) tempos.push([t, [500000, 455000, 600000, 400000][i % 4]]);
  return { bytes: H.makeMidi(PPQ, ev.concat(tempos.map(([t, us]) => tempo(t, us)))), tempos, noteTicks: ev.filter((e) => (e.bytes[0] & 0xf0) === 0x90).map((e) => e.tick) };
}

/* ---------- child ---------- */

/*
 * A synth with `bytes` loaded and `setup(synth)` applied. Every message the
 * scheduler sends is recorded as [callback, msg, t]; each step records its
 * event count and wall time.
 */
function instrument(variant, bytes, setup) {
  const s = H.createSynth(variant.source, variant.name);
  const sent = [];
  let callback = 0;
  s.synth.loadMIDI(H.toArrayBuffer(bytes));
  if (setup) setup(s.synth);
  const send = s.synth.send;
  s.synth.send = (m, t) => { sent.push([callback, Array.from(m), t]); return send(m, t); };
  const perStep = [];
  const step = () => {
    ++callback;
    const from = sent.length, t0 = process.hrtime.bigint();
    s.env.step();
    perStep.push({ sends: sent.length - from, ms: Number(process.hrtime.bigint() - t0) / 1e6 });
  };
  const osc = (from) => s.trace.slice(from).filter((l) => l.startsWith('["create","osc#') || l.startsWith('["create","src#')).length;
  return Object.assign(s, { sent, perStep, step, osc, status: () => ({ ...s.synth.getPlayStatus() }) });
}

const noteOnTimes = (s) => s.notes.map((n) => n[0]);

const CASES = {
  /* #8: zero-duration loops end after one pass. */
  "zero-duration default loop (issue snippet)": (v) => {
    const s = instrument(v, H.makeMidi(PPQ, [noteOn(0, 0, 60, 100), noteOff(0, 0, 60)]), (y) => y.setLoop(1));
    s.synth.playMIDI();
    s.step();
    const afterFirst = s.status();
    for (let i = 0; i < 50; ++i) s.step();
    return { afterFirst, status: s.status(), sends: s.sent.length, notes: noteOnTimes(s) };
  },
  "one-tick loop at tick 960, loopEnd 0": (v) => {
    const s = instrument(v, H.makeMidi(PPQ, [noteOn(960, 0, 60, 100), noteOff(960, 0, 60)]), (y) => y.setLoop(1));
    s.synth.playMIDI();
    for (let i = 0; i < 50; ++i) s.step();
    return { status: s.status(), sends: s.sent.length, notes: noteOnTimes(s) };
  },
  "one-tick loop with a negative loopEnd": (v) => {
    const s = instrument(v, H.makeMidi(PPQ, [noteOn(0, 0, 60, 100), noteOff(0, 0, 60)]), (y) => { y.setLoop(1); y.setLoopEnd(-480); });
    s.synth.playMIDI();
    for (let i = 0; i < 50; ++i) s.step();
    return { status: s.status(), sends: s.sent.length, notes: noteOnTimes(s) };
  },
  "tempo and program change at tick 0 only, looping": (v) => {
    const s = instrument(v, H.makeMidi(PPQ, [tempo(0, 400000), { tick: 0, bytes: [0xc0, 5] }]), (y) => y.setLoop(1));
    s.synth.playMIDI();
    const started = s.status();
    for (let i = 0; i < 50; ++i) s.step();
    return { started, status: s.status(), sends: s.sent.map((x) => x[1]), pg0: s.synth.pg[0] };
  },
  "5000-event same-tick batch, looping": (v) => {
    const ev = batch(0, 4998).concat([noteOn(0, 0, 60, 100), noteOff(0, 0, 60)]);
    const s = instrument(v, H.makeMidi(PPQ, ev), (y) => y.setLoop(1));
    const order = s.synth.song.ev.map((e) => Array.from(e.m));
    s.synth.playMIDI();
    const start = s.synth.playTime;
    for (let i = 0; i < 20; ++i) s.step();
    return {
      status: s.status(), perStep: s.perStep.map((x) => x.sends), start,
      inOrder: JSON.stringify(s.sent.map((x) => x[1])) === JSON.stringify(order),
      times: [...new Set(s.sent.map((x) => x[2]))], notes: s.notes.length,
    };
  },

  /* #8: positive loopEnd keeps a one-tick phrase looping. */
  "tick-0 phrase padded by loopEnd 480": (v) => {
    const s = instrument(v, H.makeMidi(PPQ, [noteOn(0, 0, 60, 100), noteOff(0, 0, 60)]), (y) => { y.setLoop(1); y.setLoopEnd(480); });
    s.synth.playMIDI();
    for (let i = 0; i < 50; ++i) s.step(); // 3 s
    return { status: s.status(), notes: noteOnTimes(s) };
  },
  "one tick at 960 with loopEnd 480 (not above the tick)": (v) => {
    const s = instrument(v, H.makeMidi(PPQ, [noteOn(960, 0, 60, 100), noteOff(960, 0, 60)]), (y) => { y.setLoop(1); y.setLoopEnd(480); });
    s.synth.playMIDI();
    for (let i = 0; i < 70; ++i) s.step(); // 4.2 s
    return { status: s.status(), notes: noteOnTimes(s) };
  },
  "loopEnd 1 at 1 us per quarter note (each pass advances about 2 ns)": (v) => {
    const s = instrument(v, H.makeMidi(PPQ, [tempo(0, 1), noteOn(0, 0, 60, 100), noteOff(0, 0, 60)]), (y) => { y.setLoop(1); y.setLoopEnd(1); });
    s.synth.playMIDI();
    for (let i = 0; i < 20; ++i) s.step();
    const t = noteOnTimes(s);
    return {
      status: s.status(), perStep: s.perStep.map((x) => x.sends), maxMs: Math.max(...s.perStep.map((x) => x.ms)),
      ordered: t.every((x, i) => i === 0 || x >= t[i - 1]), advancing: t[t.length - 1] > t[0],
    };
  },

  /* #8: bounded work for finite songs. */
  "3000-event same-tick batch then later notes": (v) => {
    const ev = batch(0, 3000).concat([noteOn(0, 0, 60, 100), noteOff(240, 0, 60), noteOn(480, 0, 62, 100), noteOff(720, 0, 62)]);
    const s = instrument(v, H.makeMidi(PPQ, ev), (y) => y.setLoop(0));
    const order = s.synth.song.ev.map((e) => Array.from(e.m));
    s.synth.playMIDI();
    const start = s.synth.playTime;
    while (s.synth.playing && s.perStep.length < 200) s.step();
    return {
      status: s.status(), perStep: s.perStep.map((x) => x.sends), start,
      inOrder: JSON.stringify(s.sent.map((x) => x[1])) === JSON.stringify(order),
      batchTimes: [...new Set(s.sent.slice(0, 3001).map((x) => x[2]))], notes: noteOnTimes(s),
    };
  },
  "dense song after a one-hour catch-up window": (v) => {
    const song = denseSong(24000); // 2400 notes, 4800 note events plus tempo
    const s = instrument(v, song.bytes, (y) => y.setLoop(0));
    const order = s.synth.song.ev.filter((e) => e.m[0] !== 0xff51).map((e) => Array.from(e.m));
    s.synth.playMIDI();
    const start = s.synth.playTime;
    s.step();
    s.env.skip(3600 * 1000);
    while (s.synth.playing && s.perStep.length < 200) s.step();
    return {
      status: s.status(), perStep: s.perStep.map((x) => x.sends), start, tempos: song.tempos, noteTicks: song.noteTicks,
      inOrder: JSON.stringify(s.sent.map((x) => x[1])) === JSON.stringify(order), notes: noteOnTimes(s),
    };
  },
  "looping ws.mid after a ten-minute catch-up window": (v) => {
    const bytes = require("node:fs").readFileSync(require("node:path").join(H.ROOT, "ws.mid"));
    const s = instrument(v, bytes, (y) => y.setLoop(1));
    const cycle = s.synth.song.ev.filter((e) => e.m[0] !== 0xff51).map((e) => JSON.stringify(Array.from(e.m)));
    s.synth.playMIDI();
    for (let i = 0; i < 30; ++i) s.step();
    const before = s.sent.length;
    s.env.skip(600 * 1000);
    for (let i = 0; i < 30; ++i) s.step();
    // Every message sent follows the song's event order, cyclically, from the first one.
    const cyclic = s.sent.every((x, i) => JSON.stringify(x[1]) === cycle[i % cycle.length]);
    const t = s.sent.map((x) => x[2]);
    return {
      status: s.status(), perStepAfter: s.perStep.slice(30).map((x) => x.sends), before, total: s.sent.length,
      cyclic, timesOrdered: t.every((x, i) => i === 0 || x >= t[i - 1]),
    };
  },
};

/* #9: songs with no retained event other than tempo, under each loop setup. */
const SILENT = {
  "empty (End-of-Track only)": H.makeMidi(PPQ, []),
  "empty, End-of-Track at 1920": withEot([], 1920),
  "metadata only (text, copyright, name, marker, time and key signature)": withEot([
    meta(0, 0x01, "text"), meta(0, 0x02, "(c)"), meta(0, 0x03, "name"), { tick: 0, bytes: [0xff, 0x58, 4, 4, 2, 24, 8] },
    { tick: 0, bytes: [0xff, 0x59, 2, 0, 0] }, meta(480, 0x06, "marker"), meta(1920, 0x01, "end"),
  ], 1920),
  "one tempo event at tick 0": H.makeMidi(PPQ, [tempo(0, 500000)]),
  "one tempo event at tick 480": withEot([tempo(480, 600000)], 1920),
  "tempo events at 0, 960 and 1920": H.makeMidi(PPQ, [tempo(0, 500000), tempo(960, 400000), tempo(1920, 1000000)]),
};
const SETUPS = {
  "loop off": (y) => { y.setLoop(0); y.setLoopEnd(0); },
  "loop on": (y) => { y.setLoop(1); y.setLoopEnd(0); },
  "loop on, loopEnd 480": (y) => { y.setLoop(1); y.setLoopEnd(480); },
  "loop on, loopEnd 1920": (y) => { y.setLoop(1); y.setLoopEnd(1920); },
};
const NORMAL = H.makeMidi(PPQ, [noteOn(0, 0, 60, 100), noteOff(240, 0, 60), noteOn(480, 0, 62, 100), noteOff(720, 0, 62)]);

for (const [song, bytes] of Object.entries(SILENT)) {
  CASES["silent song: " + song] = (v) => {
    const s = instrument(v, bytes);
    const out = { events: s.synth.song.ev.map((e) => Array.from(e.m)), setups: {} };
    for (const [name, setup] of Object.entries(SETUPS)) {
      s.synth.loadMIDI(H.toArrayBuffer(bytes));
      setup(s.synth);
      const loaded = s.status(), from = s.trace.length, state = JSON.stringify(H.playbackState(s.synth));
      s.synth.playMIDI();
      const r = { loaded, afterPlay: s.status(), calls: s.trace.length - from, stateUnchanged: JSON.stringify(H.playbackState(s.synth)) === state };
      for (let i = 0; i < 100; ++i) s.step(); // 6 s
      r.after6s = s.status();
      s.synth.stopMIDI();
      s.synth.playMIDI();
      s.synth.locateMIDI(480);
      s.synth.playMIDI();
      for (let i = 0; i < 10; ++i) s.step();
      r.afterReplay = s.status();
      r.sends = s.sent.length;
      r.osc = s.osc(from);
      out.setups[name] = r;
    }
    // A normal song still loads and plays to its end afterwards.
    s.synth.loadMIDI(H.toArrayBuffer(NORMAL));
    s.synth.setLoop(0);
    s.synth.playMIDI();
    out.normalStarted = s.status();
    out.normalFinished = H.runUntil(s.env, () => !s.synth.playing, 10000);
    out.normal = { status: s.status(), notes: noteOnTimes(s) };
    return out;
  };
}

function child(build) {
  const variant = H.forkVariants().find((v) => v.name === build);
  const report = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  for (const [name, run] of Object.entries(CASES)) {
    report({ start: name });
    report({ name, result: run(variant) });
  }
  report({ done: true });
}

/* ---------- parent ---------- */

function parent() {
  const test = require("node:test");
  const assert = require("node:assert/strict");
  const { spawnSync } = require("node:child_process");
  const DEADLINE_MS = 60000;

  /* Seconds from tick 0 to `tick` under a tempo map [[tick, us], ...], 120 BPM before the first entry. */
  function secondsAt(tempos, tick) {
    const map = tempos.length && tempos[0][0] === 0 ? tempos : [[0, 500000]].concat(tempos);
    let s = 0;
    for (let i = 0; i < map.length; ++i) {
      const [from, us] = map[i];
      const to = i + 1 < map.length ? map[i + 1][0] : Infinity;
      if (tick <= from) break;
      s += (Math.min(tick, to) - from) * us / 1e6 / PPQ;
    }
    return s;
  }
  const close = (a, b, msg) => assert.ok(Math.abs(a - b) <= 1e-9, msg + ": " + a + " vs " + b);

  function runChild(build) {
    const env = Object.assign({}, process.env, { TINYSYNTH_TRANSPORT_CHILD: build });
    delete env.NODE_TEST_CONTEXT;
    const started = Date.now();
    const r = spawnSync(process.execPath, [__filename], { env, encoding: "utf8", timeout: DEADLINE_MS, killSignal: "SIGKILL", maxBuffer: 1 << 26 });
    const lines = r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const starts = lines.filter((l) => l.start);
    if (r.error || r.status !== 0) {
      const last = starts.length ? starts[starts.length - 1].start : "(setup)";
      assert.fail(build + ": child " + (r.error ? r.error.code : "exited " + r.status + " " + r.signal) +
        " after " + (Date.now() - started) + " ms, in case: " + last + "\n" + r.stderr);
    }
    assert.ok(lines.some((l) => l.done), build + ": the child did not finish");
    return new Map(lines.filter((l) => l.name).map((l) => [l.name, l.result]));
  }

  for (const build of ["webaudio-tinysynth.js", "webaudio-tinysynth.min.js"]) {
    test.describe(build + ": scheduler (child process, " + DEADLINE_MS / 1000 + " s deadline)", () => {
      let res;
      test.before(() => {
        res = runChild(build);
      });
      const get = (name) => res.get(name);

      test("a zero-duration default loop plays once, then stops with curTick = maxTick (#8)", () => {
        const r = get("zero-duration default loop (issue snippet)");
        assert.deepEqual(r.afterFirst, { play: 0, maxTick: 0, curTick: 0 });
        assert.deepEqual(r.status, { play: 0, maxTick: 0, curTick: 0 });
        assert.equal(r.sends, 2);
        assert.deepEqual(r.notes, [0.1]);
        const at960 = get("one-tick loop at tick 960, loopEnd 0");
        assert.deepEqual([at960.status, at960.sends, at960.notes], [{ play: 0, maxTick: 960, curTick: 960 }, 2, [0.1]]);
        const negative = get("one-tick loop with a negative loopEnd");
        assert.deepEqual([negative.status, negative.sends, negative.notes], [{ play: 0, maxTick: 0, curTick: 0 }, 2, [0.1]]);
      });

      test("a looping one-tick song of tempo and state events plays once, then stops (#8)", () => {
        const r = get("tempo and program change at tick 0 only, looping");
        assert.deepEqual(r.started, { play: 1, maxTick: 0, curTick: 0 });
        assert.deepEqual(r.status, { play: 0, maxTick: 0, curTick: 0 });
        assert.deepEqual(r.sends, [[0xc0, 5]]);
        assert.equal(r.pg0, 5);
      });

      test("a 5000-event same-tick loop takes five callbacks of 1000 events, in order, then stops (#8)", () => {
        const r = get("5000-event same-tick batch, looping");
        assert.deepEqual(r.perStep.slice(0, 6), [LIMIT, LIMIT, LIMIT, LIMIT, LIMIT, 0]);
        assert.deepEqual(r.status, { play: 0, maxTick: 0, curTick: 0 });
        assert.equal(r.inOrder, true);
        assert.deepEqual(r.times, [r.start]);
        assert.equal(r.notes, 1);
      });

      test("a positive loopEnd keeps a tick-0 phrase looping, 480 ticks per pass (#8)", () => {
        const r = get("tick-0 phrase padded by loopEnd 480");
        assert.equal(r.status.play, 1);
        // 480 ticks at the default 120 BPM = 0.5 s per pass; the first note plays at currentTime 0 + 0.1 s.
        assert.ok(r.notes.length >= 6, JSON.stringify(r.notes));
        r.notes.forEach((t, i) => close(t, 0.1 + i * 0.5, "note " + i));
      });

      test("one tick at 960 with loopEnd 480 loops every 960 ticks: the wrap restores the leading rest (#8)", () => {
        const r = get("one tick at 960 with loopEnd 480 (not above the tick)");
        assert.equal(r.status.play, 1);
        assert.ok(r.notes.length >= 4, JSON.stringify(r.notes));
        r.notes.forEach((t, i) => close(t, 0.1 + i * secondsAt([], 960), "note " + i));
      });

      test("a loop that advances by nanoseconds per pass does at most 1000 events per callback (#8)", () => {
        const r = get("loopEnd 1 at 1 us per quarter note (each pass advances about 2 ns)");
        assert.equal(r.status.play, 1);
        assert.equal(r.perStep.length, 20);
        // Three events per pass (tempo, note-on, note-off), two of them sent: 1000 events are 667 or 666 sends.
        for (const n of r.perStep) assert.ok(n > 0 && n <= 667, "sends per callback: " + n);
        assert.equal(r.ordered, true);
        assert.equal(r.advancing, true);
      });

      test("a finite same-tick batch continues on later callbacks, in order and at its own time (#8)", () => {
        const r = get("3000-event same-tick batch then later notes");
        assert.deepEqual(r.perStep.slice(0, 3), [LIMIT, LIMIT, LIMIT]);
        assert.ok(r.perStep.every((n) => n <= LIMIT));
        assert.equal(r.perStep.reduce((a, b) => a + b, 0), 3004);
        assert.equal(r.inOrder, true);
        assert.deepEqual(r.batchTimes, [r.start]);
        assert.deepEqual(r.notes.map((t) => Math.round((t - r.start) * 1e9) / 1e9), [0, 0.5]);
        assert.equal(r.status.play, 0);
        assert.equal(r.status.curTick, r.status.maxTick);
      });

      test("after a one-hour catch-up window a dense song continues 1000 events per callback, none dropped (#8)", () => {
        const r = get("dense song after a one-hour catch-up window");
        assert.equal(r.status.play, 0);
        assert.equal(r.status.curTick, r.status.maxTick);
        assert.ok(r.perStep.every((n) => n <= LIMIT), JSON.stringify(r.perStep));
        // Tempo events count toward the limit but are not sent, so a full callback sends 999 or 1000 messages here.
        assert.ok(r.perStep.filter((n) => n >= LIMIT - 1).length >= 4, "the catch-up did not need several callbacks: " + JSON.stringify(r.perStep));
        assert.equal(r.inOrder, true);
        assert.equal(r.notes.length, r.noteTicks.length);
        r.notes.forEach((t, i) => close(t, r.start + secondsAt(r.tempos, r.noteTicks[i]), "note " + i));
      });

      test("after a ten-minute catch-up window a looping song continues in order, 1000 events per callback (#8)", () => {
        const r = get("looping ws.mid after a ten-minute catch-up window");
        assert.equal(r.status.play, 1);
        assert.ok(r.perStepAfter.every((n) => n <= LIMIT), JSON.stringify(r.perStepAfter));
        assert.ok(r.perStepAfter.slice(0, 5).every((n) => n > 900), "the catch-up was not bounded work: " + JSON.stringify(r.perStepAfter));
        assert.equal(r.cyclic, true);
        assert.equal(r.timesOrdered, true);
      });

      for (const song of Object.keys(SILENT)) {
        test("a song with nothing but tempo or metadata stays stopped and allocates nothing (#9): " + song, () => {
          const r = get("silent song: " + song);
          assert.ok(r.events.every((m) => m[0] === 0xff51), JSON.stringify(r.events));
          for (const [setup, x] of Object.entries(r.setups)) {
            const what = song + ", " + setup;
            assert.equal(x.loaded.play, 0, what);
            assert.deepEqual(x.afterPlay, x.loaded, what);
            assert.equal(x.calls, 0, what + ": playMIDI made WebAudio calls");
            assert.equal(x.stateUnchanged, true, what);
            assert.deepEqual(x.after6s, x.loaded, what);
            assert.equal(x.afterReplay.play, 0, what);
            assert.equal(x.sends, 0, what);
            assert.equal(x.osc, 0, what);
          }
          assert.equal(r.normalStarted.play, 1);
          assert.equal(r.normalFinished, true);
          assert.deepEqual(r.normal.status, { play: 0, maxTick: 720, curTick: 720 });
          assert.equal(r.normal.notes.length, 2);
          close(r.normal.notes[1] - r.normal.notes[0], 0.5, "normal song");
        });
      }
    });
  }
}

if (process.env.TINYSYNTH_TRANSPORT_CHILD) {
  child(process.env.TINYSYNTH_TRANSPORT_CHILD);
} else {
  parent();
}
