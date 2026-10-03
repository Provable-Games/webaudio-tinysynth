/*
 * Lifecycle (#11, #12) under the D-018 contract (tasks/T4.md): constructor
 * options, lazy start, resume(), dispose(), context replacement, percussion
 * tracking (D-019) and the OfflineAudioContext rules, on the mock WebAudio of
 * tests/harness.js.
 *
 * The mock's stop() does not end nodes, so cleanup is read from the recorded
 * calls: every source the synth started has a stop() call, and no connection
 * made by the synth is left. The browser specs check real nodes.
 */
import vm from "node:vm";
import { describe, expect, test } from "vitest";
import { H, variants } from "./helpers.mjs";

const PPQ = 480;
const { noteOn, noteOff } = H.midi;
const cc = (tick, ch, n, v) => ({ tick, bytes: [0xb0 | ch, n, v] });
const program = (tick, ch, p) => ({ tick, bytes: [0xc0 | ch, p] });
const calls = (trace, from = 0) => trace.slice(from).map((line) => JSON.parse(line));
const flush = () => new Promise((resolve) => setImmediate(resolve));
const song = (events) => H.toArrayBuffer(H.makeMidi(PPQ, events));

/* The error `fn` throws (from the library's realm, so compared by name and code), or null. */
function thrown(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}

/* `promise` settled: ["resolved", value] or ["rejected", error]. */
const settle = (promise) => promise.then((v) => ["resolved", v], (e) => ["rejected", e]);

/*
 * A fresh mock environment with `variant` loaded. `made` lists the contexts
 * the library constructs; `Base` is the mock context class (contexts made by
 * a test are not counted); `Offline` is a mock OfflineAudioContext (it has
 * startRendering() and starts suspended, as a real one does before rendering).
 * ended() does what a browser does and the mock does not: it fires `ended` on
 * every source whose stop time has passed.
 */
function load(variant) {
  const trace = [];
  const env = H.createEnvironment(trace);
  vm.runInContext(variant.source, env.sandbox, { filename: variant.name });
  const Base = env.sandbox.AudioContext;
  const sources = [];
  for (const m of ["createOscillator", "createBufferSource"]) {
    const create = Base.prototype[m];
    Base.prototype[m] = function () {
      const node = create.call(this);
      const stop = node.stop;
      node.stop = (t) => {
        node.endsAt = t === undefined ? env.clock.ms / 1000 : t;
        return stop.call(node, t);
      };
      sources.push(node);
      return node;
    };
  }
  const ended = () => {
    for (const n of sources) {
      if (!n.done && n.endsAt <= env.clock.ms / 1000) {
        n.done = true;
        if (n.onended) n.onended();
      }
    }
  };
  const made = [];
  env.sandbox.AudioContext = class extends Base {
    constructor() {
      super();
      made.push(this);
    }
  };
  class Offline extends Base {
    constructor() {
      super();
      this.state = "suspended";
    }
    startRendering() {}
  }
  return { env, trace, made, Base, Offline, ended, Synth: env.sandbox.WebAudioTinySynth };
}

/* A synth built with `opts` in a fresh environment; every _note call is recorded in `notes`. */
function make(variant, opts) {
  const l = load(variant);
  const synth = new l.Synth(opts);
  const notes = [];
  const note = synth._note;
  synth._note = (...a) => {
    notes.push(a);
    return note(...a);
  };
  return { ...l, synth, notes };
}

/* Connections the recorded calls leave in place, as [from, to] ids (a parameter is "node.param"). */
function liveEdges(trace) {
  const live = [];
  for (const [op, from, to] of calls(trace)) {
    if (op === "connect") live.push([from, to]);
    else if (op === "disconnect")
      for (let i = live.length - 1; i >= 0; --i) if (live[i][0] === from && (to === null || live[i][1] === to)) live.splice(i, 1);
  }
  return live;
}

/* Sources started in the trace that still play after time `now`: no stop() now, and no stop time at or before `now`. */
function playing(trace, now) {
  const started = new Set(), stopped = new Set();
  for (const [op, id, t] of calls(trace)) {
    if (op === "start") started.add(id);
    if (op === "stop" && (t === null || t <= now)) stopped.add(id);
  }
  return [...started].filter((id) => !stopped.has(id));
}

const ids = (voice) => voice.o.map((n) => n._id).concat(voice.g.map((n) => n._id));
const synthIntervals = (env) => [...env.timers.values()].filter((t) => t.ms === 60);

