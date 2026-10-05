#!/usr/bin/env node
/*
 * Demo pages (#19): simple.html, jstest.html and soundedit.html, loaded from a
 * read-only static server at http://127.0.0.1 with every other host blocked.
 *
 * Asserted per engine:
 *   - loads: no request leaves 127.0.0.1, the vendored webaudio-controls.js
 *     (pinned sha256) defines its elements, no page or console errors, the
 *     controls show the engine's settings (J4, E12), and no AudioContext and
 *     no autoplay warning exist before a gesture (T9-3);
 *   - audio start (T9-3): before any input the page says audio is off and how
 *     to start it, with no AudioContext; a real click or key press creates one
 *     context and starts it; a refused resume() and a closed context are shown;
 *   - URL loading (T9-5): jstest's Load (ws.mid) and soundedit's sample song
 *     show a 404, a network error and a malformed file with the error's code;
 *     a superseded or cancelled load shows nothing and changes nothing; Play
 *     as soundedit's first click plays the sample song;
 *   - file selection: an empty selection and a cancelled dialog do not throw
 *     and say so; a non-MIDI or truncated file shows the loader's error and
 *     keeps the current song; a valid file loads;
 *   - note release (stuck-note oracle below): release outside the element, a
 *     cancelled pointer, lost pointer capture, focus moving away with a key
 *     held, window blur and hidden visibility with a note held, key release,
 *     key repeat, octave change between note-on and note-off, Shift sustain
 *     across a blur, and the latched sustain pedal following a channel change;
 *   - Web MIDI: unsupported, denied, no inputs, inputs appearing and
 *     disappearing (statechange), and a fake input's notes (soundedit);
 *   - the timbre editor (T9-8): every edit installs a new timbre through
 *     setTimbre() (spied), leaving the previously installed array and the
 *     built-in tables unchanged; the Patch text keeps upstream's keys and
 *     order; setTimbre's TypeError and RangeError are shown and nothing
 *     changes; edits are installed again after a quality change; operator
 *     count (E5), the drum shown and edited after a quality change (E7), keys
 *     without a drum (E8), program change on the selected channel (E9), and
 *     edits in both quality modes.
 *
 * Stuck-note oracle: a voice is held when its release time is still the
 * engine's "no end" marker, synth.notetab[i].e >= 99999 (a note that has not
 * been released, or one kept by the sustain pedal). Drum voices never enter
 * notetab. Each scenario first checks that its note sounds, so a release that
 * passes because nothing played fails instead. The page's own record of
 * sounding notes (window.held) must be empty too.
 *
 * Not checkable headlessly (synthetic events stand in for them): a real
 * file-dialog cancel, real window focus loss (alt-tab), a pointer cancelled by
 * the system, hardware MIDI, and a browser that refuses resume() after a real
 * gesture (stubbed). Audible output is not checked here.
 *
 * page.evaluate can count as a user gesture (T9A section 2.3), so the audio
 * start cases read the state before the first input from the page's console
 * reports only, as specs/start.js does.
 *
 * Run: npm run test:browser:demos [-- --engines=chromium,firefox,webkit] [--out=DIR]
 * Each engine runs in its own worker process under scripts/run-with-deadline.js;
 * a browser that cannot launch fails the run. The last line printed starts with
 * "PASS:" or "FAIL:". With --out, screenshots of each state and results.json
 * are written there.
 *
 * The file also exports cases(shared) in the browser matrix's spec shape, so
 * it can be declared in tests/browser/matrix.js later; each case starts its
 * own static server.
 */
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const pages = require("../lib/pages");

const ROOT = pages.ROOT;
const ENGINES = ["chromium", "firefox", "webkit"];
const ENGINE_DEADLINE = 900;
const CONTROLS = "bower_components/webaudio-controls/webaudio-controls.js";
const CONTROLS_SHA256 = "2f780008a1895c3d1b583d99f4f50c35fc2870bf47e117574361465dc5784f65";
const SONG = fs.readFileSync(path.join(ROOT, "ws.mid"));
const SONG_TICKS = 15360;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- page-side helpers ---------------- */

/* eslint-disable no-undef -- these callbacks run in the page */
const HELD = () => window.synth.notetab.filter((nt) => nt.e >= 99999).map((nt) => nt.ch + ":" + nt.n);
const PAGE_HELD = () => Object.keys(window.held);
const READY = () => !!(window.synth && window.synth.isReady && document.getElementById("prog").options.length >= 128);
const BLUR = () => window.dispatchEvent(new Event("blur"));
const HIDE = () => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  document.dispatchEvent(new Event("visibilitychange"));
};
const PAGEHIDE = () => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
const MESSAGE = (id) => {
  const e = document.getElementById(id);
  const r = e.getBoundingClientRect();
  return { text: e.textContent.trim(), visible: r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden", role: e.getAttribute("role") };
};
/* Records where an element is once the page's load handlers have run (before any timer they started). */
const LAYOUT_PROBE = (selector) => {
  window.addEventListener("load", () => setTimeout(() => {
    const e = document.querySelector(selector);
    window.__layoutAtLoad = e ? e.getBoundingClientRect().toJSON() : null;
  }, 0));
};
const LAYOUT_NOW = (selector) => document.querySelector(selector).getBoundingClientRect().toJSON();
const POINTER_RECORDER = () => {
  window.addEventListener("pointerdown", (e) => { window.__lastPointer = { id: e.pointerId, type: e.pointerType }; }, true);
};
const CANCEL_POINTER = (sel) => {
  const b = document.querySelector(sel);
  b.dispatchEvent(new PointerEvent("pointercancel", { pointerId: window.__lastPointer.id, pointerType: window.__lastPointer.type, bubbles: true }));
};
const KB_CHANGE = ([on, key]) => {
  const ev = new Event("change");
  ev.note = [on, key];
  window.kb.dispatchEvent(ev);
};
/*
 * Web MIDI stand-ins (installed before the page's scripts):
 *   unsupported   navigator.requestMIDIAccess removed
 *   denied        requestMIDIAccess rejects with NotAllowedError
 *   empty, one    resolves with a fake MIDIAccess with no inputs or one input;
 *                 window.__fakeMidi.add/remove/send drive it
 */
const MIDI_STUB = (mode) => {
  if (mode === "unsupported") {
    delete Navigator.prototype.requestMIDIAccess;
    delete navigator.requestMIDIAccess;
    return;
  }
  if (mode === "denied") {
    Object.defineProperty(navigator, "requestMIDIAccess", { configurable: true, value: () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")) });
    return;
  }
  class FakeInput extends EventTarget {
    constructor(id, name) {
      super();
      Object.assign(this, { id, name, type: "input", manufacturer: "test", state: "connected", connection: "closed" });
    }
  }
  const inputs = new Map();
  const access = new EventTarget();
  Object.assign(access, { inputs, outputs: new Map(), sysexEnabled: false });
  const changed = (port) => {
    const ev = new Event("statechange");
    ev.port = port;
    access.dispatchEvent(ev);
  };
  window.__fakeMidi = {
    add: (id, name) => { const p = new FakeInput(id, name); inputs.set(id, p); changed(p); },
    remove: (id) => { const p = inputs.get(id); p.state = "disconnected"; inputs.delete(id); changed(p); },
    send: (id, bytes) => {
      const ev = new Event("midimessage");
      const data = new Uint8Array(bytes);
      Object.defineProperty(ev, "data", { value: data });
      inputs.get(id).dispatchEvent(ev);
      return Array.from(data);
    },
  };
  if (mode === "one") inputs.set("in-1", new FakeInput("in-1", "Fake keyboard 1"));
  Object.defineProperty(navigator, "requestMIDIAccess", { configurable: true, value: () => Promise.resolve(access) });
};
/*
 * Audio start probe (installed before the page's scripts): counts AudioContext
 * constructions and unhandled rejections, and reports the page's audio line
 * and the synth's context every 100 ms as console.log("AUDIOSTATE {...}").
 */
const AUDIO_PROBE = () => {
  const a = window.__audio = { contexts: 0, rejections: 0 };
  const Real = window.AudioContext || window.webkitAudioContext;
  if (Real) window.AudioContext = class extends Real { constructor(...args) { super(...args); a.contexts++; } };
  window.addEventListener("unhandledrejection", () => { a.rejections++; });
  const t0 = performance.now();
  setInterval(() => {
    const ctx = window.synth && window.synth.getAudioContext ? window.synth.getAudioContext() : null;
    const e = document.getElementById("audio");
    const r = e ? e.getBoundingClientRect() : null;
    console.log("AUDIOSTATE " + JSON.stringify({
      ms: Math.round(performance.now() - t0), contexts: a.contexts, state: ctx ? ctx.state : null,
      text: e ? e.textContent : null, error: e ? e.className === "error" : null, role: e ? e.getAttribute("role") : null,
      visible: !!r && r.width > 0 && r.height > 0, active: navigator.userActivation ? navigator.userActivation.hasBeenActive : null,
      rejections: a.rejections,
    }));
  }, 100);
};
/* A browser that refuses to start audio: contexts stay "suspended" and resume() rejects. */
const RESUME_REJECT = () => {
  const AC = window.AudioContext || window.webkitAudioContext;
  Object.defineProperty(AC.prototype, "state", { configurable: true, get: () => "suspended" });
  AC.prototype.resume = () => Promise.reject(new DOMException("Blocked by the test", "NotAllowedError"));
};
/* eslint-enable no-undef */

const audioStates = (rec) => rec.console.filter((m) => m.text.startsWith("AUDIOSTATE ")).map((m) => Object.assign(JSON.parse(m.text.slice(11)), { at: m.at }));

async function waitAudio(rec, pred, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const s = audioStates(rec).find(pred);
    if (s || Date.now() > end) return s || null;
    await sleep(50);
  }
}

/* A short valid song (one note, 960 ticks) to tell a file load from ws.mid. */
const SHORT = require("../lib/smf").write({ tracks: [[{ dt: 0, bytes: [0x90, 60, 100] }, { dt: 960, bytes: [0x80, 60, 0] }]] });
const SHORT_TICKS = 960;

/* ---------------- Node-side helpers ---------------- */

async function withStaticServer(fn) {
  const { startServer } = require("../../../scripts/browser-server");
  const srv = await startServer({ staticFiles: true });
  try {
    return await fn(srv);
  } finally {
    await srv.close();
  }
}

/*
 * Opens a demo in a fresh context. Requests to any host other than the static
 * server are aborted and recorded in `remote`. initScripts: [fn, arg] pairs.
 * openPage only loads it (nothing is evaluated in the page); openDemo also
 * waits until the demo is ready.
 */
async function openPage(t, srv, demo, { initScripts = [], contextOptions = {} } = {}) {
  const rec = await t.newPage({ contextOptions: Object.assign({ viewport: { width: 1100, height: 900 } }, contextOptions) });
  rec.remote = [];
  await rec.context.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.origin === srv.origin) return route.continue();
    rec.remote.push(route.request().url());
    return route.abort();
  });
  for (const [fn, arg] of initScripts) await rec.page.addInitScript(fn, arg);
  await rec.page.goto(srv.origin + "/" + demo + ".html", { waitUntil: "load" });
  return rec;
}

