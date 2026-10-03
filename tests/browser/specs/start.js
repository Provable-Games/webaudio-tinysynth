/*
 * Starting audio from a real gesture under the default autoplay policy
 * (#12, D-011, D-018), with lazy and injected contexts. T4 phase-B checks.
 *
 * As in specs/gesture.js: each variant gets a fresh browser context and a page
 * from the controlled server at http://127.0.0.1 with no autoplay flags. The
 * runner never calls page.evaluate; it reads the page's console reports
 * (page/start.js), first asserts the state before any input (no activation;
 * a lazy synth has created no context; an existing context is blocked and its
 * clock is 0), then delivers a real click or key press. The page is built with
 * the lifecycle instrumentation, which counts contexts and connections.
 *
 * Asserted, for both builds:
 *   - lazy (click and key): no context before the gesture; resume() creates
 *     exactly one, it runs, its clock and the song advance;
 *   - injected context: no other context is created; the synth plays into
 *     that context's destination; resume() starts it from a click;
 *   - the README path (click, then playMIDI() only) runs;
 *   - a closed injected context: resume() rejects with AUDIO_CONTEXT_CLOSED;
 *   - resume() from a timer without a gesture leaves the context blocked;
 *   - zero unhandled rejections and no page errors in every variant.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const pages = require("../lib/pages");

const GESTURE_WAIT_MS = 10000;
const PRE_GESTURE_MS = 1200;
const BLOCKED = ["suspended", "interrupted"]; // WebKit (WPE) reports "interrupted"; see specs/gesture.js
const VARIANTS = ["lazy-click", "lazy-key", "inject-click", "readme-click", "closed-click", "timer-resume"];

const states = (rec) => rec.console.filter((m) => m.text.startsWith("T4STATE ")).map((m) => Object.assign(JSON.parse(m.text.slice(8)), { at: m.at }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(rec, pred, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const s = states(rec).find(pred);
    if (s || Date.now() > end) return s || null;
    await sleep(50);
  }
}

function cases(shared) {
  const { matrix, options, server } = shared;
  const midi = fs.readFileSync(path.join(pages.ROOT, "ws.mid")).toString("base64");
  const out = [];
  for (const build of matrix.builds) {
    out.push({
      id: "start " + build,
      dims: { build },
      deadline: 150,
      run: async (t) => {
        const summary = {};
        for (const variant of VARIANTS) {
          const id = "start-" + build + "-" + variant;
          server.registerPage(id, pages.inlinePage({
            library: pages.readLibrary(build, options.overrides),
            seed: options.seed,
            instrument: true,
            after: ["window.__T4_START__ = " + JSON.stringify({ variant, midi }) + ";", pages.pageScript("start.js")],
            body: "<button id=\"start\" style=\"width:200px;height:80px\">start</button>",
            title: "tinysynth start " + variant,
          }));
          const rec = await t.newPage();
          await rec.page.goto(server.origin + "/html/" + id);
          await sleep(PRE_GESTURE_MS);
          const pre = states(rec);
          const label = variant + ": ";
          const lazy = variant.startsWith("lazy");
          t.check(label + "page reported its state before the gesture", pre.length >= 5, pre.length + " reports");
          t.check(label + "no user activation before the gesture", pre.every((s) => s.hasBeenActive === false || s.hasBeenActive === null),
            "hasBeenActive " + [...new Set(pre.map((s) => s.hasBeenActive))].join(","));
          if (lazy) {
            t.check(label + "no AudioContext before the gesture", pre.every((s) => s.contexts === 0 && s.state === null),
              [...new Set(pre.map((s) => s.contexts + " contexts, " + s.state))].join("; "));
          } else if (variant === "closed-click") {
            t.check(label + "the injected context is closed before the gesture", pre[pre.length - 1].state === "closed", pre[pre.length - 1].state);
          } else {
            t.check(label + "one context, blocked and not advancing before the gesture",
              pre.every((s) => s.contexts === 1 && BLOCKED.includes(s.state) && s.currentTime === 0),
              [...new Set(pre.map((s) => s.contexts + "@" + s.state + "@" + s.currentTime))].join(","));
          }
          const v = { pre: { states: [...new Set(pre.map((s) => s.state))], contexts: [...new Set(pre.map((s) => s.contexts))] } };
          if (variant === "timer-resume") {
            await sleep(1500);
            const after = states(rec), last = after[after.length - 1];
            t.check(label + "no gesture: the context stays blocked after resume() from a timer", after.every((s) => BLOCKED.includes(s.state) && s.currentTime === 0), last.state + "@" + last.currentTime);
            v.noGesture = { events: last.events, state: last.state };
            t.observe(label + "resume() without a gesture", v.noGesture);
          } else {
            const gestureAt = Date.now();
            if (variant === "lazy-key") await rec.page.keyboard.press("Enter");
            else await rec.page.click("#start");
            if (variant === "closed-click") {
              const settled = await waitFor(rec, (s) => s.at > gestureAt && s.events.some((e) => e.startsWith("resume ")), GESTURE_WAIT_MS);
              t.check(label + "resume() rejects with code AUDIO_CONTEXT_CLOSED", !!settled && settled.events.includes("resume rejected: AUDIO_CONTEXT_CLOSED"),
                settled ? JSON.stringify(settled.events) : "not settled");
              v.post = { events: settled && settled.events };
            } else {
              const running = await waitFor(rec, (s) => s.at > gestureAt && s.state === "running", GESTURE_WAIT_MS);
              let advanced = null;
              if (running) {
                const moved = await waitFor(rec, (s) => s.at >= running.at && s.currentTime >= running.currentTime + 0.5 && s.curTick > 0, GESTURE_WAIT_MS);
                const last = moved || states(rec).slice(-1)[0];
                advanced = { currentTime: [running.currentTime, last.currentTime], curTick: [running.curTick, last.curTick], play: last.play, contexts: last.contexts, toDestination: last.toDestination, events: last.events };
              }
              const last = states(rec).slice(-1)[0];
              v.post = { msToRunning: running ? running.at - gestureAt : null, finalState: last.state, advanced };
              t.check(label + "running within " + GESTURE_WAIT_MS / 1000 + " s of the real input", !!running, running ? v.post.msToRunning + " ms" : "still " + last.state + "; " + JSON.stringify(last.events));
              t.check(label + "audio time advances 0.5 s and the song plays", !!advanced && advanced.currentTime[1] - advanced.currentTime[0] >= 0.5 && advanced.play === 1 && advanced.curTick[1] > 0,
                advanced ? "currentTime " + advanced.currentTime.map((x) => x.toFixed(3)).join(" -> ") + ", curTick " + advanced.curTick.join(" -> ") : "not running");
              t.check(label + "exactly one AudioContext exists", !!advanced && advanced.contexts === 1, advanced ? advanced.contexts + " contexts" : "not running");
              if (variant !== "readme-click")
                t.check(label + "resume() resolved", !!advanced && advanced.events.includes("resume resolved"), advanced ? JSON.stringify(advanced.events) : "");
              t.check(label + "the synth plays into the context's destination", !!advanced && advanced.toDestination >= 1, advanced ? advanced.toDestination + " connections" : "");
            }
            t.observe(label + "after the gesture", v.post);
          }
          const final = states(rec).slice(-1)[0];
          t.check(label + "no unhandled rejections", final.rejections === 0, final.rejections + " rejections");
          t.check(label + "no page errors", !rec.pageErrors.length, rec.pageErrors.slice(0, 2).join(" | "));
          summary[variant] = v;
        }
        t.observe("summary", summary);
      },
    });
  }
  return out;
}

module.exports = { cases };