/* A song with melodic notes (one held by the sustain pedal, one released), drums, and a late crash cymbal. */
const MIXED = song([
  program(0, 0, 0), cc(0, 1, 64, 127),
  noteOn(0, 0, 60, 100), noteOff(240, 0, 60),
  noteOn(0, 1, 64, 100), noteOff(240, 1, 64),
  noteOn(0, 9, 36, 100), noteOn(480, 9, 38, 100), noteOn(1200, 9, 38, 100), noteOn(1440, 9, 49, 100),
  noteOn(960, 2, 67, 100), noteOff(3840, 2, 67),
]);

/* Play MIXED until its crash cymbal (1.5 s into the song) is scheduled ahead, in the 0.2 s lookahead. */
function playUntilDrumAhead(s) {
  const start = s.env.clock.ms / 1000 + 0.1;
  s.synth.loadMIDI(MIXED);
  s.synth.playMIDI();
  const ahead = () => s.synth._src.some((v) => v.ch === 9 && v.t > s.env.clock.ms / 1000 && v.t >= start + 1.5);
  if (!H.runUntil(s.env, ahead, 10000)) throw new Error("no drum hit was scheduled ahead");
}

describe.each(variants)("$name: constructor options (#12)", (variant) => {
  test("default construction is unchanged: one internal context, the 60 ms interval, ready()", async () => {
    const s = make(variant);
    expect(s.made).toHaveLength(1);
    expect(s.synth.getAudioContext()).toBe(s.made[0]);
    expect(synthIntervals(s.env)).toHaveLength(1);
    expect(s.synth.isReady).toBe(1);
    const ready = s.synth.ready();
    s.env.step(); s.env.step();
    expect(await settle(ready)).toEqual(["resolved", undefined]);
    // The constructor makes no teardown, close or resume call.
    expect(calls(s.trace).filter(([op]) => ["disconnect", "close", "resume"].includes(op))).toEqual([]);
  });

  test("context: null or undefined, and destination: undefined, keep the default", () => {
    for (const opts of [{ context: null }, { context: undefined, destination: undefined }, { lazy: false }]) {
      const s = make(variant, opts);
      expect(s.made).toHaveLength(1);
    }
  });

  test("invalid options throw a TypeError before any context, node or timer is created", () => {
    const l = load(variant);
    const ctx = new l.Base(), other = new l.Base();
    const otherNode = Object.assign(other.createGain(), { context: other });
    const cases = [
      { context: 1 }, { context: "audio" }, { context: {} }, { context: { createGain() {} } }, { context: ctx.createGain() },
      { destination: ctx.destination }, { context: ctx, destination: {} }, { context: ctx, destination: ctx.createGain().gain },
      { context: ctx, destination: otherNode }, { lazy: 1 }, { lazy: "yes" }, { lazy: true, context: ctx },
    ];
    const from = l.trace.length;
    for (const opts of cases) {
      const e = thrown(() => new l.Synth(opts));
      expect(e && e.name, JSON.stringify(Object.keys(opts))).toBe("TypeError");
    }
    expect(l.made).toHaveLength(0);
    expect(l.env.timers.size).toBe(0);
    expect(l.trace.slice(from)).toEqual([]);
  });

  test("an injected context: no internal context, the same graph, routed to its destination", () => {
    const viaDefault = make(variant);
    const l = load(variant);
    const ctx = new l.Base();
    const synth = new l.Synth({ context: ctx });
    expect(l.made).toHaveLength(0);
    expect(synth.getAudioContext()).toBe(ctx);
    // The injected context gets exactly the graph (and warm-up note) the internal one gets.
    expect(l.trace).toEqual(viaDefault.trace);
    expect(liveEdges(l.trace)).toContainEqual([synth.comp._id, ctx.destination._id]);
  });

  test("an injected destination receives the output instead of context.destination", () => {
    const l = load(variant);
    const ctx = new l.Base();
    const dest = ctx.createGain();
    const synth = new l.Synth({ context: ctx, destination: dest });
    const edges = liveEdges(l.trace);
    expect(edges).toContainEqual([synth.comp._id, dest._id]);
    expect(edges.filter(([, to]) => to === ctx.destination._id)).toEqual([]);
  });

  test("other options still apply with an injected context", () => {
    const l = load(variant);
    const synth = new l.Synth({ context: new l.Base(), quality: 0, useReverb: 0, voices: 8 });
    expect([synth.quality, synth.useReverb, synth.voices, synth.conv]).toEqual([0, 0, 8, undefined]);
  });
});