async function openDemo(t, srv, demo, opts = {}) {
  const rec = await openPage(t, srv, demo, opts);
  const { initScripts = [] } = opts;
  await rec.page.waitForFunction(READY, null, { timeout: 15000 });
  // With a Web MIDI stand-in the MIDI status settles at once; wait for it, so no line changes under a click.
  if (initScripts.some(([fn]) => fn === MIDI_STUB))
    await rec.page.waitForFunction(() => { const m = document.getElementById("midistatus"); return !m || !/^Requesting/.test(m.textContent); }, null, { timeout: 15000 }); // eslint-disable-line no-undef -- runs in the page
  return rec;
}

async function held(page) {
  return { voices: await page.evaluate(HELD), page: await page.evaluate(PAGE_HELD) };
}

/* Waits until the expected voice is held (the note sounded), up to 2 s. */
async function waitSounding(page, expected) {
  const end = Date.now() + 2000;
  for (;;) {
    const v = await page.evaluate(HELD);
    if ((expected ? v.includes(expected) : v.length > 0) || Date.now() > end) return v;
    await sleep(50);
  }
}

/* Checks that the note sounded, runs the release, then checks that nothing is held. */
async function scenario(t, rec, label, { press, sounding, release, after }) {
  if (press) await press();
  const on = await waitSounding(rec.page, sounding);
  t.check(label + ": the note sounds" + (sounding ? " (" + sounding + ")" : ""), sounding ? on.includes(sounding) : on.length > 0, "held " + JSON.stringify(on));
  await release();
  await sleep(300);
  const h = await held(rec.page);
  t.check(label + ": no voice held after the release", h.voices.length === 0, "held voices " + JSON.stringify(h.voices));
  t.check(label + ": the page tracks no sounding note", h.page.length === 0, "page notes " + JSON.stringify(h.page));
  if (after) await after();
  t.check(label + ": no page errors", !rec.pageErrors.length, rec.pageErrors.join(" | "));
}

/* Clicks the soundedit octave radio button for -2..+2. */
function octave(page, o) {
  return page.locator("input[name=oct]").nth(o + 2).check();
}

async function box(page, selector) {
  const b = await page.locator(selector).boundingBox();
  if (!b) throw new Error("no layout box for " + selector);
  return b;
}

async function shot(t, rec, name) {
  if (!t.out) return;
  t.save(path.join("screenshots", name + ".png"), await rec.page.screenshot({ fullPage: true }));
}

function setFile(page, selector, name, buffer) {
  return page.setInputFiles(selector, { name, mimeType: "audio/midi", buffer });
}

async function waitText(page, id, re, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const m = await page.evaluate(MESSAGE, id);
    if (re.test(m.text) || Date.now() > end) return m;
    await sleep(50);
  }
}

/* ---------------- cases ---------------- */

const DEMOS = ["simple", "jstest", "soundedit"];
/* An element below every line a demo fills in after load (the play status), for the layout check. */
const BELOW_STATUS = { jstest: "button[data-note='60']", soundedit: "input[name=oct]" };
const ELEMENTS = { simple: ["webaudio-keyboard"], jstest: [], soundedit: ["webaudio-keyboard", "webaudio-knob", "webaudio-switch"] };

function loadCase(demo) {
  return {
    id: "demos load " + demo,
    dims: { demo },
    deadline: 60,
    run: (t) => withStaticServer(async (srv) => {
      if (demo === "simple") {
        const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, CONTROLS))).digest("hex");
        t.check("vendored " + CONTROLS + " has the pinned sha256", hash === CONTROLS_SHA256, hash);
      }
      const rec = await openDemo(t, srv, demo, { initScripts: [[AUDIO_PROBE]] });
      await sleep(1000);
      const state = await rec.page.evaluate((names) => ({
        defined: names.filter((n) => !!customElements.get(n)), // eslint-disable-line no-undef -- runs in the page
        title: document.title, // eslint-disable-line no-undef -- runs in the page
        contexts: window.__audio.contexts, // eslint-disable-line no-undef -- runs in the page
      }), ELEMENTS[demo]);
      const autoplay = rec.console.filter((m) => m.type === "warning" && /AudioContext|autoplay/i.test(m.text)).map((m) => m.text);
      t.check("no AudioContext is created before a gesture (T9-3)", state.contexts === 0, state.contexts + " contexts");
      t.check("no autoplay warning at load (T9-3)", autoplay.length === 0, autoplay.join(" | "));
      const audioLine = await rec.page.evaluate(MESSAGE, "audio").catch((e) => ({ text: "no audio line: " + String(e.message).split("\n")[0] }));
      t.check("the audio line says audio is off and how to start it (T9-3)", /^Audio is off\. Click, tap or press a key to start it\.$/.test(audioLine.text) && audioLine.visible && audioLine.role === "status",
        JSON.stringify(audioLine));
      t.check("no request leaves 127.0.0.1", rec.remote.length === 0, rec.remote.join(" "));
      const local = srv.requests.filter((r) => r.status !== 200).map((r) => r.path + " " + r.status);
      t.check("every local request succeeds", local.length === 0, local.join(" "));
      if (ELEMENTS[demo].length) {
        t.check("the vendored controls were loaded", srv.requests.some((r) => r.path === "/" + CONTROLS && r.status === 200), srv.requests.map((r) => r.path).join(" "));
        t.check("the control elements are defined", state.defined.length === ELEMENTS[demo].length, state.defined.join(","));
      }
      t.check("no page errors", !rec.pageErrors.length, rec.pageErrors.join(" | "));
      t.check("no console errors", !rec.consoleErrors.length, rec.consoleErrors.join(" | "));
      t.observe("console warnings", rec.console.filter((m) => m.type === "warning").map((m) => m.text));
      /* eslint-disable no-undef -- these callbacks run in the page */
      if (demo === "jstest") {
        const ui = await rec.page.evaluate(() => ({
          vol: +document.getElementById("vol").value, rev: +document.getElementById("rev").value,
          loop: document.getElementById("loop").checked, quality: document.getElementById("quality").selectedIndex,
          engine: { vol: synth.masterVol, rev: synth.reverbLev, loop: !!synth.loop, quality: synth.quality ? 1 : 0 },
        }));
        t.check("sliders, loop and quality show the engine's settings (J4)", ui.vol === ui.engine.vol * 100 && ui.rev === ui.engine.rev * 100 &&
          ui.loop === ui.engine.loop && ui.quality === ui.engine.quality, JSON.stringify(ui));
      }
      if (demo === "soundedit") {
        const ui = await rec.page.evaluate(() => ({
          vol: +document.getElementById("vol").value, rev: +document.getElementById("rev").value,
          loop: +document.getElementById("loop").value, quality: document.getElementById("quality").selectedIndex,
          engine: { vol: synth.masterVol, rev: synth.reverbLev, loop: synth.loop ? 1 : 0, quality: synth.quality ? 1 : 0 },
        }));
        t.check("knobs, loop switch and quality show the engine's settings (E12)", ui.vol === ui.engine.vol && ui.rev === ui.engine.rev &&
          ui.loop === ui.engine.loop && ui.quality === ui.engine.quality, JSON.stringify(ui));
        const midi = await rec.page.evaluate(MESSAGE, "midistatus");
        t.check("the Web MIDI state is shown in the page", midi.text.length > 0 && midi.visible && midi.role === "status", JSON.stringify(midi));
        t.observe("Web MIDI status without a stand-in", midi.text);
      }
      /* eslint-enable no-undef */
      await shot(t, rec, demo + "-loaded");
      if (demo === "soundedit") {
        await rec.page.click("text=Timbre Editor");
        await shot(t, rec, demo + "-editor");
      }
      if (BELOW_STATUS[demo]) {
        // The controls must not move after load: a status line filled in by a later timer moved them
        // under a pending click once ready() resolved at once (the demos' readiness no longer waits 100 ms).
        const sel = BELOW_STATUS[demo];
        const lp = await openDemo(t, srv, demo, { initScripts: [[LAYOUT_PROBE, sel], [MIDI_STUB, "empty"]] });
        await sleep(600);
        const at = await lp.page.evaluate(() => window.__layoutAtLoad); // eslint-disable-line no-undef -- runs in the page
        const now = await lp.page.evaluate(LAYOUT_NOW, sel);
        t.check("the controls do not move after load (" + sel + ")", !!at && Math.abs(at.x - now.x) < 0.5 && Math.abs(at.y - now.y) < 0.5,
          "after the load handlers " + JSON.stringify(at && { x: at.x, y: at.y }) + ", 600 ms later " + JSON.stringify({ x: now.x, y: now.y }));
      }
    }),
  };
}

