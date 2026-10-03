/*
 * dispose() and context replacement (#11, D-018) on real nodes, with the
 * lifecycle instrumentation (page/instrument.js). T4 phase-B cleanup checks.
 *
 * Each scenario plays ws.mid (drums included) and adds voices of every kind
 * before tearing down: a note held by the sustain pedal, a held note, a note
 * in its release tail, a sounding crash cymbal and a drum hit scheduled
 * 0.5 s ahead. Asserted, for both builds:
 *   - dispose() returns the same promise twice and resolves; a pending
 *     ready() resolves; no interval is left; no live connection is left from
 *     any node of the synth's contexts (edges to AudioParams included): at
 *     once on a context the synth closes, and once its sources have ended on
 *     one that stays open (Chromium never ends an oscillator that is
 *     disconnected right after stop(), so a source is disconnected when it
 *     ends);
 *   - every source still playing receives a stop() call during dispose();
 *     on a caller-owned (running) context every source then ends;
 *   - a synth-created context is closed; a caller-owned one stays running;
 *   - setAudioContext() tears the previous graph down the same way, closing
 *     the previous context only if the synth created it;
 *   - a URL load still pending at dispose() installs nothing when its
 *     response arrives; construct, play, replace and dispose cycles with
 *     every ownership mode leave no timer, no live connection and no extra
 *     context;
 *   - no page error and no unhandled rejection anywhere.
 * Ended events are not dispatched after a context is closed (measured in all
 * three engines), so on a closed context "stopped" is read from the stop()
 * calls, not from ended events.
 *
 * The page is served from the controlled server; page.evaluate is used freely
 * (it grants user activation, so realtime contexts run).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const pages = require("../lib/pages");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* eslint-disable no-undef -- the callbacks below run in the page */

/* Starts `synth` on ws.mid and adds voices of every kind; resolves after `ms`. */
const PAGE_HELPERS = `
window.__t4 = {
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  bytes: (b64) => { const s = atob(b64), a = new Uint8Array(s.length); for (let i = 0; i < s.length; ++i) a[i] = s.charCodeAt(i); return a.buffer; },
  busy: async (synth, midi, ms) => {
    await Promise.race([synth.resume(), window.__t4.wait(5000)]);
    const ctx = synth.getAudioContext();
    synth.loadMIDI(window.__t4.bytes(midi));
    synth.playMIDI();
    synth.send([0xb1, 64, 127]); synth.noteOn(1, 64, 100); synth.noteOff(1, 64);
    synth.noteOn(2, 67, 100);
    synth.noteOn(3, 72, 100); synth.noteOff(3, 72);
    synth.noteOn(9, 49, 100);
    synth.noteOn(9, 42, 100, ctx.currentTime + 0.5);
    await window.__t4.wait(ms);
  },
  /* Sources of context id \`c\` that were playing in \`before\` and got no new stop() call by \`now\`. */
  unstopped: (before, now, c) => before.filter((a) => a.context === c).filter((a) => { const n = now.find((x) => x.id === a.id); return n && n.stopCalls <= a.stopCalls; }),
  /* Live edges whose source node belongs to one of the contexts. */
  edgesOf: (snap, ids) => ids.reduce((s, c) => s + (snap.contexts[c] ? snap.contexts[c].liveEdges : 0), 0),
};`;

const CYCLE = async ({ mode, midi }) => {
  const L = window.__t6.lifecycle, T = window.__t4;
  const ext = mode === "caller" ? new AudioContext() : null;
  const synth = new WebAudioTinySynth(ext ? { quality: 1, context: ext } : { quality: 1 });
  const ctx = synth.getAudioContext();
  await T.busy(synth, midi, 250);
  let readyDone = false;
  synth.ready().then(() => { readyDone = true; });
  const before = L.snapshot(), activeBefore = L.active();
  const p = synth.dispose();
  const same = synth.dispose() === p;
  const now = L.snapshot(), activeNow = L.active();
  let resolved = false;
  await p.then(() => { resolved = true; });
  await T.wait(500);
  // On a context that stays open, wait (bounded) for every stopped source to end.
  for (let i = 0; mode === "caller" && i < 25 && L.active().length; ++i) await T.wait(100);
  const after = L.snapshot(), activeAfter = L.active();
  return {
    same, resolved, readyDone, ctxState: ctx.state, before, now, after,
    activeBefore: activeBefore.length, unstopped: T.unstopped(activeBefore, activeNow, "c0"), activeAfter,
    contextAfter: synth.getAudioContext(), status: synth.getPlayStatus(),
    resumeAfter: await synth.resume().then(() => "resolved", (e) => e.code),
    rejections: window.__t6.rejections,
  };
};