describe.each(variants)("$name: lazy start (#12)", (variant) => {
  const SETTINGS = (synth) => {
    synth.setQuality(0); synth.setTimbre(0, 1, [{ w: "square", v: 0.3 }]); synth.setMasterVol(0.3); synth.setReverbLev(0.2);
    synth.setVoices(32); synth.setLoop(1); synth.setLoopEnd(960); synth.setTsMode(0);
    synth.getPlayStatus(); synth.getTimbreName(0, 1); synth.getAudioContext();
    synth.stopMIDI(); synth.noteOff(0, 60); synth.allSoundOff(0); synth.resetAllControllers(0);
  };

  test("creates no context and no node before first use; settings and getters do not create it", () => {
    const s = make(variant, { lazy: true });
    expect(s.synth.getAudioContext()).toBe(null);
    SETTINGS(s.synth);
    s.synth.ready();
    expect(s.made).toHaveLength(0);
    expect(s.trace).toEqual([]);
    expect(s.synth.getAudioContext()).toBe(null);
  });

  test("resume() creates the context inside the call and installs the default graph", async () => {
    const viaDefault = make(variant);
    const s = make(variant, { lazy: true });
    const p = s.synth.resume();
    expect(s.made).toHaveLength(1); // synchronously, so inside a click handler
    expect(await settle(p)).toEqual(["resolved", undefined]);
    expect(s.trace).toEqual(viaDefault.trace);
    expect(s.synth.getAudioContext()).toBe(s.made[0]);
  });

  test("settings made before the context exists apply to its graph", async () => {
    const s = make(variant, { lazy: true, useReverb: 0, quality: 0 });
    s.synth.setMasterVol(0.3);
    s.synth.setReverbLev(0.2);
    await s.synth.resume();
    expect([s.synth.out.gain.value, s.synth.conv, s.synth.quality]).toEqual([0.3, undefined, 0]);
    const r = make(variant, { lazy: true });
    r.synth.setReverbLev(0.2);
    await r.synth.resume();
    expect(r.synth.rev.gain.value).toBeCloseTo(1.6, 12);
  });

  test.each(["send", "noteOn", "setProgram", "setBendRange", "setBend", "setSustain", "setModulation", "setChVol", "setPan",
    "setExpression", "loadMIDI", "locateMIDI", "playMIDI"])("%s() is a first use: it creates the context once", (name) => {
    const s = make(variant, { lazy: true });
    const args = { send: [[0x90, 60, 100]], noteOn: [0, 60, 100], loadMIDI: [MIXED] }[name] || [0, 64, 0];
    s.synth[name](...args);
    s.synth[name](...args);
    expect(s.made).toHaveLength(1);
  });

  test("channel state set before the first note is kept: program 40 plays", () => {
    const s = make(variant, { lazy: true });
    s.synth.send([0xc0, 40]);
    s.synth.noteOn(0, 60, 100);
    expect(s.synth.pg[0]).toBe(40);
    expect(s.notes.at(-1)[4]).toBe(s.synth.program[40].p);
  });

  test("a song loaded and sought before the first play keeps the sought state", () => {
    const s = make(variant, { lazy: true });
    s.synth.loadMIDI(song([program(0, 0, 10), program(480, 0, 20), noteOn(960, 0, 60, 100), noteOff(1200, 0, 60)]));
    s.synth.locateMIDI(900);
    s.synth.playMIDI();
    H.runUntil(s.env, () => s.synth.getPlayStatus().play === 0, 10000);
    expect(s.synth.pg[0]).toBe(20);
    expect(s.notes.at(-1)[4]).toBe(s.synth.program[20].p);
  });

  test("dispose() before first use creates nothing and clears the interval", async () => {
    const s = make(variant, { lazy: true });
    expect(await settle(s.synth.dispose())).toEqual(["resolved", undefined]);
    expect(s.made).toHaveLength(0);
    expect(s.env.timers.size).toBe(0);
    expect(s.trace).toEqual([]);
    expect((await settle(s.synth.resume()))[1].code).toBe("SYNTH_DISPOSED");
    expect(s.made).toHaveLength(0);
  });
});