/*
 * T9-3: audio starts from the first gesture, in a fresh page per variant:
 *   click     a real click (jstest: on "Test audioContext", which uses the context)
 *   key       a real key press (Enter) with nothing focused
 *   rejected  the browser refuses: resume() rejects with NotAllowedError (stubbed)
 *   closed    the context is closed after audio started; the next click is refused
 * Nothing is evaluated in the page before the gesture.
 */
const PRE_GESTURE_MS = 1200;
const GESTURE_WAIT_MS = 10000;
const CLICK_TARGET = { simple: "h1", jstest: "text=Test audioContext", soundedit: "h1" };

function audioCase(demo) {
  return {
    id: "demos audio start " + demo,
    dims: { demo },
    deadline: 120,
    run: (t) => withStaticServer(async (srv) => {
      for (const variant of ["click", "key", "rejected", "closed"]) {
        const label = variant + ": ";
        const scripts = (variant === "rejected" ? [[RESUME_REJECT]] : []).concat([[AUDIO_PROBE]], demo === "soundedit" ? [[MIDI_STUB, "empty"]] : []);
        const rec = await openPage(t, srv, demo, { initScripts: scripts });
        const p = rec.page;
        await sleep(PRE_GESTURE_MS);
        const pre = audioStates(rec);
        const last = pre[pre.length - 1] || {};
        t.check(label + "the page reported its audio state before any input", pre.length >= 5, pre.length + " reports");
        t.check(label + "no user activation before the gesture", pre.every((x) => x.active !== true), [...new Set(pre.map((x) => x.active))].join(","));
        t.check(label + "no AudioContext before a gesture", pre.every((x) => x.contexts === 0 && x.state === null), [...new Set(pre.map((x) => x.contexts + "@" + x.state))].join(","));
        t.check(label + "the page says audio is off and how to start it", /^Audio is off\. Click, tap or press a key to start it\.$/.test(last.text) && last.visible && last.role === "status" && !last.error, JSON.stringify(last));
        const warned = rec.console.filter((m) => m.type === "warning" && /AudioContext|autoplay/i.test(m.text)).map((m) => m.text);
        t.check(label + "no autoplay warning before a gesture", warned.length === 0, warned.join(" | "));
        if (variant === "click" || variant === "rejected") await shot(t, rec, demo + "-audio-off");
        const gestureAt = Date.now();
        if (variant === "key") await p.keyboard.press("Enter");
        else await p.click(CLICK_TARGET[demo]);
        if (variant === "rejected") {
          const shown = await waitAudio(rec, (x) => x.at > gestureAt && /^Audio could not start/.test(x.text), GESTURE_WAIT_MS);
          t.check(label + "the refused resume() is shown with its error", !!shown && shown.text === "Audio could not start (NotAllowedError: Blocked by the test). Click, tap or press a key to try again." && shown.error && shown.visible,
            JSON.stringify(shown || audioStates(rec).slice(-1)[0]));
          t.check(label + "one AudioContext, created by the gesture", !!shown && shown.contexts === 1, shown ? shown.contexts + " contexts" : "");
          await shot(t, rec, demo + "-audio-refused");
        } else {
          const running = await waitAudio(rec, (x) => x.at > gestureAt && x.state === "running" && x.text === "Audio is on.", GESTURE_WAIT_MS);
          const now = audioStates(rec).slice(-1)[0];
          t.check(label + "the gesture starts audio and the page says so", !!running && !running.error, JSON.stringify(running || now));
          t.observe(label + "ms from the input to running", running ? running.at - gestureAt : null);
          t.check(label + "exactly one AudioContext", !!running && running.contexts === 1 && now.contexts === 1, now.contexts + " contexts");
          if (variant === "closed") {
            await p.evaluate(() => window.synth.getAudioContext().close()); // eslint-disable-line no-undef -- runs in the page
            const closed = await waitAudio(rec, (x) => x.state === "closed" && /^Audio is closed/.test(x.text), 3000);
            const at = Date.now();
            await p.click("h1");
            await sleep(500);
            const after = audioStates(rec).filter((x) => x.at > at).slice(-1)[0];
            t.check(label + "a closed context is shown, and stays shown after a click (resume() rejects)",
              !!closed && closed.text === "Audio is closed. Reload the page to start it again." && !!after && after.text === closed.text && after.contexts === 1,
              JSON.stringify({ closed, after }));
          }
          if (variant === "click") await shot(t, rec, demo + "-audio-on");
        }
        const final = audioStates(rec).slice(-1)[0];
        t.check(label + "no request leaves 127.0.0.1", rec.remote.length === 0, rec.remote.join(" "));
        t.check(label + "no unhandled rejections", final.rejections === 0, final.rejections + " rejections");
        t.check(label + "no page errors", !rec.pageErrors.length, rec.pageErrors.join(" | "));
        t.check(label + "no console errors", !rec.consoleErrors.length, rec.consoleErrors.join(" | "));
      }
    }),
  };
}

/*
 * T9-5: URL loads. jstest's Load (ws.mid) and soundedit's sample song (loaded
 * by Play when no song is loaded) with ws.mid answered by a 404, a refused
 * connection or a non-MIDI body show the error's code; nothing is installed.
 * jstest: a successful load says so; a load superseded by a second click shows
 * nothing. Both: a load cancelled by choosing a file shows nothing and does
 * not replace the file's song. soundedit: Play as the first click plays the
 * sample song.
 */
const URL_FAILURES = {
  "HTTP 404": { route: (r) => r.fulfill({ status: 404, contentType: "text/plain", body: "not found" }), code: "HTTP_STATUS 404" },
  "connection refused": { route: (r) => r.abort("connectionrefused"), code: "NETWORK_ERROR" },
  "not a MIDI file": { route: (r) => r.fulfill({ status: 200, contentType: "audio/midi", body: "this is not a MIDI file\n" }), code: "SMF_INVALID_HEADER: no MThd header (byte 0)" },
};

