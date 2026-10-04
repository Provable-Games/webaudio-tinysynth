/*
 * Transport in the browser (#8, #9, #10; T3, D-005, D-019, T3 review F11),
 * asserted per build in the instrumented graph of a realtime context.
 *
 * Every scenario runs in a fresh page served from the controlled server. The
 * page harness (HARNESS below) constructs a synth, resumes its realtime
 * context and records, on that context's instances only:
 *   - every oscillator and buffer source: creation, start(when), its
 *     frequency, detune and waveform at start, and every stop() call with the
 *     context time and the operation that made it;
 *   - every call on channel 0's volume, pan and modulation AudioParams
 *     (setValueAtTime, cancelScheduledValues, the value setter, ...).
 * It wraps the library's 60 ms scheduler callback, captured when the
 * constructor calls setInterval, so that scenario steps run right after a
 * scheduler tick, for example in the tick where the song ends ("flip").
 * Program 0 is a one-operator sine timbre, so each note is one source.
 *
 * Note times are the start(when) values the library schedules, which are
 * exact, so timing checks do not depend on timer jitter. Expectations come
 * from an independent tempo map (lib/smf.js). A scenario runs under an
 * external Node deadline: a scheduler that never returns (#8 at baseline)
 * fails the check instead of hanging the run.
 *
 * Asserted:
 *   #8   a looped song whose events all share one tick plays once and stops
 *        ({play: 0, curTick: maxTick}); a positive loopEnd keeps such a song
 *        looping with a period of loopEnd ticks;
 *   #9   empty and tempo-only songs, looped or not: playMIDI() leaves the
 *        status unchanged and creates no node, and no note plays;
 *   #10  a replay of a completed song has the first pass's note times, which
 *        equal the tempo map (120 BPM until the song's first tempo event);
 *   D-019 a replay in the tick where the song ends stops none of the previous
 *        pass's notes, and its last note sounds until its note-off;
 *   F11  a seek right after such a replay stops the previous pass's notes.
 * The seek (#21) assertions are in specs/seek.js, which uses this harness.
 */
"use strict";
const pages = require("../lib/pages");
const smf = require("../lib/smf");
const { withTimeout, short } = require("../lib/cases");

// Seconds: the external deadline around one scenario (the longest runs about 4 s of context time).
const SCENARIO_DEADLINE = 12;
// Seconds. Scheduled note times against the tempo map. The library adds tick
// durations in double precision; the measured largest difference is recorded
// in docs/improvements/tasks/T6.md (phase B.1). A wrong tempo is off by >= 0.1 s.
const TIME_TOL = 1e-6;

/* A one-operator sine timbre for program 0: one source per note, released in 20 ms. */
const SINE = [{ w: "sine", v: 0.5, a: 0, d: 0, s: 1, r: 0.02 }];
const SQUARE = [{ w: "square", v: 0.3, a: 0, d: 0, s: 1, r: 0.02 }];