describe.each(variants)("$name: resume() (#12)", (variant) => {
  test("on a running context resolves without calling context.resume()", async () => {
    const s = make(variant);
    const from = s.trace.length;
    expect(await settle(s.synth.resume())).toEqual(["resolved", undefined]);
    expect(s.trace.slice(from)).toEqual([]);
  });

  test("on a suspended context calls context.resume() at once and resolves when it does", async () => {
    const s = make(variant);
    const ctx = s.synth.getAudioContext();
    ctx.state = "suspended";
    let start;
    ctx.resume = () => new Promise((resolve) => { start = () => { ctx.state = "running"; resolve(); }; });
    const p = settle(s.synth.resume());
    expect(start).toBeTypeOf("function"); // called synchronously, inside the gesture
    let done = false;
    p.then(() => { done = true; });
    await flush();
    expect(done).toBe(false);
    start();
    expect(await p).toEqual(["resolved", undefined]);
  });

  test("WebKit's interrupted state is resumed too", async () => {
    const s = make(variant);
    const ctx = s.synth.getAudioContext();
    ctx.state = "interrupted";
    const from = s.trace.length;
    await s.synth.resume();
    expect(calls(s.trace, from)).toEqual([["resume"]]);
  });

  test("rejects with the context's own error", async () => {
    const s = make(variant);
    const ctx = s.synth.getAudioContext();
    const error = new Error("not allowed");
    ctx.state = "suspended";
    ctx.resume = () => Promise.reject(error);
    expect(await settle(s.synth.resume())).toEqual(["rejected", error]);
  });

  test("a closed context rejects with code AUDIO_CONTEXT_CLOSED and is not resumed", async () => {
    const s = make(variant);
    s.synth.getAudioContext().state = "closed";
    const from = s.trace.length;
    const [state, e] = await settle(s.synth.resume());
    expect([state, e.code, e.message]).toEqual(["rejected", "AUDIO_CONTEXT_CLOSED", "AUDIO_CONTEXT_CLOSED: the AudioContext is closed"]);
    expect(s.trace.slice(from)).toEqual([]);
  });

  test("an OfflineAudioContext resolves without action", async () => {
    const l = load(variant);
    const ctx = new l.Offline();
    const synth = new l.Synth({ context: ctx });
    const from = l.trace.length;
    expect(await settle(synth.resume())).toEqual(["resolved", undefined]);
    expect(l.trace.slice(from)).toEqual([]);
  });

  test("works detached, with dispose()", async () => {
    const s = make(variant);
    const { resume, dispose } = s.synth;
    expect(await settle(resume())).toEqual(["resolved", undefined]);
    expect(await settle(dispose())).toEqual(["resolved", undefined]);
    expect((await settle(resume()))[1].code).toBe("SYNTH_DISPOSED");
  });
});

describe.each(variants)("$name: send()'s resume (#12, T3 review F9)", (variant) => {
  /* A synth on a suspended context whose resume() is counted and answered by `answer`. */
  function suspended(answer) {
    const s = make(variant);
    const ctx = s.synth.getAudioContext();
    ctx.state = "suspended";
    s.asked = 0;
    ctx.resume = () => {
      ++s.asked;
      return answer();
    };
    return s;
  }
  const STATEFUL = song([
    ...[0, 1, 2, 3, 4, 5].flatMap((ch) => [program(0, ch, 10 + ch), cc(0, ch, 7, 90), cc(0, ch, 10, 30), cc(0, ch, 11, 100), cc(0, ch, 1, 20)]),
    noteOn(960, 0, 60, 100), noteOff(1200, 0, 60),
  ]);

  test("a seek replaying 30 events asks once; a later task asks again", async () => {
    const s = suspended(() => new Promise(() => {})); // Chromium leaves it pending without user activation
    s.synth.loadMIDI(STATEFUL);
    s.synth.locateMIDI(960);
    expect(s.asked).toBe(1);
    await flush();
    s.synth.send([0xb0, 7, 100]);
    expect(s.asked).toBe(2); // so a send() after a gesture can still start the context
  });

  test("rejections are handled: no unhandled rejection", async () => {
    const unhandled = [];
    const listener = (e) => unhandled.push(e);
    process.on("unhandledRejection", listener);
    try {
      const s = suspended(() => Promise.reject(new Error("blocked")));
      s.synth.loadMIDI(STATEFUL);
      for (let i = 0; i < 3; ++i) {
        s.synth.locateMIDI(960);
        s.synth.send([0x90, 60, 100]);
        await flush();
      }
      expect(s.asked).toBe(3);
      await flush();
    } finally {
      process.off("unhandledRejection", listener);
    }
    expect(unhandled).toEqual([]);
  });

  test("an interrupted context is asked; a running, closed or offline one is not", async () => {
    const s = suspended(() => Promise.resolve());
    const ctx = s.synth.getAudioContext();
    for (const [state, n] of [["interrupted", 1], ["running", 0], ["closed", 0]]) {
      s.asked = 0;
      ctx.state = state;
      s.synth.send([0x90, 60, 100]);
      await flush();
      expect([state, s.asked]).toEqual([state, n]);
    }
    const l = load(variant);
    const offline = new l.Offline();
    offline.resume = () => { throw new Error("an offline context must not be resumed"); };
    const synth = new l.Synth({ context: offline });
    synth.send([0x90, 60, 100], 1);
    synth.loadMIDI(STATEFUL);
    synth.locateMIDI(960);
  });
});