function urlCase(demo) {
  const jstest = demo === "jstest";
  const start = (p) => p.click(jstest ? "text=Load (ws.mid)" : "button:text-is('Play')");
  const tail = jstest ? "The current song is unchanged." : "Choose a MIDI file instead.";
  /* eslint-disable no-undef -- these callbacks run in the page */
  const status = (p) => p.evaluate(() => window.synth.getPlayStatus());
  const rejections = (p) => p.evaluate(() => window.__audio.rejections);
  /* eslint-enable no-undef */
  const open = (srv, t) => openDemo(t, srv, demo, { initScripts: [[AUDIO_PROBE]].concat(jstest ? [] : [[MIDI_STUB, "empty"]]) });
  /* Answers ws.mid after ms with the song, unless the request was aborted first. */
  const late = (ms, seen) => async (route) => {
    seen.push(Date.now());
    await sleep(ms);
    try { await route.fulfill({ status: 200, contentType: "audio/midi", body: SONG }); } catch { /* the page aborted it */ }
  };
  return {
    id: "demos url loading " + demo,
    dims: { demo },
    deadline: 120,
    run: (t) => withStaticServer(async (srv) => {
      for (const [kind, f] of Object.entries(URL_FAILURES)) {
        const rec = await open(srv, t), p = rec.page;
        await p.route("**/ws.mid", f.route);
        await start(p);
        const m = await waitText(p, "message", /^Could not load ws\.mid/, 5000);
        const want = "Could not load ws.mid (" + f.code + "). " + tail;
        t.check(kind + ": the error is shown with its code", m.text === want && m.visible && m.role === "status", JSON.stringify(m) + " want " + want);
        const st = await status(p);
        t.check(kind + ": no song is installed", st.maxTick === 0 && st.play === 0, JSON.stringify(st));
        t.check(kind + ": no unhandled rejections and no page errors", (await rejections(p)) === 0 && !rec.pageErrors.length, rec.pageErrors.join(" | "));
        t.observe(kind + ": console errors (the browser's own resource errors)", rec.consoleErrors);
        if (kind === "HTTP 404") await shot(t, rec, demo + "-url-error");
      }
      if (jstest) {
        {
          const rec = await open(srv, t), p = rec.page;
          await start(p);
          const m = await waitText(p, "message", /^Loaded ws\.mid/, 5000);
          const st = await status(p);
          t.check("success: the song is installed and the page says so", m.text === "Loaded ws.mid. Press Play." && !/error/.test(await p.getAttribute("#message", "class") || "") && st.maxTick === SONG_TICKS,
            JSON.stringify({ m, st }));
          t.check("success: no page or console errors", !rec.pageErrors.length && !rec.consoleErrors.length, rec.pageErrors.concat(rec.consoleErrors).join(" | "));
        }
        {
          // Superseded: the first load is answered late with a 404, after a second click has started a new load.
          const rec = await open(srv, t), p = rec.page, seen = [];
          await p.route("**/ws.mid", async (route) => {
            seen.push(Date.now());
            if (seen.length === 1) {
              await sleep(1500);
              try { await route.fulfill({ status: 404, contentType: "text/plain", body: "late" }); } catch { /* the page aborted it */ }
              return;
            }
            await route.continue();
          });
          await start(p);
          await sleep(200);
          await start(p);
          const m = await waitText(p, "message", /^Loaded ws\.mid/, 5000);
          await sleep(2000);
          const m2 = await p.evaluate(MESSAGE, "message");
          const st = await status(p);
          t.check("superseded: only the newer load reports, and the song is installed", m.text === "Loaded ws.mid. Press Play." && m2.text === m.text && st.maxTick === SONG_TICKS && seen.length === 2,
            JSON.stringify({ m: m.text, later: m2.text, st, requests: seen.length }));
          t.check("superseded: no unhandled rejections and no page errors", (await rejections(p)) === 0 && !rec.pageErrors.length, rec.pageErrors.join(" | "));
        }
      } else {
        {
          // Play as the first click: it starts audio, loads the sample song and plays it.
          const rec = await open(srv, t), p = rec.page;
          await start(p);
          const end = Date.now() + 5000;
          let st;
          while (!((st = await status(p)).play === 1 && st.maxTick === SONG_TICKS) && Date.now() < end) await sleep(100);
          t.check("Play as the first click plays the sample song", st.play === 1 && st.maxTick === SONG_TICKS, JSON.stringify(st));
          const m = await p.evaluate(MESSAGE, "message");
          t.check("Play as the first click: no message, no page or console errors", m.text === "" && !rec.pageErrors.length && !rec.consoleErrors.length, JSON.stringify(m) + " " + rec.pageErrors.concat(rec.consoleErrors).join(" | "));
          await p.click("button:text-is('Stop')");
        }
      }
      {
        // Cancelled: a file is chosen while the URL load is pending; the late response must not replace it.
        const rec = await open(srv, t), p = rec.page, seen = [];
        await p.route("**/ws.mid", late(1500, seen));
        await start(p);
        if (jstest) {
          const loading = await waitText(p, "message", /^Loading/, 2000);
          t.check("a pending load says so", loading.text === "Loading ws.mid...", JSON.stringify(loading));
        }
        await setFile(p, "#file", "short.mid", SHORT);
        const m = await waitText(p, "message", /^Loaded short\.mid/, 3000);
        await sleep(2500);
        const m2 = await p.evaluate(MESSAGE, "message");
        const st = await status(p);
        t.check("cancelled by choosing a file: the file's song stays and only the file reports", m.text === "Loaded short.mid. Press Play." && m2.text === m.text && st.maxTick === SHORT_TICKS && seen.length === 1,
          JSON.stringify({ m: m.text, later: m2.text, st, requests: seen.length }));
        t.check("cancelled: no unhandled rejections and no page errors", (await rejections(p)) === 0 && !rec.pageErrors.length, rec.pageErrors.join(" | "));
      }
    }),
  };
}

function fileCase(demo) {
  const input = "#file";
  const loaded = demo === "simple" ? /^Playing ws\.mid\.$/ : /^Loaded ws\.mid\. Press Play\.$/;
  return {
    id: "demos file selection " + demo,
    dims: { demo },
    deadline: 60,
    run: (t) => withStaticServer(async (srv) => {
      const rec = await openDemo(t, srv, demo);
      const p = rec.page;
      await p.setInputFiles(input, []);
      let m = await waitText(p, "message", /No file selected/);
      t.check("an empty selection does not throw and says so", /No file selected/.test(m.text) && m.visible && m.role === "status", JSON.stringify(m));
      await p.evaluate(() => document.getElementById("message").textContent = ""); // eslint-disable-line no-undef -- runs in the page
      await p.locator(input).dispatchEvent("cancel");
      m = await waitText(p, "message", /No file selected/);
      t.check("a cancelled file dialog (cancel event) says the song is unchanged", /No file selected.*unchanged/.test(m.text), JSON.stringify(m));
      await setFile(p, input, "ws.mid", SONG);
      m = await waitText(p, "message", loaded);
      const st1 = await p.evaluate(() => synth.getPlayStatus()); // eslint-disable-line no-undef -- runs in the page
      t.check("a valid file loads", loaded.test(m.text) && st1.maxTick === SONG_TICKS, m.text + "; " + JSON.stringify(st1));
      if (demo === "simple") t.check("simple: a valid file plays", st1.play === 1, JSON.stringify(st1));
      await setFile(p, input, "notes.txt", Buffer.from("this is not a MIDI file\n"));
      m = await waitText(p, "message", /Could not load/);
      const st2 = await p.evaluate(() => synth.getPlayStatus()); // eslint-disable-line no-undef -- runs in the page
      t.check("a non-MIDI file shows the loader's error", /^Could not load notes\.txt \(SMF_INVALID_HEADER: .+\)\. The current song is unchanged\.$/.test(m.text) && m.visible, JSON.stringify(m));
      t.check("a non-MIDI file keeps the current song", st2.maxTick === SONG_TICKS && st2.play === st1.play, JSON.stringify(st2));
      await shot(t, rec, demo + "-file-error");
      await setFile(p, input, "truncated.mid", SONG.subarray(0, 40));
      m = await waitText(p, "message", /truncated\.mid/);
      t.check("a truncated file shows the loader's error", /^Could not load truncated\.mid \(SMF_TRUNCATED: .+\)\. The current song is unchanged\.$/.test(m.text), m.text);
      t.check("no page errors", !rec.pageErrors.length, rec.pageErrors.join(" | "));
      t.check("no console errors", !rec.consoleErrors.length, rec.consoleErrors.join(" | "));
    }),
  };
}

function simpleReleaseCase() {
  return {
    id: "demos note release simple",
    dims: { demo: "simple" },
    deadline: 90,
    run: (t) => withStaticServer(async (srv) => {
      const open = () => openDemo(t, srv, "simple");
      const firstKey = async (p) => { const b = await box(p, "#keyboard"); return { x: b.x + 8, y: b.y + b.height * 0.85, b }; };
      const focusKb = (p) => p.locator("#keyboard canvas").focus();
      {
        const rec = await open(), p = rec.page, k = await firstKey(p);
        await scenario(t, rec, "mouse released outside the keyboard", {
          press: async () => { await p.mouse.move(k.x, k.y); await p.mouse.down(); }, sounding: "0:48",
          release: async () => { await p.mouse.move(k.x, k.b.y + k.b.height + 150); await p.mouse.up(); },
        });
      }
      {
        const rec = await open(), p = rec.page, k = await firstKey(p);
        await scenario(t, rec, "mouse held, window blur", {
          press: async () => { await p.mouse.move(k.x, k.y); await p.mouse.down(); }, sounding: "0:48",
          release: () => p.evaluate(BLUR),
          after: async () => {
            // The lost mouseup must not leave the keyboard dragging: moving over it plays nothing.
            await p.mouse.move(k.x + k.b.width / 2, k.y, { steps: 4 });
            await sleep(200);
            const h = await held(p);
            t.check("mouse held, window blur: moving over the keyboard afterwards plays nothing", h.voices.length === 0 && h.page.length === 0, JSON.stringify(h));
            await p.mouse.up();
          },
        });
      }
      {
        const rec = await open(), p = rec.page;
        await focusKb(p);
        await scenario(t, rec, "QWERTY key pressed and released", {
          press: async () => {
            await p.keyboard.down("z");
            await p.keyboard.down("z"); // auto-repeat
            const v = await waitSounding(p, "0:48");
            t.check("QWERTY key repeat starts one voice", v.filter((x) => x === "0:48").length === 1, JSON.stringify(v));
          },
          sounding: "0:48",
          release: () => p.keyboard.up("z"),
        });
        await focusKb(p);
        await scenario(t, rec, "QWERTY key held, focus moved to another control", {
          press: () => p.keyboard.down("x"), sounding: "0:50",
          release: () => p.locator("#prog").focus(),
          after: () => p.keyboard.up("x"),
        });
        await focusKb(p);
        await scenario(t, rec, "the same QWERTY key plays again after the focus came back", {
          press: () => p.keyboard.down("x"), sounding: "0:50",
          release: () => p.keyboard.up("x"),
        });
      }
      {
        const rec = await open(), p = rec.page;
        await focusKb(p);
        await scenario(t, rec, "QWERTY key held, page hidden (visibilitychange)", {
          press: () => p.keyboard.down("c"), sounding: "0:52",
          release: () => p.evaluate(HIDE),
          after: () => p.keyboard.up("c"),
        });
      }
      {
        const rec = await open(), p = rec.page;
        await focusKb(p);
        await scenario(t, rec, "QWERTY key held, pagehide", {
          press: () => p.keyboard.down("v"), sounding: "0:53",
          release: () => p.evaluate(PAGEHIDE),
          after: () => p.keyboard.up("v"),
        });
      }
    }),
  };
}

