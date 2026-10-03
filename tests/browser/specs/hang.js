/*
 * Hang cases under an external deadline (observe only; run with --observe).
 *
 * Each case drives the page into a known baseline hang and lets the
 * Node-side case deadline (HANG_DEADLINE seconds) expire. The runner then
 * closes the page from Node; the observation records whether the page hung
 * or returned, and a final case asserts that the engine still runs a page
 * afterwards. Only allocation-free hangs are used, so a hung page cannot
 * exhaust memory before the deadline (T0 §5):
 *   #4  ws.mid truncated to 40 bytes, via loadMIDI() and via loadMIDIUrl()
 *       (the parser loops without producing events);
 *   #8  a song whose only event is a tick-0 tempo change, with setLoop(1)
 *       (the scheduler callback never advances playTime).
 * Phase B (after T2 and T3) turns these into assertions that the calls
 * return promptly with the documented errors or a stopped song.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const pages = require("../lib/pages");
const smf = require("../lib/smf");

const HANG_DEADLINE = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* eslint-disable no-undef -- the callbacks below run in the page */
const loadBytes = (b64) => {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; ++i) u[i] = bin.charCodeAt(i);
  const synth = new WebAudioTinySynth({ quality: 1 });
  window.__t6.hangSynth = synth;
  synth.loadMIDI(u.buffer);
  return synth.getPlayStatus();
};
const loadUrl = (u) => {
  const synth = new WebAudioTinySynth({ quality: 1 });
  window.__t6.hangSynth = synth;
  synth.loadMIDIUrl(u);
  return "requested";
};
const loopSong = (b64) => {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; ++i) u[i] = bin.charCodeAt(i);
  const synth = new WebAudioTinySynth({ quality: 1 });
  window.__t6.hangSynth = synth;
  synth.loadMIDI(u.buffer);
  synth.setLoop(1);
  synth.playMIDI();
  return synth.getPlayStatus();
};
/* eslint-enable no-undef */

function cases(shared) {
  const { matrix, options, server } = shared;
  const truncated = fs.readFileSync(path.join(pages.ROOT, "ws.mid")).subarray(0, 40).toString("base64");
  const tempoOnly = smf.write({ format: 0, division: 480, tracks: [[{ dt: 0, bytes: [0xff, 0x51, 0x03, 0x07, 0xa1, 0x20] }]] }).toString("base64");
  const out = [];
  for (const build of matrix.builds) {
    const pageId = "hang-" + build;
    const page = () => pages.inlinePage({ library: pages.readLibrary(build, options.overrides), seed: options.seed });
    const timed = async (t, fn) => {
      server.registerPage(pageId, page());
      const p = await t.newPage();
      await p.page.goto(server.origin + "/html/" + pageId);
      const started = Date.now();
      const value = await fn(p);
      t.observe("returned", { ms: Date.now() - started, value });
    };
    out.push({
      id: "hang " + build + " #4 loadMIDI(ws.mid cut at 40 bytes)", dims: { build }, deadline: HANG_DEADLINE, expectHang: true,
      run: (t) => timed(t, (p) => p.page.evaluate(loadBytes, truncated)),
    });
    out.push({
      id: "hang " + build + " #4 loadMIDIUrl(ws.mid cut at 40 bytes)", dims: { build }, deadline: HANG_DEADLINE, expectHang: true,
      run: (t) => timed(t, async (p) => {
        await p.page.evaluate(loadUrl, "/midi/truncated/40/ws.mid?hang=" + build);
        await sleep(500);
        return p.page.evaluate(() => "page still responsive after the response");
      }),
    });
    out.push({
      id: "hang " + build + " #8 tick-0 tempo-only song with setLoop(1)", dims: { build }, deadline: HANG_DEADLINE, expectHang: true,
      run: (t) => timed(t, async (p) => {
        const st = await p.page.evaluate(loopSong, tempoOnly);
        await sleep(500);
        return { afterPlay: st, ping: await p.page.evaluate(() => "page still responsive 0.5 s after playMIDI()") };
      }),
    });
    out.push({
      id: "hang " + build + " engine still runs pages afterwards", dims: { build }, kind: "observe",
      run: async (t) => {
        const p = await t.newPage();
        await p.page.setContent("<p>ok</p>");
        t.check("a new page evaluates after the hang cases", (await p.page.evaluate(() => 1 + 1)) === 2);
      },
    });
  }
  return out;
}

module.exports = { cases, HANG_DEADLINE };