describe.each(variants)("$name: dispose() (#11)", (variant) => {
  test("returns the same promise every time, resolved after the owned context closes", async () => {
    const s = make(variant);
    const ctx = s.synth.getAudioContext();
    let close;
    ctx.close = () => new Promise((resolve) => { close = () => { ctx.state = "closed"; resolve(); }; });
    const p = s.synth.dispose();
    expect(s.synth.dispose()).toBe(p);
    let done = false;
    p.then(() => { done = true; });
    await flush();
    expect(done).toBe(false);
    close();
    expect(await settle(p)).toEqual(["resolved", undefined]);
    expect(s.synth.dispose()).toBe(p);
  });

  test("a failed close still resolves", async () => {
    const s = make(variant);
    s.synth.getAudioContext().close = () => Promise.reject(new Error("close failed"));
    expect(await settle(s.synth.dispose())).toEqual(["resolved", undefined]);
  });

  test("stops every source, disconnects every node, clears the timers and closes the owned context", async () => {
    const s = make(variant);
    const ctx = s.synth.getAudioContext();
    const pendingReady = settle(s.synth.ready());
    playUntilDrumAhead(s);
    const now = s.env.clock.ms / 1000;
    // Sounding and scheduled voices of every kind are present.
    expect(s.synth.notetab.some((v) => v.ch === 1 && v.f === 1)).toBe(true); // released under the pedal
    expect(s.synth.notetab.some((v) => v.ch === 2 && v.f === 0)).toBe(true); // held
    expect(s.synth._src.some((v) => v.ch === 9 && v.t <= now)).toBe(true); // a drum sounding
    expect(s.synth._src.some((v) => v.ch === 9 && v.t > now)).toBe(true); // a drum scheduled ahead
    s.ended(); // hits and the start-up oscillator that ended before now released their routes
    const callbacks = s.synth._src.flatMap((v) => v.o);
    expect(playing(s.trace, now).length).toBeGreaterThan(5);
    const from = s.trace.length;
    const p = s.synth.dispose();
    expect(playing(s.trace, now)).toEqual([]);
    expect(liveEdges(s.trace)).toEqual([]);
    expect(calls(s.trace, from).filter(([op]) => op === "close")).toEqual([["close"]]);
    expect(callbacks.every((o) => o.onended === null)).toBe(true);
    expect(s.env.timers.size).toBe(0);
    expect(await pendingReady).toEqual(["resolved", undefined]);
    await p;
    expect(ctx.state).toBe("closed");
    expect([s.synth.getAudioContext(), s.synth.notetab.length, s.synth._src.length, s.synth.chvol.length, s.synth.out]).toEqual([null, 0, 0, 0, null]);
    expect(s.synth.getPlayStatus().play).toBe(0);
  });

  test("a caller-owned context is torn down but left open", async () => {
    const l = load(variant);
    const ctx = new l.Base();
    const synth = new l.Synth({ context: ctx });
    synth.noteOn(0, 60, 100);
    synth.noteOn(9, 38, 100, 0.5);
    await synth.dispose();
    expect(ctx.state).toBe("running");
    expect(calls(l.trace).filter(([op, id]) => op === "close" || op !== "create" && id === ctx.destination._id)).toEqual([]);
    expect(liveEdges(l.trace)).toEqual([]);
    expect(playing(l.trace, l.env.clock.ms / 1000)).toEqual([]);
  });

  test("right after playMIDI(), the start-up oscillator is stopped and disconnected too", async () => {
    const s = make(variant);
    s.synth.loadMIDI(MIXED);
    s.synth.playMIDI();
    const [startup] = s.synth._src;
    expect(liveEdges(s.trace)).toContainEqual([startup.o[0]._id, s.synth.getAudioContext().destination._id]);
    await s.synth.dispose();
    expect(liveEdges(s.trace)).toEqual([]);
    expect(playing(s.trace, s.env.clock.ms / 1000)).toEqual([]);
  });

  test("an ended start-up oscillator disconnects itself", () => {
    const s = make(variant);
    s.synth.loadMIDI(MIXED);
    s.synth.playMIDI();
    const [startup] = s.synth._src;
    H.runUntil(s.env, () => !s.synth._src.includes(startup), 1000);
    s.ended();
    expect(liveEdges(s.trace).filter(([from]) => from === startup.o[0]._id)).toEqual([]);
  });

  test("cancels pending work: ready() resolves and each hook runs once, even after a failing one", async () => {
    const s = make(variant);
    const ran = [];
    s.synth._pend.add(() => { ran.push("a"); throw new Error("a canceller failed"); });
    s.synth._pend.add(() => ran.push("b"));
    const r = settle(s.synth.ready());
    await s.synth.dispose();
    await s.synth.dispose();
    expect(ran).toEqual(["a", "b"]);
    expect(await r).toEqual(["resolved", undefined]);
    expect(await settle(s.synth.ready())).toEqual(["resolved", undefined]);
  });

  test("afterwards every public method is a safe no-op, attached or detached", async () => {
    const s = make(variant);
    s.synth.loadMIDI(MIXED);
    s.synth.playMIDI();
    H.runUntil(s.env, () => false, 500);
    const other = new s.Base();
    const ARGS = {
      send: [[0x90, 60, 100]], noteOn: [0, 60, 100], noteOff: [0, 60], setProgram: [0, 5], setBendRange: [0, 0x200], setBend: [0, 9000],
      setSustain: [0, 127], setModulation: [0, 64], setChVol: [0, 90], setPan: [0, 20], setExpression: [0, 90], resetAllControllers: [0],
      allSoundOff: [0], reset: [], loadMIDI: [MIXED], locateMIDI: [480], playMIDI: [], stopMIDI: [], setMasterVol: [0.3],
      setReverbLev: [0.2], setQuality: [0], setTimbre: [0, 1, [{ w: "square", v: 0.3 }]], setLoop: [1], setLoopEnd: [960], setVoices: [32],
      setTsMode: [0], getPlayStatus: [], getAudioContext: [], getTimbreName: [0, 1], setAudioContext: [other], loadMIDIUrl: [],
      loadMIDIfromSrc: [], ready: [], resume: [], dispose: [],
    };
    const methods = Object.keys(s.synth).filter((k) => typeof s.synth[k] === "function" && k[0] !== "_" && k !== "init");
    expect(methods.filter((k) => !(k in ARGS))).toEqual([]);
    const detached = Object.fromEntries(methods.map((k) => [k, s.synth[k]]));
    await s.synth.dispose();
    const from = s.trace.length;
    const results = [];
    for (const fns of [s.synth, detached]) {
      for (const k of methods) {
        const r = fns[k](...ARGS[k]);
        if (r && typeof r.then === "function") results.push([k, (await settle(r))[0]]);
        else results.push([k, r === undefined ? "undefined" : typeof r]);
      }
    }
    expect(s.trace.slice(from)).toEqual([]);
    expect(s.env.timers.size).toBe(0);
    expect(s.synth.getAudioContext()).toBe(null);
    expect(s.synth.getPlayStatus()).toEqual({ play: 0, maxTick: 3840, curTick: expect.any(Number) });
    const byName = Object.fromEntries(results.slice(0, methods.length));
    expect(byName).toMatchObject({ ready: "resolved", resume: "rejected", dispose: "resolved", getPlayStatus: "object",
      getTimbreName: "string", playMIDI: "undefined", noteOn: "undefined", setAudioContext: "undefined" });
    expect(results.slice(methods.length)).toEqual(results.slice(0, methods.length));
  });

  test("a percussion callback that fires after dispose() does not throw", async () => {
    const s = make(variant);
    s.synth.noteOn(9, 38, 100);
    const [hit] = s.synth._src;
    const handlers = hit.o.map((o) => o.onended);
    H.runUntil(s.env, () => s.synth._src.length === 0, 10000); // ended: no longer tracked
    await s.synth.dispose();
    for (const f of handlers) expect(() => f()).not.toThrow();
  });
});

