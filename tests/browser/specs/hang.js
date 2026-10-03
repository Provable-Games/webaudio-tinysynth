/*
 * Hang cases under an external deadline (observe only; run with --observe).
 *
 * Each case sets up its page, then drives it into a known baseline hang
 * under a Node-side hang deadline (HANG_DEADLINE seconds) armed around that
 * operation only. The observation records whether the page hung, returned or
 * threw (with page errors); a hung page is closed from Node, and a final case
 * asserts that the engine still runs a page afterwards. Only allocation-free hangs are used, so a hung page cannot
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
const { withTimeout, short } = require("../lib/cases");

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
    const page = () => pages.inlinePage({ library: pages.readLibrary(build, options.overrides), seed: options.seed, after: [pages.pageScript("xhr.js")] });
    /*
     * Setup (page and navigation) runs under the ordinary case deadline, so a
     * slow start fails the case instead of passing as a hang. The hang
     * deadline is armed only around the operation itself, which is not
     * started if the case was already abandoned. The outcome is a hang, a
     * return or an exception thrown in the page (for example SMF_TRUNCATED once
     * T2's parser is in); all three are observations, not failures. A hung
     * page is closed from Node when the case ends.
     */
    const timed = async (t, fn) => {
      server.registerPage(pageId, page());
      const p = await t.newPage();
      await p.page.goto(server.origin + "/html/" + pageId);
      if (t.isAbandoned()) return;
      const started = Date.now();
      const r = await withTimeout(Promise.resolve().then(() => fn(p)), HANG_DEADLINE * 1000);
      const outcome = r.timedOut ? { hang: "no return within the " + HANG_DEADLINE + " s hang deadline; the page is closed from Node" }
        : r.ok ? { returned: r.value } : { threw: short(r.error) };
      t.observe("outcome", Object.assign({ ms: Date.now() - started, pageErrors: p.pageErrors.slice(0, 3) }, outcome));
    };
    // Waits for the page to record the request's loadend (page/xhr.js), which
    // follows the library's onload; a hang inside onload blocks this poll.
    const xhrDone = async (p, url) => {
      for (;;) {
        const d = await p.page.evaluate((u) => window.__t6.xhr.done(u), url); // eslint-disable-line no-undef -- runs in the page
        if (d) return d;
        await sleep(25);
      }
    };
    out.push({
      id: "hang " + build + " #4 loadMIDI(ws.mid cut at 40 bytes)", dims: { build },
      run: (t) => timed(t, (p) => p.page.evaluate(loadBytes, truncated)),
    });
    out.push({
      id: "hang " + build + " #4 loadMIDIUrl(ws.mid cut at 40 bytes)", dims: { build },
      run: (t) => timed(t, async (p) => {
        const url = "/midi/truncated/40/ws.mid?hang=" + build;
        await p.page.evaluate(loadUrl, url);
        return { xhr: await xhrDone(p, url) };
      }),
    });
    out.push({
      id: "hang " + build + " #8 tick-0 tempo-only song with setLoop(1)", dims: { build },
      run: (t) => timed(t, async (p) => {
        const st = await p.page.evaluate(loopSong, tempoOnly);
        // Poll for 2 s (more than 30 scheduler ticks); a hang in a tick blocks the poll.
        const seen = [];
        for (const end = Date.now() + 2000; Date.now() < end;) {
          seen.push(await p.page.evaluate(() => window.__t6.hangSynth.getPlayStatus())); // eslint-disable-line no-undef -- runs in the page
          await sleep(100);
        }
        return { afterPlay: st, afterTwoSeconds: seen[seen.length - 1], polls: seen.length };
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
