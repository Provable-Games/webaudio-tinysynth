#!/usr/bin/env node
/*
 * T0 probe: run each build as a classic inline <script> inside a page that is
 * itself loaded from a data:text/html;base64 URI (the onchain consumer's
 * animation_url shape), with every network request aborted.
 *
 * Two launches:
 *   A. --autoplay-policy=no-user-gesture-required (same bypass as
 *      tests/browser-smoke.js): construct, loadMIDI, playMIDI, check progress.
 *   B. default autoplay policy, no gesture: record AudioContext state after
 *      construction and after playMIDI. This characterizes, it does not test
 *      gesture startup.
 *   C. as B, but the full Chromium build in new-headless mode
 *      (channel "chromium") instead of the headless shell.
 *   D. headless shell with --autoplay-policy=document-user-activation-required
 *      (explicitly enforced policy), no gesture.
 *
 * Usage (Chromium needs playwright-core and its browser outside the repo):
 *   PLAYWRIGHT_CORE=/path/node_modules/playwright-core \
 *     timeout -s KILL 120 node docs/improvements/evidence/T0/probes/embed-data-uri.js [fixture.mid]
 * Prints one JSON object per build and launch, then a summary line.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../../../../..");
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
const fixture = process.argv[2] || "ws.mid";
const midiB64 = fs.readFileSync(path.resolve(ROOT, fixture)).toString("base64");

function pageHtml(js) {
  // The script is inserted verbatim: no </script escaping, as the consumer does.
  return "<!doctype html><html><head><meta charset=\"utf-8\"><title>t0 embed</title><script>" + js +
    "</script></head><body><script type=\"text/plain\" id=\"midi\">" + midiB64 + "</script><script>\n" +
    "window.probe = async (waitMs) => {\n" +
    "  const bin = atob(document.getElementById('midi').textContent);\n" +
    "  const bytes = new Uint8Array(bin.length);\n" +
    "  for (let i = 0; i < bin.length; ++i) bytes[i] = bin.charCodeAt(i);\n" +
    "  const synth = new WebAudioTinySynth({ voices: 64 });\n" +
    "  const afterCtor = synth.getAudioContext().state;\n" +
    "  synth.loadMIDI(bytes.buffer);\n" +
    "  synth.setLoop(0);\n" +
    "  synth.playMIDI();\n" +
    "  const atStart = synth.getPlayStatus();\n" +
    "  await new Promise((r) => setTimeout(r, waitMs));\n" +
    "  const later = synth.getPlayStatus();\n" +
    "  const state = synth.getAudioContext().state;\n" +
    "  synth.stopMIDI();\n" +
    "  return { origin: location.origin, protocol: location.protocol, afterCtor, atStart, later, state,\n" +
    "    exported: typeof window.WebAudioTinySynth, sampleRate: synth.getAudioContext().sampleRate };\n" +
    "};\n</script></body></html>";
}

async function runOnce(browser, file) {
  const js = fs.readFileSync(path.join(ROOT, file), "utf8");
  const html = pageHtml(js);
  const url = "data:text/html;base64," + Buffer.from(html, "utf8").toString("base64");
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const requests = [];
  const errors = [];
  await ctx.route("**/*", (route) => { requests.push(route.request().url().slice(0, 40)); return route.abort(); });
  p.on("request", (r) => { if (!r.url().startsWith("data:")) requests.push(r.url()); });
  p.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  p.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  let r, gotoError = null;
  try {
    await p.goto(url);
    r = await p.evaluate((w) => window.probe(w), 1000);
  } catch (e) {
    gotoError = String(e.message || e).split("\n")[0];
  }
  await ctx.close();
  return { file, htmlBytes: html.length, dataUrlBytes: url.length, result: r, gotoError, errors, requests };
}

(async () => {
  const out = [];
  for (const mode of ["A-autoplay-bypass", "B-default-policy", "C-default-policy-new-headless", "D-enforced-policy-no-gesture"]) {
    const args = mode.startsWith("A") ? ["--autoplay-policy=no-user-gesture-required"] :
      mode.startsWith("D") ? ["--autoplay-policy=document-user-activation-required"] : [];
    let browser;
    try {
      browser = await chromium.launch(Object.assign({ headless: true, args }, mode.startsWith("C") ? { channel: "chromium" } : {}));
    } catch (e) {
      console.log(JSON.stringify({ mode, launchError: String(e.message || e).split("\n")[0] }));
      continue;
    }
    try {
      for (const file of ["webaudio-tinysynth.js", "webaudio-tinysynth.min.js"]) {
        const r = await runOnce(browser, file);
        r.mode = mode;
        r.browserVersion = browser.version();
        console.log(JSON.stringify(r));
        out.push(r);
      }
    } finally {
      await browser.close();
    }
  }
  const a = out.filter((r) => r.mode.startsWith("A"));
  const okA = a.every((r) => r.result && r.result.atStart.play === 1 && r.result.later.curTick > r.result.atStart.curTick &&
    r.result.state === "running" && r.errors.length === 0 && r.requests.length === 0);
  const noReqBC = out.filter((r) => !r.mode.startsWith("A")).every((r) => r.requests.length === 0 && r.errors.length === 0);
  console.log("SUMMARY A(bypass) playback+offline: " + (okA ? "PASS" : "FAIL") +
    "; B/C/D no requests/errors: " + (noReqBC ? "yes" : "no") +
    "; B/C/D AudioContext states (after ctor -> after 1 s): " + out.filter((r) => !r.mode.startsWith("A")).map((r) => r.mode[0] + ":" + r.file + "=" + (r.result ? r.result.afterCtor + "->" + r.result.state + " curTick " + r.result.atStart.curTick + "->" + r.result.later.curTick : r.gotoError)).join(", "));
  process.exit(okA ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
