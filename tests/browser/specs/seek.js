/*
 * History-independent seek in the browser (#21; T3, D-005, D-019), asserted
 * per build in the instrumented graph of a realtime context (the harness in
 * specs/transport.js).
 *
 * The song sets channel 0's state before tick 960 (program 1, RPN coarse
 * tuning +2, pitch bend, volume, pan, and 100 BPM from tick 240) and changes it
 * at tick 1200 (program 0, volume, pan, modulation, bend, 200 BPM). Programs 0
 * and 1 are a sine and a square timbre, so the program is visible as the
 * oscillator type.
 *
 * Reference: a fresh synth loads the song, seeks to tick 960 and plays. Its
 * notes and channel automation are checked against the song's state before
 * tick 960 (D-005), computed here from the song with the library's
 * documented mappings, and its note times against the tempo map.
 *
 * Two other histories then seek to tick 960 and must give exactly the
 * reference's new pass: the same note times (from the pass start), frequencies,
 * detunes and waveforms, and the same effective automation of channel 0's
 * volume, pan and modulation (the value in effect at the pass start and every
 * later event). The effective automation follows the recorded calls with Web
 * Audio's timeline rules: the value setter acts at the context time of the
 * call, and cancelScheduledValues(t) removes the events at or after t.
 *   - after a completed play, with manual overrides (program, volume, pan,
 *     bend, modulation, master coarse tuning) and caller-scheduled automation
 *     (send() of volume, pan and modulation 0.35 s ahead, after the seek), which
 *     the seek must cancel;
 *   - while playing, right after the scheduler queued the song's tick-1200
 *     changes ahead of time, which the seek must cancel.
 */
"use strict";
const T = require("./transport");

const SEEK_TICK = 960;
// Attempts at catching the scheduler's lookahead (see the "while playing" case).
const QUEUE_ATTEMPTS = 3;
const PROGRAMS = [[0, 0, T.SINE], [0, 1, T.SQUARE]];
const SONG = T.song([
  [0, [0xc0, 1]], [0, [0xb0, 7, 90]], [0, [0xb0, 10, 40]], [0, [0xe0, 0x00, 0x60]], // bend 12288
  [0, [0xb0, 101, 0]], [0, [0xb0, 100, 2]], [0, [0xb0, 6, 66]], // RPN 2, coarse tuning +2
  [240, T.tempo(100)],
  [480, T.on(60)], [720, T.off(60)],
  [960, T.on(64)], [1200, T.off(64)],
  [1200, [0xc0, 0]], [1200, [0xb0, 7, 50]], [1200, [0xb0, 10, 100]], [1200, [0xb0, 1, 64]], [1200, [0xe0, 0x00, 0x20]], [1200, T.tempo(200)], // bend 4096
  [1440, T.on(67)], [1680, T.off(67)],
]);

/* The library's documented mappings (D-005 baseline values, GM gain, bend range units of 100/127 cent). */
const vol = (v) => 3 * v * v / (127 * 127);
const pan = (v) => (v - 64) / 64;
const mod = (v) => v * 100 / 127;
const detune = (v) => (v - 8192) * (0x100 * 100 / 127) / 8192;
const hz = (n, coarse) => 440 * Math.pow(2, (n - 69 + coarse) / 12);
const at = (tick) => T.seconds(SONG, tick) - T.seconds(SONG, SEEK_TICK);
const EXPECTED = {
  notes: [
    { t: 0, freq: hz(64, 2), detune: detune(12288), wave: "square" },
    { t: at(1440), freq: hz(67, 2), detune: detune(4096), wave: "sine" },
  ],
  vol: { at: vol(90), after: [[at(1200), vol(50)]] },
  pan: { at: pan(40), after: [[at(1200), pan(100)]] },
  mod: { at: 0, after: [[at(1200), mod(64)]] },
};