/* jstest note buttons and the soundedit shot button share the pointer and key handling. */
function buttonScenarios(t, open, { buttons, sounding, away }) {
  return (async () => {
    {
      const rec = await open(), p = rec.page, b = await box(p, buttons[0]);
      await scenario(t, rec, "pointer released outside the button", {
        press: async () => { await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await p.mouse.down(); }, sounding: sounding[0],
        // Above the button, inside the viewport: a release outside the viewport is not delivered by every engine's automation.
        release: async () => { await p.mouse.move(b.x + b.width / 2, b.y - 60); await p.mouse.up(); },
      });
    }
    {
      const rec = await open(), p = rec.page, b = await box(p, buttons[1]);
      await scenario(t, rec, "pointer cancelled (pointercancel)", {
        press: async () => { await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await p.mouse.down(); }, sounding: sounding[1],
        release: () => p.evaluate(CANCEL_POINTER, buttons[1]),
        after: () => p.mouse.up(),
      });
    }
    {
      const rec = await open(), p = rec.page, b = await box(p, buttons[0]);
      await scenario(t, rec, "pointer capture lost (releasePointerCapture)", {
        press: async () => {
          await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
          await p.mouse.down();
          await p.mouse.move(b.x + b.width / 2 + 2, b.y + b.height / 2); // the capture takes effect at the next pointer event
        },
        sounding: sounding[0],
        release: async () => {
          await p.evaluate((sel) => document.querySelector(sel).releasePointerCapture(window.__lastPointer.id), buttons[0]); // eslint-disable-line no-undef -- runs in the page
          await p.mouse.move(b.x + b.width / 2 + 1, b.y + b.height / 2 + 1); // lostpointercapture comes with the next pointer event
        },
        after: () => p.mouse.up(),
      });
    }
    {
      const rec = await open(), p = rec.page, b = await box(p, buttons[1]);
      await scenario(t, rec, "pointer held, window blur", {
        press: async () => { await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await p.mouse.down(); }, sounding: sounding[1],
        release: () => p.evaluate(BLUR),
        after: () => p.mouse.up(),
      });
    }
    {
      const rec = await open(), p = rec.page;
      for (const key of ["Space", "Enter"]) {
        await p.locator(buttons[0]).focus();
        await scenario(t, rec, key + " pressed and released on the focused button", {
          press: async () => {
            await p.keyboard.down(key);
            await p.keyboard.down(key); // auto-repeat
            const v = await waitSounding(p, sounding[0]);
            t.check(key + ": key repeat starts one voice", v.filter((x) => x === sounding[0]).length === 1, JSON.stringify(v));
          },
          sounding: sounding[0],
          release: () => p.keyboard.up(key),
        });
      }
      await p.locator(buttons[1]).focus();
      await scenario(t, rec, "Space held, focus moved away (" + away.label + ")", {
        press: () => p.keyboard.down("Space"), sounding: sounding[1],
        release: () => away.run(p),
        after: () => p.keyboard.up("Space"),
      });
    }
  })();
}

function jstestReleaseCase() {
  return {
    id: "demos note release jstest",
    dims: { demo: "jstest" },
    deadline: 90,
    run: (t) => withStaticServer(async (srv) => {
      const open = () => openDemo(t, srv, "jstest", { initScripts: [[POINTER_RECORDER]] });
      await buttonScenarios(t, open, {
        buttons: ["button[data-note='60']", "button[data-note='62']"], sounding: ["0:60", "0:62"],
        away: { label: "Tab", run: (p) => p.keyboard.press("Tab") },
      });
      {
        const rec = await open(), p = rec.page;
        await p.locator("button[data-note='64']").focus();
        await scenario(t, rec, "Space held, page hidden (visibilitychange)", {
          press: () => p.keyboard.down("Space"), sounding: "0:64",
          release: () => p.evaluate(HIDE),
          after: () => p.keyboard.up("Space"),
        });
      }
      // Touch: a tap through the touchscreen, where the engine emulates one.
      {
        const rec = await openDemo(t, srv, "jstest", { contextOptions: { hasTouch: true } });
        const p = rec.page, b = await box(p, "button[data-note='69']");
        let tapped;
        try {
          await p.evaluate(() => { window.__notes = []; const s = synth.send; synth.send = (m, tt) => { window.__notes.push(Array.from(m)); return s(m, tt); }; }); // eslint-disable-line no-undef -- runs in the page
          await p.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
          await sleep(300);
          tapped = await p.evaluate(() => window.__notes); // eslint-disable-line no-undef -- runs in the page
        } catch (e) {
          tapped = "touch emulation unavailable: " + String(e.message).split("\n")[0];
        }
        t.observe("touch tap on the A button (messages sent)", tapped);
        const h = await held(p);
        t.check("touch tap: no voice held afterwards", h.voices.length === 0 && h.page.length === 0, JSON.stringify(h));
      }
    }),
  };
}

