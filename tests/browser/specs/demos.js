#!/usr/bin/env node
/*
 * Demo pages (#19): simple.html, jstest.html and soundedit.html, loaded from a
 * read-only static server at http://127.0.0.1 with every other host blocked.
 *
 * Asserted per engine:
 *   - loads: no request leaves 127.0.0.1, the vendored webaudio-controls.js
 *     (pinned sha256) defines its elements, no page or console errors, and
 *     the controls show the engine's settings (J4, E12);
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
 *   - the timbre editor: operator count (E5), the drum shown after a quality
 *     change (E7), keys without a drum (E8), program change on the selected
 *     channel (E9), and edits in both quality modes.
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
 * the system, and hardware MIDI. Audible output is not checked here.
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
/* eslint-enable no-undef */

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
 */
async function openDemo(t, srv, demo, { initScripts = [], contextOptions = {} } = {}) {
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
  await rec.page.waitForFunction(READY, null, { timeout: 15000 });
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
      const rec = await openDemo(t, srv, demo);
      await sleep(1000);
      const state = await rec.page.evaluate((names) => ({
        defined: names.filter((n) => !!customElements.get(n)), // eslint-disable-line no-undef -- runs in the page
        title: document.title, // eslint-disable-line no-undef -- runs in the page
      }), ELEMENTS[demo]);
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
      // E5: choosing 4 operators on a 2-operator program gives 4.
      const before = await p.evaluate(() => synth.program[0].p.length);
      await p.selectOption("#oscs", "4");
      const after = await p.evaluate(() => ({ n: synth.program[0].p.length, patch: document.getElementById("patch").value }));
      t.check("E5: 2 -> 4 operators gives 4 operators", before === 2 && after.n === 4 && (after.patch.match(/\{/g) || []).length === 4, before + " -> " + JSON.stringify(after));
      await p.selectOption("#oscs", "2");
      // Edits in quality 1 reach the program the keyboard plays, and its notes release.
      await p.fill("#v1", "0.25");
      const q1 = await p.evaluate(() => ({ v: synth.program[0].p[0].v, patch: document.getElementById("patch").value, quality: synth.quality }));
      t.check("quality 1: editing V1 changes the program and the patch text", q1.v === 0.25 && /v:0\.25/.test(q1.patch) && q1.quality === 1, JSON.stringify(q1));
      const shotBox = await box(p, "#shot");
      const playShot = (label) => scenario(t, rec, label, {
        press: async () => { await p.mouse.move(shotBox.x + shotBox.width / 2, shotBox.y + shotBox.height / 2); await p.mouse.down(); }, sounding: "0:60",
        release: () => p.mouse.up(),
      });
      await playShot("quality 1: the edited program plays and releases");
      await shot(t, rec, "soundedit-editor-quality1");
      await p.selectOption("#quality", { index: 0 });
      const q0 = await p.evaluate(() => ({ quality: synth.quality, ops: synth.program[0].p.length, shown: document.getElementById("oscs").selectedIndex + 1, name: document.getElementById("name").textContent }));
      t.check("quality 0: the editor shows the quality-0 program", q0.quality === 0 && q0.ops === q0.shown && /Acoustic Grand Piano/.test(q0.name), JSON.stringify(q0));
      await p.fill("#v1", "0.4");
      const q0v = await p.evaluate(() => synth.program[0].p[0].v);
      t.check("quality 0: editing V1 changes the program", q0v === 0.4, String(q0v));
      await playShot("quality 0: the edited program plays and releases");
      await p.selectOption("#quality", { index: 1 });
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
      // E7: the drum shown after a quality change is the drum on the key.
      await p.selectOption("#ch", { index: 9 });
      await p.evaluate(KB_CHANGE, [1, 40]);
      await p.evaluate(KB_CHANGE, [0, 40]);
      const d1 = await name(p);
      await p.selectOption("#quality", { index: 0 });
      const d0 = await name(p);
      await p.selectOption("#quality", { index: 1 });
      const d1b = await name(p);
      t.check("E7: note 40 shows Electric Snare before and after quality changes", [d1, d0, d1b].every((x) => /Electric Snare/.test(x)), JSON.stringify([d1, d0, d1b]));
      // E8: a key without a drum says so and editing does not throw.
      const errorsBefore = rec.pageErrors.length;
      await p.evaluate(KB_CHANGE, [1, 90]);
      await p.evaluate(KB_CHANGE, [0, 90]);
      const none = await name(p);
      await p.fill("#v1", "0.3");
      await p.selectOption("#oscs", "3");
      t.check("E8: note 90 on the drum channel says there is no drum sound", /No drum sound on note 90/.test(none), none);
      t.check("E8: editing with that key selected does not throw", rec.pageErrors.length === errorsBefore, rec.pageErrors.join(" | "));
      await shot(t, rec, "soundedit-editor-no-drum");
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