/* The new pass after the seek: its notes and channel 0's automation, from the pass start. */
function pass(r, seekOp) {
  const origin = seekOp.playTime;
  const notes = T.notes(r).filter((x) => x.seq > seekOp.seq).map((x) => ({ t: x.start - origin, freq: x.freq, detune: x.detune, wave: x.wave }));
  const out = { origin, notes };
  for (const p of ["vol", "pan", "mod"]) out[p] = T.automation(r, p, origin);
  return out;
}

const near = (a, b, rel) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(b));
/* Differences between two passes, or against EXPECTED (rel: relative tolerance for values recorded through float32 AudioParams). */
function compare(a, b, rel) {
  const d = [];
  if (a.notes.length !== b.notes.length) d.push("notes " + a.notes.length + " vs " + b.notes.length);
  a.notes.forEach((n, i) => {
    const m = b.notes[i];
    if (!m) return;
    if (Math.abs(n.t - m.t) > T.TIME_TOL) d.push("note " + i + " time " + T.fmt(n.t) + " vs " + T.fmt(m.t));
    if (!near(n.freq, m.freq, rel)) d.push("note " + i + " frequency " + n.freq + " vs " + m.freq);
    if (!near(n.detune, m.detune, rel)) d.push("note " + i + " detune " + n.detune + " vs " + m.detune);
    if (n.wave !== m.wave) d.push("note " + i + " wave " + n.wave + " vs " + m.wave);
  });
  for (const p of ["vol", "pan", "mod"]) {
    const x = a[p], y = b[p];
    if (x.unsupported && x.unsupported.length) d.push(p + " uses " + x.unsupported.join(","));
    if (x.at === null || !near(x.at, y.at, rel)) d.push(p + " at the pass start " + x.at + " vs " + y.at);
    if (x.after.length !== y.after.length) d.push(p + " later events " + JSON.stringify(x.after) + " vs " + JSON.stringify(y.after));
    else x.after.forEach((e, i) => {
      if (Math.abs(e[0] - y.after[i][0]) > T.TIME_TOL || !near(e[1], y.after[i][1], rel)) d.push(p + " event " + i + " " + JSON.stringify(e) + " vs " + JSON.stringify(y.after[i]));
    });
  }
  return d;
}