function soundeditReleaseCase() {
  return {
    id: "demos note release soundedit",
    dims: { demo: "soundedit" },
    deadline: 120,
    run: (t) => withStaticServer(async (srv) => {
      const open = (mode = "empty") => openDemo(t, srv, "soundedit", { initScripts: [[POINTER_RECORDER], [MIDI_STUB, mode]] });
      // The shot button plays the last keyboard note (60 at load) on the selected channel.
      // The shot button is the last focusable element, and Tab from it leaves headless Firefox's focus in place.
      await buttonScenarios(t, open, {
        buttons: ["#shot", "#shot"], sounding: ["0:60", "0:60"],
        away: { label: "focus moved to the Prog select", run: (p) => p.locator("#prog").focus() },
      });
      const firstKey = async (p) => { const b = await box(p, "#kb"); return { x: b.x + 5, y: b.y + b.height * 0.85, b }; };
      const focusKb = (p) => p.locator("#kb canvas").focus();
      {
        const rec = await open(), p = rec.page, k = await firstKey(p);
        await scenario(t, rec, "keyboard: mouse released outside", {
          press: async () => { await p.mouse.move(k.x, k.y); await p.mouse.down(); }, sounding: "0:35",
          release: async () => { await p.mouse.move(k.x, k.b.y - 100); await p.mouse.up(); },
        });
        await scenario(t, rec, "keyboard: octave changed between note-on and note-off (E2)", {
          press: async () => { await p.mouse.move(k.x, k.y); await p.mouse.down(); await p.evaluate(() => OctChange(1)); }, // eslint-disable-line no-undef -- runs in the page
          sounding: "0:35",
          release: () => p.mouse.up(),
        });
        await p.evaluate(() => OctChange(0)); // eslint-disable-line no-undef -- runs in the page
      }
      {
        const rec = await open(), p = rec.page;
        await focusKb(p);
        await p.keyboard.down("Shift");
        const sus1 = await p.isChecked("#sus");
        await scenario(t, rec, "Shift sustain held, note released, window blur", {
          press: async () => { await p.keyboard.down("z"); await p.keyboard.up("z"); }, sounding: "0:36",
          release: () => p.evaluate(BLUR),
          after: () => p.keyboard.up("Shift"),
        });
        const sus2 = await p.isChecked("#sus");
        const ch = await p.evaluate(() => synth.sustain[0]); // eslint-disable-line no-undef -- runs in the page
        t.check("Shift sustain: on while Shift is down, off after the blur", sus1 && !sus2 && ch < 64, "checkbox " + sus1 + " -> " + sus2 + ", CC64 " + ch);
      }
      {
        const rec = await open(), p = rec.page, k = await firstKey(p);
        await p.check("#sus");
        await p.mouse.move(k.x, k.y);
        await p.mouse.down();
        await p.mouse.up();
        await p.evaluate(BLUR);
        await sleep(200);
        const kept = await p.evaluate(HELD);
        t.check("latched sustain keeps the released note through a blur (the pedal is down)", kept.includes("0:35"), JSON.stringify(kept));
        await scenario(t, rec, "latched sustain follows a channel change", {
          sounding: "0:35",
          release: () => p.selectOption("#ch", { index: 1 }),
        });
        const sus = await p.evaluate(() => [synth.sustain[0], synth.sustain[1]]); // eslint-disable-line no-undef -- runs in the page
        t.check("latched sustain moved to the new channel", sus[0] < 64 && sus[1] >= 64, JSON.stringify(sus));
        await p.uncheck("#sus");
      }
      {
        const rec = await open("one"), p = rec.page;
        await p.waitForFunction(() => document.getElementById("midiport").options.length === 2); // eslint-disable-line no-undef -- runs in the page
        let sent = null;
        await scenario(t, rec, "MIDI input: octave changed between note-on and note-off", {
          press: async () => { sent = await p.evaluate(() => window.__fakeMidi.send("in-1", [0x90, 60, 100])); await octave(p, 1); }, // eslint-disable-line no-undef -- runs in the page
          sounding: "0:60",
          release: () => p.evaluate(() => window.__fakeMidi.send("in-1", [0x80, 60, 0])), // eslint-disable-line no-undef -- runs in the page
        });
        t.check("MIDI input: the message is not modified", JSON.stringify(sent) === "[144,60,100]", JSON.stringify(sent));
        await octave(p, 2);
        const r = await p.evaluate(() => { const d = window.__fakeMidi.send("in-1", [0x91, 110, 100]); return { d, held: window.synth.notetab.filter((nt) => nt.e >= 99999).map((nt) => nt.ch + ":" + nt.n) }; }); // eslint-disable-line no-undef -- runs in the page
        t.check("MIDI input: a note shifted past 127 is not played and does not wrap", r.held.length === 0 && JSON.stringify(r.d) === "[145,110,100]", JSON.stringify(r));
        await p.evaluate(() => window.__fakeMidi.send("in-1", [0x81, 110, 0])); // eslint-disable-line no-undef -- runs in the page
        await octave(p, 0);
        await scenario(t, rec, "MIDI input: note held, window blur", {
          press: () => p.evaluate(() => window.__fakeMidi.send("in-1", [0x92, 64, 90])), // eslint-disable-line no-undef -- runs in the page
          sounding: "2:64",
          release: () => p.evaluate(BLUR),
        });
        await scenario(t, rec, "MIDI input: note held, its port disconnected", {
          press: () => p.evaluate(() => window.__fakeMidi.send("in-1", [0x90, 67, 90])), // eslint-disable-line no-undef -- runs in the page
          sounding: "0:67",
          release: () => p.evaluate(() => window.__fakeMidi.remove("in-1")), // eslint-disable-line no-undef -- runs in the page
        });
      }
      /* eslint-disable no-undef -- these callbacks run in the page */
      {
        const rec = await open("one"), p = rec.page;
        await p.waitForFunction(() => document.getElementById("midiport").options.length === 2);
        const midi = (bytes) => p.evaluate((b) => window.__fakeMidi.send("in-1", b), bytes);
        const selected = () => p.evaluate(() => ({ index: document.getElementById("midiport").selectedIndex, current: currentPort }));
        await scenario(t, rec, "MIDI input: another input connected and removed while a note is held", {
          press: () => midi([0x90, 65, 90]), sounding: "0:65",
          release: async () => {
            await p.evaluate(() => window.__fakeMidi.add("in-2", "Fake keyboard 2"));
            await waitText(p, "midistatus", /^2 MIDI inputs connected\.$/);
            const plugged = await p.evaluate(HELD);
            await p.evaluate(() => window.__fakeMidi.remove("in-2"));
            await waitText(p, "midistatus", /^1 MIDI input connected\.$/);
            const unplugged = await p.evaluate(HELD);
            const sel = await selected();
            t.check("MIDI input: hot-plug of another input keeps the held note and the selection", plugged.includes("0:65") && unplugged.includes("0:65") && sel.index === 1 && sel.current === 0,
              JSON.stringify({ plugged, unplugged, sel }));
            await midi([0x80, 65, 0]);
          },
        });
        await scenario(t, rec, "MIDI input: sustain pedal down, note released, window blur", {
          press: async () => { await midi([0xb0, 64, 127]); await midi([0x90, 62, 90]); await midi([0x80, 62, 0]); }, sounding: "0:62",
          release: () => p.evaluate(BLUR),
        });
        const pedal1 = await p.evaluate(() => synth.sustain[0]);
        t.check("MIDI input: the blur released the MIDI sustain pedal", pedal1 < 64, "CC64 " + pedal1);
        await scenario(t, rec, "MIDI input: sustain pedal down, note released, port disconnected", {
          press: async () => { await midi([0xb3, 64, 100]); await midi([0x93, 64, 90]); await midi([0x83, 64, 0]); }, sounding: "3:64",
          release: () => p.evaluate(() => window.__fakeMidi.remove("in-1")),
        });
      }
      {
        // The latched Sustain checkbox keeps its channel sustained when the MIDI pedal is cleaned up.
        const rec = await open("one"), p = rec.page;
        await p.waitForFunction(() => document.getElementById("midiport").options.length === 2);
        await p.check("#sus");
        await p.evaluate(() => { window.__fakeMidi.send("in-1", [0xb0, 64, 127]); window.__fakeMidi.send("in-1", [0x90, 60, 90]); window.__fakeMidi.send("in-1", [0x80, 60, 0]); });
        await p.evaluate(() => window.__fakeMidi.remove("in-1"));
        await sleep(200);
        const kept = await p.evaluate(() => ({ held: window.synth.notetab.filter((nt) => nt.e >= 99999).map((nt) => nt.ch + ":" + nt.n), cc: synth.sustain[0] }));
        t.check("MIDI input: with the Sustain checkbox down, port cleanup leaves the pedal down", kept.cc >= 64 && kept.held.includes("0:60"), JSON.stringify(kept));
        await p.uncheck("#sus");
        await sleep(200);
        const h = await held(p);
        t.check("MIDI input: unchecking Sustain then releases the note", h.voices.length === 0, JSON.stringify(h));
      }
      /* eslint-enable no-undef */
    }),
  };
}

function midiCase() {
  return {
    id: "demos web midi soundedit",
    dims: { demo: "soundedit" },
    deadline: 60,
    run: (t) => withStaticServer(async (srv) => {
      const expect = {
        unsupported: /^Web MIDI is not available in this browser\./,
        denied: /^MIDI access failed \(NotAllowedError: Permission denied\)\./,
        empty: /^No MIDI input connected\./,
        one: /^1 MIDI input connected\.$/,
      };
      for (const mode of Object.keys(expect)) {
        const rec = await openDemo(t, srv, "soundedit", { initScripts: [[MIDI_STUB, mode]] });
        const m = await waitText(rec.page, "midistatus", expect[mode]);
        t.check(mode + ": shown in the page", expect[mode].test(m.text) && m.visible && m.role === "status", JSON.stringify(m));
        t.check(mode + ": no page errors", !rec.pageErrors.length, rec.pageErrors.join(" | "));
        t.check(mode + ": nothing logged to the console", !rec.console.some((c) => /MIDI/i.test(c.text)), rec.console.map((c) => c.text).filter((x) => /MIDI/i.test(x)).join(" | "));
        if (mode === "unsupported" || mode === "denied") await shot(t, rec, "soundedit-midi-" + mode);
        if (mode !== "one") continue;
        const p = rec.page;
        const ports = () => p.evaluate(() => { const s = document.getElementById("midiport"); return { names: Array.from(s.options).map((o) => o.textContent), selected: s.selectedIndex, current: currentPort }; }); // eslint-disable-line no-undef -- runs in the page
        let s = await ports();
        t.check("one input: listed and selected", s.names.join("|") === "--|Fake keyboard 1" && s.selected === 1 && s.current === 0, JSON.stringify(s));
        await p.evaluate(() => window.__fakeMidi.add("in-2", "Fake keyboard 2")); // eslint-disable-line no-undef -- runs in the page
        const m2 = await waitText(p, "midistatus", /^2 MIDI inputs connected\.$/);
        s = await ports();
        t.check("statechange: a new input is listed and the selection is kept", /^2 MIDI inputs/.test(m2.text) && s.names.length === 3 && s.selected === 1, JSON.stringify(s));
        await p.evaluate(() => window.__fakeMidi.remove("in-1")); // eslint-disable-line no-undef -- runs in the page
        const m3 = await waitText(p, "midistatus", /^1 MIDI input connected\.$/);
        s = await ports();
        t.check("statechange: a removed input leaves the list and the next one is selected", /^1 MIDI input/.test(m3.text) && s.names.join("|") === "--|Fake keyboard 2" && s.selected === 1, JSON.stringify(s));
        await p.evaluate(() => window.__fakeMidi.remove("in-2")); // eslint-disable-line no-undef -- runs in the page
        const m4 = await waitText(p, "midistatus", /^No MIDI input connected\./);
        s = await ports();
        t.check("statechange: no input left", /^No MIDI input/.test(m4.text) && s.names.length === 1 && s.current === -1, JSON.stringify(s));
        await p.evaluate(() => window.__fakeMidi.add("in-3", "Fake keyboard 3")); // eslint-disable-line no-undef -- runs in the page
        await waitText(p, "midistatus", /^1 MIDI input connected\.$/);
        s = await ports();
        t.check("statechange: an input connected after none were left is selected", s.selected === 1 && s.current === 0, JSON.stringify(s));
        // "--" chosen by the user stays chosen when inputs come and go.
        await p.selectOption("#midiport", { index: 0 });
        await p.evaluate(() => window.__fakeMidi.add("in-4", "Fake keyboard 4")); // eslint-disable-line no-undef -- runs in the page
        await waitText(p, "midistatus", /^2 MIDI inputs connected\.$/);
        const off1 = await ports();
        await p.evaluate(() => window.__fakeMidi.send("in-3", [0x90, 60, 100])); // eslint-disable-line no-undef -- runs in the page
        const silent = await held(p);
        await p.evaluate(() => window.__fakeMidi.remove("in-4")); // eslint-disable-line no-undef -- runs in the page
        await waitText(p, "midistatus", /^1 MIDI input connected\.$/);
        const off2 = await ports();
        t.check("statechange: \"--\" chosen by the user stays chosen, and the input plays nothing", off1.selected === 0 && off1.current === -1 && off2.selected === 0 && off2.current === -1 &&
          silent.voices.length === 0 && silent.page.length === 0, JSON.stringify({ off1, off2, silent }));
        await p.selectOption("#midiport", { index: 1 });
        await p.evaluate(() => window.__fakeMidi.send("in-3", [0x90, 61, 100])); // eslint-disable-line no-undef -- runs in the page
        const on = await waitSounding(p, "0:61");
        await p.evaluate(() => window.__fakeMidi.send("in-3", [0x80, 61, 0])); // eslint-disable-line no-undef -- runs in the page
        const after = await held(p);
        t.check("choosing the input again plays and releases its notes", on.includes("0:61") && after.voices.length === 0 && after.page.length === 0, JSON.stringify({ on, after }));
      }
    }),
  };
}