/* Page harness, inlined after the library. */
/* eslint-disable no-undef -- runs in the page */
const HARNESS = function () {
  "use strict";
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  function bytes(b64) {
    var bin = window.atob(b64), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; ++i) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }
  /*
   * run(spec) resolves with the records. spec:
   *   options     constructor options
   *   timbres     [[m, n, timbre], ...] for setTimbre
   *   steps       [{when, ops}], run in order. when: "now" (at once), {flip: n}
   *               (in the tick where play goes 1 -> 0 for the n-th time),
   *               {after: s} (s seconds of context time after the previous
   *               step), {curTick: k} (play is 1 and curTick >= k).
   *               ops: [{call, args}] or [{load: base64}]; an argument
   *               {rel: x} is replaced by the context's currentTime + x.
   *               The last step's ops may be empty: it ends the run.
   *   maxSeconds  end the run (timedOut) after this much context time
   */
  window.__t6tr = {
    run: async function (spec) {
      var RealSetInterval = window.setInterval, onTick = null, schedulers = 0;
      window.setInterval = function (fn, ms) {
        if (ms === 60) {
          ++schedulers;
          var inner = fn;
          fn = function () {
            phase = "tick";
            inner.apply(this, arguments);
            phase = "idle";
            if (onTick) onTick();
          };
        }
        return RealSetInterval.call(window, fn, ms);
      };
      var synth;
      try { synth = new WebAudioTinySynth(spec.options || {}); } finally { window.setInterval = RealSetInterval; }
      if (schedulers !== 1) throw new Error("expected one 60 ms scheduler interval, saw " + schedulers);
      var ctx = synth.getAudioContext();
      await Promise.race([ctx.resume(), wait(5000)]);
      if (ctx.state !== "running") throw new Error("the realtime context is " + ctx.state);
      (spec.timbres || []).forEach(function (tb) { synth.setTimbre(tb[0], tb[1], JSON.parse(JSON.stringify(tb[2]))); });

      // seq orders every recorded source, stop() call and operation.
      var phase = "idle", seq = 0, sources = [], params = [], ops = [], flips = [];
      // Strong references to every wrapped node and AudioParam. WebKit can collect
      // an unreferenced JS wrapper and create a new one, without the instance
      // wrappers, on the next access (seen with node.gain).
      var keep = window.__t6tr.keep = [];
      ["createOscillator", "createBufferSource"].forEach(function (name) {
        var real = ctx[name];
        ctx[name] = function () {
          var node = real.apply(ctx, arguments);
          keep.push(node);
          var rec = { seq: seq++, kind: name === "createOscillator" ? "osc" : "buffer", created: ctx.currentTime, createdIn: phase, start: null, stops: [] };
          sources.push(rec);
          var realStart = node.start, realStop = node.stop;
          node.start = function (when) {
            rec.start = when === undefined ? 0 : when;
            rec.freq = node.frequency ? node.frequency.value : node.playbackRate.value;
            rec.detune = node.detune ? node.detune.value : null;
            rec.wave = node.type || "buffer";
            return realStart.apply(node, arguments);
          };
          node.stop = function (when) {
            rec.stops.push({ seq: seq++, when: when === undefined ? null : when, at: ctx.currentTime, phase: phase });
            return realStop.apply(node, arguments);
          };
          return node;
        };
      });
      var methods = ["setValueAtTime", "linearRampToValueAtTime", "exponentialRampToValueAtTime", "setTargetAtTime", "setValueCurveAtTime", "cancelScheduledValues", "cancelAndHoldAtTime"];
      function watch(name, param) {
        if (!param) return;
        keep.push(param);
        params.push({ seq: seq++, param: name, m: "initial", v: param.value, t: null, at: ctx.currentTime, phase: phase });
        methods.forEach(function (m) {
          var real = param[m];
          if (typeof real !== "function") return;
          param[m] = function (a, b) {
            params.push({ seq: seq++, param: name, m: m, v: m.indexOf("cancel") === 0 ? null : a, t: m.indexOf("cancel") === 0 ? a : b, at: ctx.currentTime, phase: phase });
            return real.apply(param, arguments);
          };
        });
        var desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(param), "value");
        Object.defineProperty(param, "value", {
          configurable: true,
          get: function () { return desc.get.call(param); },
          set: function (v) { params.push({ seq: seq++, param: name, m: "value", v: v, t: null, at: ctx.currentTime, phase: phase }); desc.set.call(param, v); },
        });
      }
      watch("vol", synth.chvol[0].gain);
      watch("pan", synth.chpan[0] && synth.chpan[0].pan);
      watch("mod", synth.chmod[0].gain);

      function arg(a) { return a && typeof a === "object" && "rel" in a ? ctx.currentTime + a.rel : a; }
      function runOps(list, label) {
        list.forEach(function (op) {
          var name = op.load ? "loadMIDI" : op.call, args = (op.args || []).map(arg);
          var before = sources.length, rec = { seq: seq++, phase: label + ":" + name, op: name, args: args, at: ctx.currentTime };
          phase = rec.phase;
          if (op.load) synth.loadMIDI(bytes(op.load)); else synth[op.call].apply(null, args);
          phase = "idle";
          var st = synth.getPlayStatus();
          rec.status = { play: st.play, maxTick: st.maxTick, curTick: st.curTick };
          rec.playTime = synth.playTime; // the time of the pass's first event after playMIDI() (D-005: currentTime + 0.1 s)
          rec.sourcesCreated = sources.length - before;
          ops.push(rec);
        });
      }
      var steps = spec.steps.slice(), stepIndex = 0, lastStepAt = ctx.currentTime, prevPlay = synth.getPlayStatus().play, flipCount = 0;
      var started = ctx.currentTime, finish;
      var done = new Promise(function (r) { finish = r; });
      function result(timedOut) {
        onTick = null;
        var st = synth.getPlayStatus();
        finish({ timedOut: timedOut, sources: sources, params: params, ops: ops, flips: flips, status: { play: st.play, maxTick: st.maxTick, curTick: st.curTick }, end: ctx.currentTime, rejections: window.__t6.rejections.slice() });
      }
      function advance(event) {
        while (steps.length) {
          var s = steps[0], w = s.when, go = false;
          if (w === "now") go = true;
          else if (w.flip) go = event === "flip" && flipCount === w.flip;
          else if (w.after !== undefined) go = ctx.currentTime >= lastStepAt + w.after;
          else if (w.curTick !== undefined) { var st = synth.getPlayStatus(); go = st.play && st.curTick >= w.curTick; }
          if (!go) return;
          steps.shift();
          lastStepAt = ctx.currentTime;
          runOps(s.ops || [], "step" + stepIndex++);
          if (!steps.length) { result(false); return; }
          event = null;
        }
      }
      onTick = function () {
        var play = synth.getPlayStatus().play;
        if (prevPlay && !play) { ++flipCount; flips.push(ctx.currentTime); prevPlay = play; advance("flip"); }
        else { prevPlay = play; advance(null); }
        if (onTick && ctx.currentTime - started > spec.maxSeconds) result(true);
      };
      advance(null);
      return done;
    },
  };
};
/* eslint-enable no-undef */