describe.each(variants)("$name: setAudioContext() replacement (#11)", (variant) => {
  test("tears down the previous graph and closes the context the synth created", () => {
    const s = make(variant);
    const old = s.synth.getAudioContext();
    playUntilDrumAhead(s);
    s.ended();
    const oldNodes = new Set(calls(s.trace).filter(([op]) => op === "create").map(([, id]) => id));
    const next = new s.Base();
    s.synth.setAudioContext(next);
    expect(old.state).toBe("closed");
    expect(liveEdges(s.trace).filter(([from]) => oldNodes.has(from))).toEqual([]);
    expect(playing(s.trace, s.env.clock.ms / 1000).filter((id) => oldNodes.has(id))).toEqual([]);
    expect(s.synth.getAudioContext()).toBe(next);
    expect(s.made).toHaveLength(1);
  });

  test("the new context is caller-owned: dispose() leaves it open", async () => {
    const s = make(variant);
    const next = new s.Base();
    s.synth.setAudioContext(next);
    await s.synth.dispose();
    expect(next.state).toBe("running");
    expect(liveEdges(s.trace)).toEqual([]);
  });

  test("a caller-owned previous context is not closed", () => {
    const l = load(variant);
    const first = new l.Base(), second = new l.Base();
    const synth = new l.Synth({ context: first });
    synth.setAudioContext(second);
    expect(first.state).toBe("running");
    expect(calls(l.trace).filter(([op]) => op === "close")).toEqual([]);
  });

  test("installing the synth's own context again keeps it open and owned", async () => {
    const s = make(variant);
    const ctx = s.synth.getAudioContext();
    s.synth.setAudioContext(ctx);
    expect(ctx.state).toBe("running");
    await s.synth.dispose();
    expect(ctx.state).toBe("closed");
  });

  test("invalid arguments throw a TypeError and change nothing", () => {
    const s = make(variant);
    const ctx = s.synth.getAudioContext();
    const from = s.trace.length;
    for (const args of [[], [null], [{}], [ctx, {}]]) expect(thrown(() => s.synth.setAudioContext(...args)).name).toBe("TypeError");
    expect(s.trace.slice(from)).toEqual([]);
    expect(s.synth.getAudioContext()).toBe(ctx);
  });

  test("an OfflineAudioContext stops MIDI playback", () => {
    const s = make(variant);
    s.synth.loadMIDI(MIXED);
    s.synth.playMIDI();
    H.runUntil(s.env, () => false, 300);
    s.synth.setAudioContext(new s.Offline());
    expect(s.synth.getPlayStatus().play).toBe(0);
  });
});