const REPLACE = async ({ midi }) => {
  const L = window.__t6.lifecycle, T = window.__t4;
  const synth = new WebAudioTinySynth({ quality: 1 });
  const first = synth.getAudioContext();
  await T.busy(synth, midi, 250);
  const second = new AudioContext();
  const a0 = L.active();
  synth.setAudioContext(second);
  const r1 = { snap: L.snapshot(), unstopped: T.unstopped(a0, L.active(), "c0"), current: synth.getAudioContext() === second };
  await T.busy(synth, midi, 250);
  const third = new AudioContext();
  const a1 = L.active();
  synth.setAudioContext(third);
  const r2 = { snap: L.snapshot(), unstopped: T.unstopped(a1, L.active(), "c1") };
  await T.wait(500);
  r2.secondActive = L.active().filter((a) => a.context === "c1");
  r2.later = L.snapshot();
  await T.busy(synth, midi, 250);
  await synth.dispose();
  await T.wait(500);
  const end = L.snapshot();
  return { r1, r2, end, states: [first.state, second.state, third.state], rejections: window.__t6.rejections };
};

const PENDING_START = (url) => {
  window.__t4.synth = new WebAudioTinySynth({ quality: 0 });
  window.__t4.synth.loadMIDIUrl(url);
  return window.__t4.synth.dispose();
};
const PENDING_END = (url) => ({ done: window.__t6.xhr.done(url), status: window.__t4.synth.getPlayStatus(), song: window.__t4.synth.song === null, rejections: window.__t6.rejections });

const CYCLES = async ({ midi }) => {
  const L = window.__t6.lifecycle, T = window.__t4;
  const log = [];
  for (const mode of ["owned", "caller", "lazy", "owned-replaced"]) {
    const ext = mode === "caller" ? new AudioContext() : null;
    const synth = new WebAudioTinySynth(mode === "caller" ? { context: ext } : mode === "lazy" ? { lazy: true } : {});
    await T.busy(synth, midi, 150);
    if (mode === "owned-replaced") {
      synth.setAudioContext(new AudioContext());
      await T.busy(synth, midi, 150);
    }
    await synth.dispose();
    log.push(mode);
  }
  await T.wait(500);
  const snap = L.snapshot();
  return { log, snap, states: L.contexts().map((c) => c.state), active: L.active(), rejections: window.__t6.rejections };
};
/* eslint-enable no-undef */