/* ---- songs and their independent timing ---- */

const PPQ = 480;
const on = (n, ch = 0) => [0x90 | ch, n, 100];
const off = (n, ch = 0) => [0x80 | ch, n, 0];
const tempo = (bpm) => { const us = Math.round(60e6 / bpm); return [0xff, 0x51, 3, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff]; };
/* events: [[tick, bytes], ...] in tick order; returns a format-0 file. */
function song(events) {
  let last = 0;
  return smf.write({ format: 0, division: PPQ, tracks: [events.map(([tick, bytes]) => { const dt = tick - last; last = tick; return { dt, bytes }; })] });
}
const b64 = (buf) => buf.toString("base64");

/* Seconds from tick 0 to `tick`, from the file's tempo events (120 BPM before the first). */
function seconds(file, tick) {
  const r = smf.read(file);
  const tempos = r.tempos.slice().sort((a, b) => a.tick - b.tick);
  let s = 0, at = 0, us = 500000;
  for (const tp of tempos) {
    if (tp.tick >= tick) break;
    s += (tp.tick - at) * us / 1e6 / r.division;
    at = tp.tick;
    us = tp.usPerQuarter;
  }
  return s + (tick - at) * us / 1e6 / r.division;
}

/* Note-on ticks of a file (velocity > 0), in order. */
function noteTicks(file) {
  const r = smf.read(file);
  return r.tracks.flatMap((tr) => tr.events.filter((e) => (e.status & 0xf0) === 0x90 && e.data[1] > 0).map((e) => e.tick)).sort((a, b) => a - b);
}

