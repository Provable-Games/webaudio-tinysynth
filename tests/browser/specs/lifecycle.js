/*
 * Lifecycle observation (#11) with the page instrumentation in
 * page/instrument.js.
 *
 * Asserted: the instrumentation itself, on a graph built by the test with
 * known contexts, nodes, edges, sources and timers (so phase B can rely on it).
 * Observed and recorded per engine (phase B asserts cleanup after T4): the
 * graph and timers after construction, after melodic and drum notes have
 * played and been pruned, after stopMIDI(), after setAudioContext() with a
 * second context, and after constructing more synths. Baseline expectations
 * from the code: the 60 ms interval is never cleared, the previous context and
 * graph stay alive on replacement, pruned voices stay connected.
 *
 * The page is served from the controlled server; page.evaluate is used freely
 * here (it grants user activation, so the realtime context can run).
 */
"use strict";
const pages = require("../lib/pages");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* eslint-disable no-undef -- the callbacks below run in the page */
const SELF_CHECK = async () => {
  const L = window.__t6.lifecycle;
  const before = L.snapshot();
  const ctx = new OfflineAudioContext(2, 4410, 44100);
  const osc = ctx.createOscillator(), g1 = ctx.createGain(), g2 = ctx.createGain(), lfo = ctx.createOscillator();
  osc.connect(g1); g1.connect(ctx.destination); osc.connect(g2); osc.disconnect(g2);
  lfo.connect(g1.gain); lfo.connect(osc.detune); lfo.disconnect(osc.detune);
  osc.start(0); osc.stop(0.05); lfo.start(0);
  const id1 = setInterval(() => {}, 1000), id2 = setInterval(() => {}, 2000);
  clearInterval(id1);
  const mid = L.snapshot();
  await ctx.startRendering();
  await new Promise((r) => setTimeout(r, 100));
  const after = L.snapshot();
  clearInterval(id2);
  const key = Object.keys(after.contexts).find((k) => !before.contexts[k]);
  return { before: before.activeIntervals, mid, after, key, intervalsEnd: L.snapshot().activeIntervals };
};

const BASELINE = async () => {
  const L = window.__t6.lifecycle;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const marks = {};
  const synth = new WebAudioTinySynth({ quality: 1 });
  marks.constructed = L.snapshot();
  const ctx = synth.getAudioContext();
  await Promise.race([ctx.resume(), wait(5000)]);
  marks.contextState = ctx.state;
  synth.noteOn(0, 60, 100);
  synth.noteOn(9, 38, 100);
  synth.noteOn(9, 42, 100);
  await wait(300);
  synth.noteOff(0, 60);
  marks.playing = L.snapshot();
  await wait(2500);
  marks.afterRelease = L.snapshot();
  synth.stopMIDI();
  marks.afterStopMIDI = L.snapshot();
  const second = new AudioContext();
  synth.setAudioContext(second);
  await Promise.race([second.resume(), wait(5000)]);
  synth.noteOn(0, 64, 100);
  await wait(300);
  synth.noteOff(0, 64);
  await wait(1500);
  marks.afterSetAudioContext = L.snapshot();
  marks.firstContextStateAfterReplacement = ctx.state;
  const more = [new WebAudioTinySynth({ quality: 0 }), new WebAudioTinySynth({ quality: 1 })];
  marks.afterTwoMoreSynths = L.snapshot();
  marks.dispose = typeof synth.dispose;
  more.length = 0;
  await wait(300);
  marks.afterDroppingReferences = L.snapshot();
  return marks;
};
/* eslint-enable no-undef */

function cases(shared) {
  const { matrix, options, server } = shared;
  const out = [];
  for (const build of matrix.builds) {
    out.push({
      id: "lifecycle " + build,
      dims: { build },
      deadline: 90,
      run: async (t) => {
        const id = "lifecycle-" + build;
        server.registerPage(id, pages.inlinePage({ library: pages.readLibrary(build, options.overrides), seed: options.seed, instrument: true }));
        // Instrumentation self-check on a known graph.
        {
          const p = await t.newPage();
          await p.page.goto(server.origin + "/html/" + id);
          const r = await p.page.evaluate(SELF_CHECK);
          const m = r.mid.contexts[r.key], a = r.after.contexts[r.key];
          t.check("self-check: one new offline context recorded", !!m && m.kind === "offline", r.key + " " + (m && m.kind));
          t.check("self-check: nodes by type", m && m.nodes.Oscillator === 2 && m.nodes.Gain === 2, JSON.stringify(m && m.nodes));
          t.check("self-check: live edges after connect/disconnect (osc>g1, g1>destination, lfo>g1.gain)", m && m.liveEdges === 3 && m.paramEdges === 1, m && m.liveEdges + " edges, " + m.paramEdges + " to params");
          t.check("self-check: sources started and stop() calls", m && m.sources.started === 2 && m.sources.stopCalls === 1, JSON.stringify(m && m.sources));
          t.check("self-check: the stopped source reported ended after rendering", a && a.sources.ended >= 1, JSON.stringify(a && a.sources));
          t.check("self-check: intervals (one of two cleared, then the other)", r.mid.activeIntervals === r.before + 1 && r.intervalsEnd === r.before, r.before + " -> " + r.mid.activeIntervals + " -> " + r.intervalsEnd);
          t.check("self-check: no page errors", !p.pageErrors.length, p.pageErrors.join(" | "));
        }
        // Baseline lifecycle of the library.
        {
          const p = await t.newPage();
          await p.page.goto(server.origin + "/html/" + id);
          const marks = await p.page.evaluate(BASELINE);
          await sleep(10);
          t.check("baseline run completed without page errors", !p.pageErrors.length, p.pageErrors.join(" | "));
          t.observe("baseline graph and timers (phase B asserts cleanup after T4)", marks);
          const c0 = (s) => s.contexts.c0 || {};
          t.observe("summary", {
            contextState: marks.contextState,
            intervals: { constructed: marks.constructed.activeIntervals, afterStopMIDI: marks.afterStopMIDI.activeIntervals, afterThreeSynths: marks.afterTwoMoreSynths.activeIntervals, afterDroppingReferences: marks.afterDroppingReferences.activeIntervals },
            firstContext: { stateAfterReplacement: marks.firstContextStateAfterReplacement, closeCalls: c0(marks.afterSetAudioContext).closeCalls, liveEdgesAfterReplacement: c0(marks.afterSetAudioContext).liveEdges, activeSourcesAfterReplacement: (c0(marks.afterSetAudioContext).sources || {}).active },
            voices: { playing: c0(marks.playing).sources, afterRelease: c0(marks.afterRelease).sources, edgesPlaying: c0(marks.playing).liveEdges, edgesAfterRelease: c0(marks.afterRelease).liveEdges },
            contexts: Object.keys(marks.afterTwoMoreSynths.contexts).length,
            disposeMethod: marks.dispose,
          });
        }
      },
    });
  }
  return out;
}

module.exports = { cases };