function cases(shared) {
  const { matrix, options, server } = shared;
  const midi = fs.readFileSync(path.join(pages.ROOT, "ws.mid")).toString("base64");
  const out = [];
  for (const build of matrix.builds) {
    out.push({
      id: "dispose " + build,
      dims: { build },
      deadline: 120,
      run: async (t) => {
        const id = "dispose-" + build;
        server.registerPage(id, pages.inlinePage({
          library: pages.readLibrary(build, options.overrides), seed: options.seed, instrument: true,
          after: [pages.pageScript("xhr.js"), PAGE_HELPERS],
        }));
        const open = async () => {
          const p = await t.newPage();
          await p.page.goto(server.origin + "/html/" + id);
          return p;
        };
        const noErrors = (label, p, r) => {
          t.check(label + "no page errors", !p.pageErrors.length, p.pageErrors.slice(0, 2).join(" | "));
          t.check(label + "no unhandled rejections", !r.rejections.length, JSON.stringify(r.rejections.slice(0, 2)));
        };

        for (const mode of ["owned", "caller"]) {
          const p = await open();
          const r = await p.page.evaluate(CYCLE, { mode, midi });
          const label = "dispose, " + (mode === "owned" ? "synth-created" : "caller-owned") + " context: ";
          const c = (s) => s.contexts.c0 || {};
          t.check(label + "voices of every kind were playing", r.activeBefore >= 8 && r.before.activeIntervals >= 1, r.activeBefore + " sources, " + r.before.activeIntervals + " intervals");
          t.check(label + "the same promise twice; it resolves; a pending ready() resolves", r.same && r.resolved && r.readyDone, [r.same, r.resolved, r.readyDone].join(","));
          t.check(label + "no interval left", r.now.activeIntervals === 0 && r.after.activeIntervals === 0, r.now.activeIntervals + ", then " + r.after.activeIntervals);
          // A closing context is disconnected at once; on one that stays open each source is disconnected when it ends.
          const at = mode === "owned" ? [r.now, r.after] : [r.after];
          t.check(label + "no live connection left (none to AudioParams)", at.every((x) => c(x).liveEdges === 0 && c(x).paramEdges === 0),
            at.map((x) => c(x).liveEdges + " edges, " + c(x).paramEdges + " to params").join("; then "));
          t.check(label + "every playing source got a stop() call", r.unstopped.length === 0, JSON.stringify(r.unstopped.slice(0, 3)));
          if (mode === "owned") {
            t.check(label + "closed once, after which the promise resolved", c(r.after).closeCalls === 1 && r.ctxState === "closed", c(r.after).closeCalls + " close calls, " + r.ctxState);
          } else {
            t.check(label + "left open and running", c(r.after).closeCalls === 0 && r.ctxState === "running", c(r.after).closeCalls + " close calls, " + r.ctxState);
            t.check(label + "every source then ended", r.activeAfter.length === 0, JSON.stringify(r.activeAfter.slice(0, 3)));
          }
          t.check(label + "afterwards: getAudioContext() null, stopped, resume() rejects SYNTH_DISPOSED",
            r.contextAfter === null && r.status.play === 0 && r.resumeAfter === "SYNTH_DISPOSED", JSON.stringify([r.contextAfter, r.status.play, r.resumeAfter]));
          noErrors(label, p, r);
          t.observe(label + "instrumentation", { before: c(r.before), now: c(r.now), after: c(r.after), intervals: [r.before.activeIntervals, r.now.activeIntervals] });
        }

        {
          const p = await open();
          const r = await p.page.evaluate(REPLACE, { midi });
          const label = "setAudioContext(): ";
          const c = (s, k) => s.contexts[k] || {};
          t.check(label + "the synth-created context is closed and its graph torn down", c(r.r1.snap, "c0").closeCalls === 1 && c(r.r1.snap, "c0").liveEdges === 0 && r.r1.unstopped.length === 0 && r.r1.current,
            JSON.stringify({ close: c(r.r1.snap, "c0").closeCalls, edges: c(r.r1.snap, "c0").liveEdges, unstopped: r.r1.unstopped.length }));
          t.check(label + "a caller-owned previous context is torn down but not closed; its sources end", c(r.r2.later, "c1").closeCalls === 0 && c(r.r2.later, "c1").liveEdges === 0 && r.r2.unstopped.length === 0 && r.r2.secondActive.length === 0,
            JSON.stringify({ close: c(r.r2.later, "c1").closeCalls, edges: c(r.r2.later, "c1").liveEdges, unstopped: r.r2.unstopped.length, active: r.r2.secondActive.length }));
          t.check(label + "after dispose(): the injected context stays open; nothing is connected; no interval",
            c(r.end, "c2").closeCalls === 0 && ["c0", "c1", "c2"].every((k) => c(r.end, k).liveEdges === 0) && r.end.activeIntervals === 0,
            JSON.stringify({ states: r.states, edges: ["c0", "c1", "c2"].map((k) => c(r.end, k).liveEdges), intervals: r.end.activeIntervals }));
          t.check(label + "context states: closed, running, running", r.states.join(",") === "closed,running,running", r.states.join(","));
          noErrors(label, p, r);
        }

        {
          const p = await open();
          const key = "t4-dispose-" + build + "-" + Date.now();
          const url = server.origin + "/midi/hold/" + key + "/ws.mid";
          server.hold(key);
          await p.page.evaluate(PENDING_START, url);
          server.release(key);
          let r;
          for (const end = Date.now() + 15000; ;) {
            r = await p.page.evaluate(PENDING_END, url);
            if (r.done || Date.now() > end) break;
            await sleep(50);
          }
          const label = "a URL load pending at dispose(): ";
          t.check(label + "its response arrived", !!r.done && r.done.status === 200, JSON.stringify(r.done));
          t.check(label + "and installed nothing", r.status.maxTick === 0 && r.song, JSON.stringify(r.status));
          noErrors(label, p, r);
        }

        {
          const p = await open();
          const r = await p.page.evaluate(CYCLES, { midi });
          const label = "cycles (synth-created, caller-owned, lazy, replaced): ";
          const ids = Object.keys(r.snap.contexts);
          t.check(label + "one context per synth or injection, no extra", ids.length === 5, ids.length + " contexts");
          t.check(label + "no interval and no live connection left", r.snap.activeIntervals === 0 && ids.every((k) => r.snap.contexts[k].liveEdges === 0),
            r.snap.activeIntervals + " intervals; edges " + ids.map((k) => r.snap.contexts[k].liveEdges).join(","));
          t.check(label + "synth-created contexts closed, caller-owned ones open", r.states.join(",") === "closed,running,closed,closed,running", r.states.join(","));
          t.check(label + "no source still playing on an open context", r.active.filter((a) => r.snap.contexts[a.context].state === "running").length === 0, JSON.stringify(r.active.slice(0, 3)));
          noErrors(label, p, r);
        }
      },
    });
  }
  return out;
}

module.exports = { cases };