/* Notes (sources started with a nonzero frequency; the start-up oscillator has 0). */
const notes = (r) => r.sources.filter((s) => s.start !== null && s.freq !== 0);
const opAt = (r, name, k = 0) => r.ops.filter((o) => o.op === name)[k];
const fmt = (x) => Number(x).toFixed(9);

const SONGS = {
  // #8: every event at tick 0 (maxTick 0).
  tick0: song([[0, on(69)], [0, off(69)]]),
  // #8: every event at tick 480.
  tick480: song([[480, on(69)], [480, off(69)]]),
  // #9: nothing but End-of-Track; a tempo event alone at tick 0.
  empty: smf.write({ format: 0, division: PPQ, tracks: [[]] }),
  tempoOnly: song([[0, tempo(100)]]),
  // #10: 120 BPM (no tempo event at tick 0), then 240 BPM from tick 960.
  replay: song([[0, on(69)], [240, off(69)], [480, on(69)], [720, off(69)], [960, tempo(240)], [960, on(69)], [1200, off(69)], [1440, on(69)], [1680, off(69)]]),
  // D-019 / F11: the last note (A5) is held from tick 1440 to 1920, the song's end.
  held: song([[0, on(69)], [240, off(69)], [480, on(69)], [720, off(69)], [960, on(69)], [1200, off(69)], [1440, on(81)], [1920, off(81)]]),
};

/*
 * Runs one scenario in a fresh page under the external deadline. Returns the
 * records, or null after a failed check (no return, an exception in the page).
 */
async function scenario(t, build, spec, label) {
  const { server, options } = t.shared;
  const pageId = "transport-" + build;
  server.registerPage(pageId, pages.inlinePage({ library: pages.readLibrary(build, options.overrides), seed: options.seed, after: ["(" + HARNESS.toString() + ")();"] }));
  if (t.isAbandoned()) return null;
  const p = await t.newPage();
  await p.page.goto(server.origin + "/html/" + pageId);
  const full = Object.assign({ options: { quality: 1, useReverb: 0 }, timbres: [[0, 0, SINE]], maxSeconds: 8 }, spec);
  const r = await withTimeout(p.page.evaluate((s) => window.__t6tr.run(s), full), SCENARIO_DEADLINE * 1000); // eslint-disable-line no-undef -- runs in the page
  const tag = label ? label + ": " : "";
  if (!t.check(tag + "the scenario returned within the " + SCENARIO_DEADLINE + " s deadline", r.ok,
    r.timedOut ? "no return (a scheduler or page hang); the page is closed by the case cleanup" : r.ok ? "" : short(r.error))) return null;
  if (!t.check(tag + "the scenario reached its last step", !r.value.timedOut, r.value.timedOut ? "steps left after " + full.maxSeconds + " s; status " + JSON.stringify(r.value.status) : "")) return null;
  t.check(tag + "no page error", !p.pageErrors.length, p.pageErrors.join(" | "));
  return r.value;
}

