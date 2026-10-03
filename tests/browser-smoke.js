#!/usr/bin/env node
/*
 * Offline browser smoke test (manual; not part of `npm test`).
 *
 * Opens a page in headless Chromium with every network request aborted.
 * The page inlines webaudio-tinysynth.js (then webaudio-tinysynth.min.js)
 * and a MIDI fixture. It constructs the synth, calls loadMIDI and
 * playMIDI, and asserts:
 *   - getPlayStatus().play === 1 and maxTick > 0 right after playMIDI;
 *   - the AudioContext is running and curTick advances;
 *   - window.WebAudioTinySynth exists and no <webaudio-tinysynth> element is defined;
 *   - no page errors, no console errors, and zero network requests.
 *
 * Needs playwright-core and a matching Chromium. Install them outside the
 * repo, for example:
 *   (cd /some/scratch && npm i playwright-core@1.62.1 && npx playwright-core install chromium)
 *   PLAYWRIGHT_CORE=/some/scratch/node_modules/playwright-core node tests/browser-smoke.js [fixture.mid]
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
const fixture = process.argv[2] || "ws.mid";
const midiB64 = fs.readFileSync(path.resolve(ROOT, fixture)).toString("base64");

function page(scriptFile) {
  const js = fs.readFileSync(path.join(ROOT, scriptFile), "utf8").replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html><head><meta charset="utf-8"><title>tinysynth smoke</title>
<script>${js}</script></head><body>
<script>
window.smoke = async () => {
  const bin = atob(${JSON.stringify(midiB64)});
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; ++i) bytes[i] = bin.charCodeAt(i);
  const synth = new WebAudioTinySynth({ voices: 64 });
  synth.loadMIDI(bytes.buffer);
  synth.setLoop(0);
  synth.playMIDI();
  const atStart = synth.getPlayStatus();
  await new Promise((r) => setTimeout(r, 1000));
  const later = synth.getPlayStatus();
  const state = synth.getAudioContext().state;
  synth.stopMIDI();
  return {
    atStart, later, state,
    exported: typeof window.WebAudioTinySynth,
    element: typeof customElements.get("webaudio-tinysynth"),
    programs: synth.program.length,
    events: synth.song.ev.length,
  };
};
</script></body></html>`;
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  let failed = false;
  try {
    for (const scriptFile of ["webaudio-tinysynth.js", "webaudio-tinysynth.min.js"]) {
      const ctx = await browser.newContext();
      const p = await ctx.newPage();
      const requests = [];
      const errors = [];
      await ctx.route("**/*", (route) => { requests.push(route.request().url()); return route.abort(); });
      p.on("request", (r) => requests.push(r.url()));
      p.on("pageerror", (e) => errors.push("pageerror: " + e.message));
      p.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

      await p.setContent(page(scriptFile));
      const r = await p.evaluate(() => window.smoke()); // eslint-disable-line no-undef -- runs in the page
      await ctx.close();

      const checks = [
        ["getPlayStatus().play === 1 after playMIDI", r.atStart.play === 1],
        ["maxTick > 0", r.atStart.maxTick > 0],
        ["AudioContext running", r.state === "running"],
        ["curTick advanced after 1 s", r.later.curTick > r.atStart.curTick],
        ["window.WebAudioTinySynth exported", r.exported === "function"],
        ["<webaudio-tinysynth> not defined", r.element === "undefined"],
        ["128 programs", r.programs === 128],
        ["no page/console errors", errors.length === 0],
        ["zero network requests", requests.length === 0],
      ];
      console.log(scriptFile + " + " + fixture + ": " + JSON.stringify(r));
      for (const [name, ok] of checks) {
        console.log("  " + (ok ? "ok  " : "FAIL") + " " + name);
        if (!ok) failed = true;
      }
      if (errors.length) console.log("  errors: " + JSON.stringify(errors));
      if (requests.length) console.log("  requests: " + JSON.stringify(requests));
    }
  } finally {
    await browser.close();
  }
  console.log(failed ? "FAIL" : "PASS: browser smoke test");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
