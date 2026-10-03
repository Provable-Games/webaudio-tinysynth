/*
 * Real-gesture startup under the default autoplay policy (#12, D-011).
 *
 * Each variant gets a fresh browser context and loads a page from the
 * controlled server at http://127.0.0.1 (no autoplay flags). The runner never
 * calls page.evaluate: it reads the page's own console reports (page/gesture.js),
 * first asserts that the context is blocked (suspended; WebKit reports
 * "interrupted") and not advancing, that nothing has user
 * activation and that time does not advance, then delivers a real input event
 * (page.click or keyboard.press) and waits up to GESTURE_WAIT_MS for the
 * context to run and playback to progress.
 *
 * Asserted (baseline and later): the explicit resume() path from a click and
 * from a key press. Observed and recorded per engine (phase B asserts the #12
 * contract after T4): playMIDI() alone from a click (the README pattern),
 * send() alone from a click, and playMIDI() from a timer with no gesture.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const pages = require("../lib/pages");

const GESTURE_WAIT_MS = 10000;
const PRE_GESTURE_MS = 1200;
// Measured: Chromium 153, Firefox 155 and WebKit 26.6 all keep a context
// created at load from running at an http://127.0.0.1 origin until a
// gesture. Chromium and Firefox report "suspended". WebKit (WPE, Linux)
// reports its non-standard "interrupted" once the library's construction-time
// send() has called resume() without a gesture; a bare context reports
// "suspended". Both are accepted as "blocked"; the exact state is recorded.
const POLICY_ENFORCED = { chromium: true, firefox: true, webkit: true };
const BLOCKED_STATES = ["suspended", "interrupted"];
const ASSERTED = ["resume", "key-resume"];
const VARIANTS = ["resume", "key-resume", "play", "send", "timer-play"];

const states = (rec) => rec.console.filter((m) => m.text.startsWith("T6STATE ")).map((m) => Object.assign(JSON.parse(m.text.slice(8)), { at: m.at }));
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
  const { matrix, options, server, engine } = shared;
  const midi = fs.readFileSync(path.join(pages.ROOT, "ws.mid")).toString("base64");
  const out = [];
  for (const build of matrix.builds) {
    out.push({
      id: "gesture " + build,
      dims: { build },
      deadline: 120,
      run: async (t) => {
        const summary = {};
        for (const variant of VARIANTS) {
          const id = "gesture-" + build + "-" + variant;
          server.registerPage(id, pages.inlinePage({
            library: pages.readLibrary(build, options.overrides),
            seed: options.seed,
            after: ["window.__T6_GESTURE__ = " + JSON.stringify({ variant, midi }) + ";", pages.pageScript("gesture.js")],
            body: "<button id=\"start\" style=\"width:200px;height:80px\">start</button>",
            title: "tinysynth gesture " + variant,
          }));
          const rec = await t.newPage();
          await rec.page.goto(server.origin + "/html/" + id);
          await sleep(PRE_GESTURE_MS);
          const pre = states(rec);
          const assert = ASSERTED.includes(variant);
          const label = variant + ": ";
          // Before any input: no activation, no running context, no time.
          t.check(label + "page reported its state before the gesture", pre.length >= 5, pre.length + " reports");
          t.check(label + "no user activation before the gesture", pre.every((s) => s.hasBeenActive === false || s.hasBeenActive === null),
            "hasBeenActive " + [...new Set(pre.map((s) => s.hasBeenActive))].join(","));
          if (POLICY_ENFORCED[engine]) {
            t.check(label + "context blocked (suspended or interrupted) and not advancing before the gesture", pre.every((s) => BLOCKED_STATES.includes(s.state) && s.currentTime === 0),
              [...new Set(pre.map((s) => s.state + "@" + s.currentTime))].join(","));
          }
          const v = { pre: { states: [...new Set(pre.map((s) => s.state))], curTicks: [...new Set(pre.map((s) => s.curTick))], play: pre[pre.length - 1].play } };
          if (variant === "timer-play") {
            await sleep(1500);
            const after = states(rec);
            const last = after[after.length - 1];
            t.check(label + "no gesture: context still blocked after playMIDI() from a timer", after.every((s) => BLOCKED_STATES.includes(s.state) && s.currentTime === 0), last.state + "@" + last.currentTime);
            v.noGesture = { play: last.play, curTick: last.curTick, curTicksSeen: [...new Set(after.map((s) => s.curTick))].slice(0, 5), rejections: last.rejections };
            t.observe(label + "status without a gesture", v.noGesture);
          } else {
            const gestureAt = Date.now();
            if (variant === "key-resume") await rec.page.keyboard.press("Enter");
            else await rec.page.click("#start");
            const running = await waitFor(rec, (s) => s.at > gestureAt && s.state === "running", GESTURE_WAIT_MS);
            let advanced = null;
            if (running) {
              // Wait (bounded) until the audio clock has run for 0.5 s; an output stream can take a moment to start.
              const moved = await waitFor(rec, (s) => s.at >= running.at && s.currentTime >= running.currentTime + 0.5, GESTURE_WAIT_MS);
              const last = moved || states(rec).slice(-1)[0];
              advanced = { currentTime: [running.currentTime, last.currentTime], curTick: [running.curTick, last.curTick], play: last.play, msToClock: moved ? moved.at - gestureAt : null };
            }
            const lastState = states(rec).slice(-1)[0];
            v.post = { msToRunning: running ? running.at - gestureAt : null, events: lastState.events, finalState: lastState.state, advanced, rejections: lastState.rejections };
            const hint = engine === "firefox" ? " (Firefox needs an audio output device: run a PulseAudio null sink)"
              : engine === "webkit" && lastState.state === "interrupted" ? " (WebKit reports \"interrupted\" when its audio backend cannot open an output)" : "";
            if (assert) {
              t.check(label + "context running within " + GESTURE_WAIT_MS / 1000 + " s of the real input", !!running,
                running ? v.post.msToRunning + " ms" : "still " + lastState.state + "; events " + JSON.stringify(lastState.events) + hint);
              t.check(label + "audio time advances 0.5 s within " + GESTURE_WAIT_MS / 1000 + " s", !!advanced && advanced.currentTime[1] - advanced.currentTime[0] >= 0.5,
                advanced ? "currentTime " + advanced.currentTime.map((x) => x.toFixed(3)).join(" -> ") : "not running");
              t.check(label + "MIDI playback progresses after the gesture", !!advanced && advanced.curTick[1] > advanced.curTick[0] && advanced.play === 1,
                advanced ? "curTick " + advanced.curTick.join(" -> ") : "not running");
            }
            t.observe(label + "after the gesture" + (assert ? "" : " (observed; phase B asserts the #12 contract)"), v.post);
          }
          t.check(label + "no page errors", !rec.pageErrors.length, rec.pageErrors.slice(0, 2).join(" | "));
          summary[variant] = v;
        }
        t.observe("summary", summary);
      },
    });
  }
  return out;
}

module.exports = { cases, POLICY_ENFORCED };