function cases(shared) {
  const { matrix } = shared;
  const out = [];
  for (const build of matrix.builds) {
    const add = (name, run) => out.push({ id: "transport " + build + " " + name, dims: { build }, run: (t) => run(t, build) });

    // #8: zero-duration loops.
    for (const [key, label, tick] of [["tick0", "every event at tick 0", 0], ["tick480", "every event at tick 480", 480]]) {
      add("#8 looped song with " + label + " plays once and stops", async (t) => {
        const r = await scenario(t, build, {
          steps: [{ when: "now", ops: [{ load: b64(SONGS[key]) }, { call: "setLoop", args: [1] }, { call: "playMIDI" }] }, { when: { after: 0.6 } }],
        });
        if (!r) return;
        t.check("stopped at the end: {play: 0, curTick: maxTick (" + tick + ")}", r.status.play === 0 && r.status.curTick === tick && r.status.maxTick === tick, JSON.stringify(r.status));
        const n = notes(r);
        t.check("the one note played once", n.length === 1 && Math.abs(n[0].start - opAt(r, "playMIDI").playTime) <= TIME_TOL, n.length + " notes at " + n.map((x) => fmt(x.start)).join(", ") + "; pass start " + fmt(opAt(r, "playMIDI").playTime));
      });
    }
    add("#8 a padded loopEnd (480) keeps a tick-0 song looping every 480 ticks", async (t) => {
      const r = await scenario(t, build, {
        steps: [{ when: "now", ops: [{ load: b64(SONGS.tick0) }, { call: "setLoopEnd", args: [480] }, { call: "setLoop", args: [1] }, { call: "playMIDI" }] }, { when: { after: 1.8 } }],
      });
      if (!r) return;
      const period = seconds(SONGS.tick0, 480) - seconds(SONGS.tick0, 0); // 0.5 s at 120 BPM
      const n = notes(r), first = opAt(r, "playMIDI").playTime;
      const worst = Math.max(...n.map((x, i) => Math.abs(x.start - (first + i * period))));
      t.check("still playing after 1.8 s", r.status.play === 1, JSON.stringify(r.status));
      t.check("at least 4 passes, one note every " + period + " s from the pass start (tempo map)", n.length >= 4 && worst <= TIME_TOL, n.length + " notes; largest difference " + worst.toExponential(2) + " s; starts " + n.map((x) => fmt(x.start - first)).join(", "));
      t.observe("largest timing difference (s)", worst);
    });

    // #9: songs with nothing to play.
    for (const key of ["empty", "tempoOnly"]) {
      for (const loop of [0, 1]) {
        add("#9 " + (key === "empty" ? "an empty song" : "a tempo-only song") + " stays stopped (loop " + loop + ")", async (t) => {
          const r = await scenario(t, build, {
            steps: [{ when: "now", ops: [{ load: b64(SONGS[key]) }, { call: "setLoop", args: [loop] }, { call: "playMIDI" }] }, { when: { after: 0.4 } }],
          });
          if (!r) return;
          const load = opAt(r, "loadMIDI"), play = opAt(r, "playMIDI");
          t.check("playMIDI() leaves the status unchanged and creates no node", play.status.play === 0 && JSON.stringify(play.status) === JSON.stringify(load.status) && play.sourcesCreated === 0 && r.sources.length === 0,
            "after load " + JSON.stringify(load.status) + ", after playMIDI " + JSON.stringify(play.status) + ", sources created " + r.sources.length);
          t.check("still stopped 0.4 s later, no note played", r.status.play === 0 && notes(r).length === 0, JSON.stringify(r.status) + ", " + notes(r).length + " notes");
        });
      }
    }

    // #10: replay timing.
    add("#10 a replay of a completed song keeps the first pass's note times (tempo map)", async (t) => {
      const r = await scenario(t, build, {
        steps: [
          { when: "now", ops: [{ load: b64(SONGS.replay) }, { call: "playMIDI" }] },
          { when: { flip: 1 } }, { when: { after: 0.3 }, ops: [{ call: "playMIDI" }] }, { when: { flip: 2 } }, { when: { after: 0.2 } },
        ],
      });
      if (!r) return;
      const ticks = noteTicks(SONGS.replay), exp = ticks.map((k) => seconds(SONGS.replay, k) - seconds(SONGS.replay, ticks[0]));
      const n = notes(r), o1 = opAt(r, "playMIDI", 0).playTime, o2 = opAt(r, "playMIDI", 1).playTime;
      const pass = (o) => n.filter((x) => x.start >= o - TIME_TOL && x.start < o + exp[exp.length - 1] + 0.05).map((x) => x.start - o);
      const p1 = pass(o1), p2 = pass(o2);
      const diff = (p) => p.length === exp.length ? Math.max(...p.map((x, i) => Math.abs(x - exp[i]))) : Infinity;
      t.check("the first pass and the replay both play on the tempo map (" + exp.join(", ") + " s; 120 BPM until tick 960)", diff(p1) <= TIME_TOL && diff(p2) <= TIME_TOL,
        "first pass " + p1.map(fmt).join(", ") + "; replay " + p2.map(fmt).join(", "));
      t.observe("largest timing difference (s)", Math.max(diff(p1), diff(p2)));
    });

    // D-019 and F11: a replay in the tick where the song ends.
    const heldTicks = noteTicks(SONGS.held), lastOn = heldTicks[heldTicks.length - 1];
    const heldOff = seconds(SONGS.held, 1920) - seconds(SONGS.held, 0);
    add("#10 (D-019) a replay as the song ends keeps the previous pass's notes", async (t) => {
      const r = await scenario(t, build, {
        steps: [
          { when: "now", ops: [{ load: b64(SONGS.held) }, { call: "playMIDI" }] },
          { when: { flip: 1 }, ops: [{ call: "playMIDI" }] }, { when: { after: 0.8 } },
        ],
      });
      if (!r) return;
      const replay = opAt(r, "playMIDI", 1), o1 = opAt(r, "playMIDI", 0).playTime;
      const prev = notes(r).filter((x) => x.seq < replay.seq);
      const stoppedByReplay = prev.filter((x) => x.stops.some((s) => s.phase === replay.phase));
      t.check("the replay stopped none of the previous pass's notes", prev.length === heldTicks.length && !stoppedByReplay.length,
        prev.length + " previous notes, stopped by the replay: " + stoppedByReplay.map((x) => fmt(x.start - o1)).join(", "));
      const last = prev.find((x) => Math.abs(x.start - o1 - (seconds(SONGS.held, lastOn) - seconds(SONGS.held, 0))) <= TIME_TOL);
      const cut = last && last.stops.find((s) => (s.when === null ? s.at : s.when) < o1 + heldOff);
      t.check("the previous pass's last note (A5, ticks " + lastOn + "-1920) sounds until its note-off", last && !cut,
        !last ? "not found" : cut ? "stopped at " + fmt((cut.when === null ? cut.at : cut.when) - o1) + " s, note-off at " + fmt(heldOff) + " s (" + cut.phase + ")"
          : "note-off at " + fmt(heldOff) + " s; first stop() at " + (last.stops.length ? fmt((last.stops[0].when === null ? last.stops[0].at : last.stops[0].when) - o1) + " s (" + last.stops[0].phase + ")" : "none yet"));
    });
    add("F11 a seek right after a replay as the song ends stops the previous pass's notes", async (t) => {
      const r = await scenario(t, build, {
        steps: [
          { when: "now", ops: [{ load: b64(SONGS.held) }, { call: "playMIDI" }] },
          { when: { flip: 1 }, ops: [{ call: "playMIDI" }, { call: "locateMIDI", args: [0] }] }, { when: { after: 0.3 } },
        ],
      });
      if (!r) return;
      const replay = opAt(r, "playMIDI", 1), seek = opAt(r, "locateMIDI");
      // Previous-pass notes with no stop() call before the seek: still sounding (or about to) when it runs.
      const sounding = notes(r).filter((x) => x.seq < replay.seq && !x.stops.some((s) => s.seq < seek.seq));
      const missed = sounding.filter((x) => !x.stops.some((s) => s.phase === seek.phase));
      t.check("the seek stopped every previous-pass note still sounding, including the held A5", sounding.some((x) => Math.abs(x.freq - 880) < 1e-3) && !missed.length,
        sounding.length + " sounding (" + sounding.map((x) => x.freq.toFixed(1) + " Hz").join(", ") + "), not stopped by the seek: " + missed.length);
    });
  }
  return out;
}

module.exports = { cases, scenario, SONGS, song, seconds, noteTicks, notes, opAt, b64, on, off, tempo, PPQ, SINE, SQUARE, TIME_TOL, fmt };