function editorCase() {
  return {
    id: "demos timbre editor soundedit",
    dims: { demo: "soundedit" },
    deadline: 90,
    run: (t) => withStaticServer(async (srv) => {
      /* eslint-disable no-undef -- these callbacks run in the page */
      const name = (p) => p.evaluate(() => document.getElementById("name").textContent);
      const rec = await openDemo(t, srv, "soundedit", { initScripts: [[MIDI_STUB, "empty"]] });
      const p = rec.page;
      await p.click("text=Timbre Editor");
      // T9-8: record setTimbre() calls and the built-in tables.
      await p.evaluate(() => {
        const real = synth.setTimbre;
        window.__timbreCalls = [];
        synth.setTimbre = function (m, n, tb) { window.__timbreCalls.push(m + ":" + n); return real(m, n, tb); };
        window.__builtins = JSON.stringify([synth.program0, synth.program1, synth.drummap0, synth.drummap1]);
      });
      const calls = () => p.evaluate(() => window.__timbreCalls.splice(0));
      // Keeps the installed array of slot m:n, then reports whether an edit replaced it and left it as it was.
      const keep = (m, n) => p.evaluate(([m, n]) => { const s = m ? synth.drummap[n - 35] : synth.program[n]; window.__kept = { p: s.p, json: JSON.stringify(s.p) }; }, [m, n]);
      const kept = (m, n) => p.evaluate(([m, n]) => {
        const s = m ? synth.drummap[n - 35] : synth.program[n];
        return { replaced: s.p !== window.__kept.p, unchanged: JSON.stringify(window.__kept.p) === window.__kept.json, before: window.__kept.json, now: JSON.stringify(s.p) };
      }, [m, n]);
      const builtinsUnchanged = () => p.evaluate(() => JSON.stringify([synth.program0, synth.program1, synth.drummap0, synth.drummap1]) === window.__builtins);
      // An unedited program shows the built-in timbre of the current quality.
      const builtinShown = (n) => p.evaluate((n) => {
        const b = (synth.quality ? synth.program1 : synth.program0)[n], s = synth.program[n].p;
        return s.length === b.length && b.every((o, i) => Object.keys(o).every((k) => s[i][k] === o[k]));
      }, n);
      const edited = (n) => p.evaluate((n) => ({ ops: synth.program[n].p.length, v: synth.program[n].p[0].v, shownOps: document.getElementById("oscs").selectedIndex + 1, shownV: document.getElementById("v1").value, quality: synth.quality }), n);

      // E5: choosing 4 operators on a 2-operator program installs a new 4-operator timbre through setTimbre.
      await keep(0, 0);
      await calls();
      await p.selectOption("#oscs", "4");
      const e5 = await p.evaluate(() => ({ p: JSON.parse(JSON.stringify(synth.program[0].p)), patch: document.getElementById("patch").value }));
      const k5 = await kept(0, 0);
      const c5 = await calls();
      const before = JSON.parse(k5.before);
      t.check("E5: 2 -> 4 operators gives 4 operators", before.length === 2 && e5.p.length === 4 && (e5.patch.match(/\{/g) || []).length === 4, before.length + " -> " + e5.p.length + " " + e5.patch);
      t.check("T9-8: the edit goes through setTimbre()", c5.length === 1 && c5[0] === "0:0", JSON.stringify(c5));
      t.check("T9-8: the edit installs a new array and leaves the previously installed one unchanged", k5.replaced && k5.unchanged, JSON.stringify(k5));
      t.check("T9-8: unchanged operators keep their keys, order and values (the Patch text stays upstream's)", JSON.stringify(e5.p.slice(0, 2)) === k5.before, JSON.stringify(e5.p.slice(0, 2)) + " vs " + k5.before);
      t.check("T9-8: an added operator has upstream's keys in upstream's order", Object.keys(e5.p[2]).join(",") === "g,w,v,t,f,a,h,d,s,r,b,c,p,q,k", Object.keys(e5.p[2]).join(","));
      await p.selectOption("#oscs", "2");
      // Edits in quality 1 reach the program the keyboard plays, and its notes release.
      await calls();
      await p.fill("#v1", "0.25");
      const q1 = await p.evaluate(() => ({ v: synth.program[0].p[0].v, patch: document.getElementById("patch").value, quality: synth.quality }));
      t.check("quality 1: editing V1 changes the program and the patch text", q1.v === 0.25 && /v:0\.25/.test(q1.patch) && q1.quality === 1, JSON.stringify(q1));
      t.check("quality 1: the V1 edit goes through setTimbre()", JSON.stringify(await calls()) === "[\"0:0\"]", "");
      // setTimbre's RangeError and TypeError are shown, and nothing changes.
      const g2 = await p.inputValue("#g2");
      const json = () => p.evaluate(() => JSON.stringify(synth.program[0].p));
      const valid = await json();
      await p.fill("#g2", "5");
      let st = await p.evaluate(MESSAGE, "editstatus").catch((e) => ({ text: "no edit status line: " + String(e.message).split("\n")[0] }));
      const cls = await p.getAttribute("#editstatus", "class").catch(() => null);
      t.check("T9-8: a RangeError from setTimbre is shown", st.text === "Not applied (RangeError: operator 1 g: 5 is not an earlier operator). The timbre is unchanged." && st.visible && st.role === "status" && cls === "error", JSON.stringify(st));
      t.check("T9-8: after the RangeError the installed timbre is unchanged", (await json()) === valid, "");
      await shot(t, rec, "soundedit-editor-error");
      await p.fill("#g2", g2);
      await p.fill("#v1", "");
      st = await p.evaluate(MESSAGE, "editstatus").catch((e) => ({ text: "no edit status line: " + String(e.message).split("\n")[0] }));
      t.check("T9-8: a TypeError from setTimbre is shown", st.text === "Not applied (TypeError: operator 0 v is not a number). The timbre is unchanged.", JSON.stringify(st));
      t.check("T9-8: after the TypeError the installed timbre is unchanged", (await json()) === valid, "");
      await p.fill("#v1", "0.25");
      st = await p.evaluate(MESSAGE, "editstatus").catch((e) => ({ text: "no edit status line: " + String(e.message).split("\n")[0] }));
      t.check("T9-8: a valid edit clears the message", st.text === "" && (await json()) === valid, JSON.stringify(st));
      const shotBox = await box(p, "#shot");
      const playShot = (label) => scenario(t, rec, label, {
        press: async () => { await p.mouse.move(shotBox.x + shotBox.width / 2, shotBox.y + shotBox.height / 2); await p.mouse.down(); }, sounding: "0:60",
        release: () => p.mouse.up(),
      });
      await playShot("quality 1: the edited program plays and releases");
      await shot(t, rec, "soundedit-editor-quality1");
      // A quality change reinstalls the built-in timbres; the editor installs its edits again.
      await p.selectOption("#quality", { index: 0 });
      let q = await edited(0);
      t.check("T9-8: after quality 1 -> 0 the edited program is installed again and shown", q.quality === 0 && q.ops === 2 && q.v === 0.25 && q.shownOps === 2 && q.shownV === "0.25" && /Acoustic Grand Piano/.test(await name(p)), JSON.stringify(q));
      t.check("quality 0: an unedited program has the quality-0 built-in timbre", await builtinShown(1), "");
      // 0.45, unlike 0.4, is not the quality-1 piano's own value.
      await p.fill("#v1", "0.45");
      const q0v = await p.evaluate(() => synth.program[0].p[0].v);
      t.check("quality 0: editing V1 changes the program", q0v === 0.45, String(q0v));
      await playShot("quality 0: the edited program plays and releases");
      await p.selectOption("#quality", { index: 1 });
      q = await edited(0);
      t.check("T9-8: after quality 0 -> 1 the edited program is installed again and shown", q.quality === 1 && q.v === 0.45 && q.shownV === "0.45", JSON.stringify(q));
      t.check("quality 1: an unedited program has the quality-1 built-in timbre", await builtinShown(1), "");
      // E9: program change on the selected channel; the Prog select follows the channel.
      await p.selectOption("#ch", { index: 1 });
      await p.selectOption("#prog", { index: 40 });
      const pg = await p.evaluate(() => [synth.pg[0], synth.pg[1]]);
      t.check("E9: Prog changes the selected channel only", pg[0] === 0 && pg[1] === 40, JSON.stringify(pg));
      await p.selectOption("#ch", { index: 0 });
      const back = await p.evaluate(() => ({ prog: document.getElementById("prog").selectedIndex, name: document.getElementById("name").textContent }));
      await p.selectOption("#ch", { index: 1 });
      const again = await p.evaluate(() => ({ prog: document.getElementById("prog").selectedIndex, name: document.getElementById("name").textContent }));
      t.check("E9: the Prog select and editor show the selected channel's program", back.prog === 0 && /Acoustic Grand Piano/.test(back.name) && again.prog === 40 && /Violin/.test(again.name), JSON.stringify([back, again]));
      // Drums: an edit on note 40 goes through setTimbre(1, 40, ...); E7: the drum shown after a quality change is the drum on the key.
      await p.selectOption("#ch", { index: 9 });
      await p.evaluate(KB_CHANGE, [1, 40]);
      await p.evaluate(KB_CHANGE, [0, 40]);
      const d1 = await name(p);
      await keep(1, 40);
      await calls();
      await p.fill("#v1", "0.66"); // neither quality's built-in snare level
      const kd = await kept(1, 40);
      const cd = await calls();
      const dv = () => p.evaluate(() => synth.drummap[40 - 35].p[0].v);
      t.check("T9-8: a drum edit goes through setTimbre(1, 40) and leaves the installed array unchanged", JSON.stringify(cd) === "[\"1:40\"]" && kd.replaced && kd.unchanged && (await dv()) === 0.66, JSON.stringify({ cd, kd }));
      await p.selectOption("#quality", { index: 0 });
      const d0 = await name(p);
      const dv0 = await dv();
      await p.selectOption("#quality", { index: 1 });
      const d1b = await name(p);
      const dv1 = await dv();
      t.check("E7: note 40 shows Electric Snare before and after quality changes", [d1, d0, d1b].every((x) => /Electric Snare/.test(x)), JSON.stringify([d1, d0, d1b]));
      t.check("T9-8: the drum edit is installed again after each quality change", dv0 === 0.66 && dv1 === 0.66 && (await p.inputValue("#v1")) === "0.66", JSON.stringify([dv0, dv1]));
      // E8: a key without a drum says so, and editing does not call setTimbre or throw.
      const errorsBefore = rec.pageErrors.length;
      await p.evaluate(KB_CHANGE, [1, 90]);
      await p.evaluate(KB_CHANGE, [0, 90]);
      const none = await name(p);
      await calls();
      await p.fill("#v1", "0.3");
      await p.selectOption("#oscs", "3");
      const c8 = await calls();
      t.check("E8: note 90 on the drum channel says there is no drum sound", /No drum sound on note 90/.test(none), none);
      t.check("E8: editing with that key selected does not throw or install anything", rec.pageErrors.length === errorsBefore && c8.length === 0, rec.pageErrors.join(" | ") + " " + JSON.stringify(c8));
      await shot(t, rec, "soundedit-editor-no-drum");
      t.check("T9-8: the built-in tables are unchanged after every edit", await builtinsUnchanged(), "");
      const h = await held(p);
      t.check("no voice held at the end", h.voices.length === 0 && h.page.length === 0, JSON.stringify(h));
      t.check("no page errors", !rec.pageErrors.length, rec.pageErrors.join(" | "));
      t.check("no console errors", !rec.consoleErrors.length, rec.consoleErrors.join(" | "));
      /* eslint-enable no-undef */
    }),
  };
}

function cases() {
  return [
    ...DEMOS.map(loadCase),
    ...DEMOS.map(audioCase),
    urlCase("jstest"),
    urlCase("soundedit"),
    ...DEMOS.map(fileCase),
    simpleReleaseCase(),
    jstestReleaseCase(),
    soundeditReleaseCase(),
    midiCase(),
    editorCase(),
  ];
}

/* ---------------- standalone runner ---------------- */

function parseArgs(argv) {
  const o = { engines: ENGINES, engine: null, results: null, out: null };
  for (const a of argv) {
    let m;
    if ((m = /^--engines=(.+)$/.exec(a))) o.engines = m[1].split(",").map((x) => x.trim()).filter(Boolean);
    else if ((m = /^--engine=(.+)$/.exec(a))) o.engine = m[1];
    else if ((m = /^--results=(.+)$/.exec(a))) o.results = path.resolve(m[1]);
    else if ((m = /^--out=(.+)$/.exec(a))) o.out = path.resolve(m[1]);
    else throw new Error("unknown argument " + a);
  }
  for (const e of [...o.engines, ...(o.engine ? [o.engine] : [])]) if (!ENGINES.includes(e)) throw new Error("unknown engine " + e);
  if (!o.engines.length) throw new Error("--engines= selects nothing");
  return o;
}

async function worker(o) {
  const { EngineSession } = require("../lib/cases");
  const playwright = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
  const out = o.out ? path.join(o.out, o.engine) : null;
  if (out) fs.mkdirSync(out, { recursive: true });
  const results = { engine: o.engine, version: null, launchError: null, cases: [] };
  const save = () => { if (o.results) fs.writeFileSync(o.results, JSON.stringify(results, null, 1)); };
  const session = new EngineSession({ engine: o.engine, playwright, out });
  try {
    await session.launch();
  } catch (e) {
    results.launchError = String(e && e.message ? e.message : e);
    save();
    console.log("FAIL: " + o.engine + " could not be launched:\n" + results.launchError);
    return 1;
  }
  results.version = session.version;
  console.log("== " + o.engine + " " + session.version);
  let failed = 0;
  try {
    for (const c of cases()) {
      c.spec = "demos";
      c.kind = "assert";
      const r = await session.run(c, { engine: o.engine });
      results.cases.push(r);
      if (r.status === "fail") ++failed;
      save();
      if (session.fatal) { ++failed; break; }
    }
  } finally {
    save();
    await session.closeBrowser();
  }
  const n = results.cases.length;
  console.log((failed || !n ? "FAIL: " : "PASS: ") + o.engine + " " + session.version + ": " + (n - failed) + " of " + n + " cases passed");
  return failed || !n ? 1 : 0;
}

async function orchestrate(o) {
  const { runWithDeadline, describeFailure } = require("../../../scripts/run-with-deadline");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tinysynth-demos-"));
  const all = {};
  let failed = 0;
  for (const engine of o.engines) {
    const file = path.join(tmp, engine + ".json");
    console.log("\n== Worker " + engine);
    const args = [__filename, "--engine=" + engine, "--results=" + file];
    if (o.out) args.push("--out=" + o.out);
    const r = await runWithDeadline("node", args, ENGINE_DEADLINE, { cwd: ROOT });
    const failure = describeFailure(r, ENGINE_DEADLINE);
    let res;
    try { res = JSON.parse(fs.readFileSync(file, "utf8")); } catch { res = { engine, version: null, cases: [] }; }
    if (failure) { ++failed; res.failure = failure; console.log("-- worker " + engine + ": FAILED, " + failure); }
    all[engine] = res;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (o.out) {
    fs.mkdirSync(o.out, { recursive: true });
    fs.writeFileSync(path.join(o.out, "results.json"), JSON.stringify(all, null, 1));
  }
  console.log("\n== Demo results");
  for (const [engine, r] of Object.entries(all)) {
    if (!r.version) { console.log("  " + engine.padEnd(10) + "NOT LAUNCHED " + String(r.launchError || r.failure || "").split("\n")[0]); continue; }
    const checks = r.cases.reduce((a, c) => a + c.checks.length, 0);
    const ok = r.cases.reduce((a, c) => a + c.checks.filter((k) => k.ok).length, 0);
    const bad = r.cases.filter((c) => c.status === "fail").map((c) => c.id);
    console.log("  " + (engine + " " + r.version).padEnd(28) + (bad.length ? "FAIL " : "ok   ") + ok + "/" + checks + " checks, " + r.cases.length + " cases" + (bad.length ? "; failed: " + bad.join(", ") : ""));
  }
  const launched = Object.values(all).filter((r) => r.version).length;
  const total = Object.values(all).reduce((a, r) => a + r.cases.length, 0);
  const bad = Object.values(all).reduce((a, r) => a + r.cases.filter((c) => c.status === "fail").length, 0);
  const msg = "demo tests: " + launched + " of " + o.engines.length + " engines launched, " + bad + " of " + total + " cases failed";
  if (failed || bad || launched !== o.engines.length || !total) {
    console.log("FAIL: " + msg);
    return 1;
  }
  console.log("PASS: " + msg.replace(", 0 of", "; 0 of") + " (" + o.engines.join(", ") + ")");
  return 0;
}

module.exports = { cases };

if (require.main === module) {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.log("FAIL: " + e.message);
    process.exit(2);
  }
  (o.engine ? worker(o) : orchestrate(o)).then((status) => process.exit(status), (e) => {
    console.log("FAIL: " + (e && e.stack ? e.stack : e));
    process.exit(1);
  });
}