describe.each(variants)("$name: scheduled percussion (D-019)", (variant) => {
  /* The drum hits scheduled ahead and those sounding, by their sources' ids. */
  function drums(s) {
    const now = s.env.clock.ms / 1000;
    const hits = s.synth._src.filter((v) => v.ch === 9);
    return { ahead: hits.filter((v) => v.t > now).flatMap(ids), sounding: hits.filter((v) => v.t <= now).flatMap(ids) };
  }
  const touched = (trace, from) => new Set(calls(trace, from).map(([, id]) => id));

  test.each([["stopMIDI()", (y) => y.stopMIDI()], ["a seek", (y) => y.locateMIDI(0)], ["allSoundOff(9)", (y) => y.allSoundOff(9)],
    ["CC 120 on channel 10", (y) => y.send([0xb9, 120, 0])]])("%s stops the hits that have not started; sounding hits ring out", (name, act) => {
    const s = make(variant);
    playUntilDrumAhead(s);
    const { ahead, sounding } = drums(s);
    expect(ahead.length).toBeGreaterThan(0);
    const from = s.trace.length;
    act(s.synth);
    const after = calls(s.trace, from);
    for (const id of ahead.filter((x) => /^(osc|src)#/.test(x))) expect(after).toContainEqual(["stop", id, null]);
    expect(liveEdges(s.trace).filter(([f]) => ahead.includes(f))).toEqual([]);
    const t = touched(s.trace, from);
    expect(sounding.filter((id) => t.has(id))).toEqual([]);
    expect(drums(s).ahead).toEqual([]);
  });

  test("allSoundOff on another channel leaves the drums alone", () => {
    const s = make(variant);
    playUntilDrumAhead(s);
    const { ahead } = drums(s);
    const from = s.trace.length;
    s.synth.allSoundOff(0);
    const t = touched(s.trace, from);
    expect(ahead.filter((id) => t.has(id))).toEqual([]);
  });

  test("replaying a completed song keeps the previous pass's scheduled hit (as upstream)", () => {
    const s = make(variant);
    s.synth.loadMIDI(song([noteOn(0, 0, 60, 100), noteOff(240, 0, 60), noteOn(480, 9, 49, 100)]));
    s.synth.playMIDI();
    H.runUntil(s.env, () => s.synth.getPlayStatus().play === 0, 10000);
    const { ahead } = drums(s);
    expect(ahead.length).toBeGreaterThan(0);
    const from = s.trace.length;
    s.synth.playMIDI();
    const t = touched(s.trace, from);
    expect(ahead.filter((id) => t.has(id))).toEqual([]);
  });

  test("a hit leaves the tracking list once it has ended, and its end disconnects it", () => {
    const s = make(variant);
    s.synth.noteOn(9, 38, 100, 0.5);
    const [hit] = s.synth._src;
    expect(hit).toMatchObject({ ch: 9, t: 0.5 });
    H.runUntil(s.env, () => s.env.clock.ms / 1000 > hit.e + 0.2, 10000);
    expect(s.synth._src).toEqual([]);
    const from = s.trace.length;
    s.ended();
    const after = calls(s.trace, from);
    for (const [i, o] of hit.o.entries()) {
      expect(after).toContainEqual(["disconnect", o._id, null]);
      expect(after).toContainEqual(["disconnect", hit.g[i]._id, null]);
    }
    expect(liveEdges(s.trace).filter(([f, to]) => ids(hit).includes(f) || ids(hit).some((x) => to.startsWith(x + ".")))).toEqual([]);
  });

  test("a pruned melodic voice is disconnected", () => {
    const s = make(variant);
    s.synth.noteOn(0, 60, 100);
    const voice = s.synth.notetab.at(-1);
    s.synth.noteOff(0, 60);
    H.runUntil(s.env, () => !s.synth.notetab.includes(voice), 10000);
    expect(liveEdges(s.trace).filter(([f, to]) => ids(voice).includes(f) || ids(voice).some((x) => to.startsWith(x + ".")))).toEqual([]);
  });
});

describe.each(variants)("$name: OfflineAudioContext (#12)", (variant) => {
  test("notes scheduled at explicit times are not pruned by the realtime timer", () => {
    const l = load(variant);
    const ctx = new l.Offline();
    const synth = new l.Synth({ context: ctx });
    synth.noteOn(0, 60, 100, 1);
    synth.noteOff(0, 60, 1.5);
    synth.noteOn(9, 38, 100, 2);
    const voices = synth.notetab.length;
    const from = l.trace.length;
    l.env.skip(100000); // the render's clock runs far past every note's end
    for (let i = 0; i < 10; ++i) l.env.step();
    expect(l.trace.slice(from)).toEqual([]);
    expect(synth.notetab.length).toBe(voices);
    expect(calls(l.trace).filter(([op]) => op === "resume")).toEqual([]);
  });

  test("playMIDI() throws AUDIO_CONTEXT_OFFLINE and changes nothing", () => {
    const l = load(variant);
    const synth = new l.Synth({ context: new l.Offline() });
    synth.loadMIDI(MIXED);
    const status = { ...synth.getPlayStatus() };
    const from = l.trace.length;
    const e = thrown(() => synth.playMIDI());
    expect([e && e.code, e && e.message]).toEqual(["AUDIO_CONTEXT_OFFLINE",
      "AUDIO_CONTEXT_OFFLINE: playMIDI() needs a realtime AudioContext"]);
    expect(l.trace.slice(from)).toEqual([]);
    expect({ ...synth.getPlayStatus() }).toEqual(status);
  });

  test("stopMIDI(), locateMIDI() and dispose() work; the caller's context is not closed", async () => {
    const l = load(variant);
    const ctx = new l.Offline();
    const synth = new l.Synth({ context: ctx });
    synth.loadMIDI(MIXED);
    synth.locateMIDI(960);
    synth.stopMIDI();
    synth.noteOn(9, 38, 100, 1);
    await synth.dispose();
    expect(ctx.state).toBe("suspended");
    expect(liveEdges(l.trace)).toEqual([]);
  });
});