function cases(shared) {
  const { matrix } = shared;
  const out = [];
  const song = T.b64(SONG);
  const end = [{ when: { flip: 1 } }, { when: { after: 0.15 } }];
  for (const build of matrix.builds) {
    const reference = async (t) => {
      const r = await T.scenario(t, build, {
        timbres: PROGRAMS,
        steps: [{ when: "now", ops: [{ load: song }, { call: "locateMIDI", args: [SEEK_TICK] }, { call: "playMIDI" }] }, ...end],
      }, "reference (fresh seek)");
      if (!r) return null;
      const ref = pass(r, T.opAt(r, "playMIDI"));
      t.observe("reference pass", ref);
      // Values come back through float32 AudioParams: 1e-6 relative covers float32 rounding (6e-8).
      const d = compare(ref, EXPECTED, 1e-6);
      t.check("a fresh seek to tick " + SEEK_TICK + " applies the song's state before it (D-005: program, RPN tuning, bend, volume, pan, tempo) and plays the rest on the tempo map", !d.length, d.slice(0, 6).join("; "));
      return ref;
    };
    out.push({
      id: "seek " + build + " #21 after a completed play, manual overrides and caller-scheduled automation", dims: { build },
      run: async (t) => {
        const ref = await reference(t);
        if (!ref) return;
        const r = await T.scenario(t, build, {
          timbres: PROGRAMS, maxSeconds: 10,
          steps: [
            { when: "now", ops: [{ load: song }, { call: "playMIDI" }] },
            { when: { flip: 1 } },
            {
              when: { after: 0.3 }, ops: [
                { call: "setProgram", args: [0, 0] }, { call: "setChVol", args: [0, 20] }, { call: "setPan", args: [0, 127] },
                { call: "setBend", args: [0, 16000] }, { call: "setModulation", args: [0, 80] },
                { call: "send", args: [[0xf0, 0x7f, 0x7f, 0x04, 0x04, 0x00, 0x43, 0xf7]] }, // master coarse tuning +3
                { call: "send", args: [[0xb0, 7, 0], { rel: 0.35 }] }, { call: "send", args: [[0xb0, 10, 0], { rel: 0.35 }] }, { call: "send", args: [[0xb0, 1, 127], { rel: 0.35 }] },
                { call: "locateMIDI", args: [SEEK_TICK] }, { call: "playMIDI" },
              ],
            },
            { when: { flip: 2 } }, { when: { after: 0.15 } },
          ],
        }, "history");
        if (!r) return;
        const play = T.opAt(r, "playMIDI", 1);
        const timed = r.ops.filter((o) => o.op === "send" && o.args.length > 1).map((o) => o.args[1]);
        t.check("(precondition) the caller-scheduled changes are due after the seek's pass start", timed.length === 3 && timed.every((x) => x > play.playTime), timed.map(T.fmt).join(", ") + " vs pass start " + T.fmt(play.playTime));
        const got = pass(r, play);
        t.observe("pass after the seek", got);
        const d = compare(got, ref, 0);
        t.check("the pass after the seek equals the fresh seek's: notes, tempo, and channel automation with the caller's scheduled changes cancelled", !d.length, d.slice(0, 6).join("; "));
      },
    });
    out.push({
      id: "seek " + build + " #21 while playing, with the song's later changes queued", dims: { build },
      run: async (t) => {
        const ref = await reference(t);
        if (!ref) return;
        /*
         * The seek runs right after the scheduler tick that sends tick 1200's
         * changes, which are then due up to 0.2 s (the lookahead) later. A tick
         * that comes 0.2 s or more after the previous one (a loaded runner) sends
         * them already due, or sends the rest of the song so that it ends before
         * the seek step: then nothing queued is left to cancel, the attempt does
         * not exercise the case, and it is repeated, at most QUEUE_ATTEMPTS times,
         * each in a fresh page. Every attempt is recorded.
         */
        const attempts = [];
        let r = null, seek = null;
        for (let k = 1; k <= QUEUE_ATTEMPTS && !t.isAbandoned(); ++k) {
          const x = await T.scenario(t, build, {
            timbres: PROGRAMS,
            steps: [
              { when: "now", ops: [{ load: song }, { call: "playMIDI" }] },
              { when: { curTick: 1440 }, ops: [{ call: "locateMIDI", args: [SEEK_TICK] }] },
              ...end,
            ],
          }, "history, attempt " + k, { unfinishedOk: true });
          if (!x) return;
          const s = T.opAt(x, "locateMIDI");
          const sent = s ? x.params.filter((p) => p.param === "vol" && p.m === "setValueAtTime" && p.seq < s.seq && p.v === vol(50)) : [];
          attempts.push("attempt " + k + ": " + (!s ? "the song ended before the seek step (a late tick sent the rest)" : x.unfinished ? "steps left after the seek" : sent.length ? "due " + T.fmt(sent[0].t - s.at) + " s after the seek" : "not sent before the seek"));
          r = x;
          seek = s;
          if (s && !x.unfinished && sent.length === 1 && sent[0].t > s.at) break;
        }
        if (!r) return;
        t.observe("lookahead attempts", attempts);
        const queued = seek && !r.unfinished ? r.params.filter((p) => p.param === "vol" && p.m === "setValueAtTime" && p.seq < seek.seq && p.t > seek.at && p.v === vol(50)) : [];
        if (!t.check("(precondition) the song's tick-1200 volume change was queued for after the seek (scheduler lookahead), within " + QUEUE_ATTEMPTS + " attempts", queued.length === 1, attempts.join("; "))) return;
        const got = pass(r, seek);
        t.observe("pass after the seek", got);
        const d = compare(got, ref, 0);
        t.check("the pass after the seek equals the fresh seek's: notes, tempo, and channel automation with the queued changes cancelled", !d.length, d.slice(0, 6).join("; "));
      },
    });
  }
  return out;
}

module.exports = { cases };
