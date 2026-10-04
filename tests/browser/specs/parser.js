/*
 * Bounded MIDI parser in the browser (#4, #6; T2, D-013), asserted per build.
 *
 * Every case runs in a fresh page served from the controlled server. The page
 * first installs a "previous" song, loops it, plays it and sets a channel
 * marker (program 7). Then, in one synchronous page call, it loads the input
 * and compares the synth before and after.
 *
 * Asserted for every malformed, truncated or unsupported input:
 *   - loadMIDI() returns or throws within OP_DEADLINE seconds. The deadline is
 *     armed from Node around that call only, so a parser hang fails the check
 *     and the page is closed by the case cleanup;
 *   - it throws an Error with the D-013 code and a numeric byte offset;
 *   - the previous song (the same object, length and events), the playback
 *     status and the channel marker are unchanged.
 * The two documented recoveries for a missing End-of-Track load within the
 * deadline, with the song length and event count of an independent reading
 * (lib/smf.js), and keep tracks apart. Through loadMIDIUrl(), a truncated
 * response ends (XHR loadend) within the deadline and the previous song stays.
 * The reporting of that error is #14's (T5) and is only observed here.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const pages = require("../lib/pages");
const smf = require("../lib/smf");
const { withTimeout, short } = require("../lib/cases");

// Seconds. A valid or rejected load takes well under 1 ms (T2); the pre-T2 parser
// hangs on these inputs (#4), which this external deadline turns into a failure.
const OP_DEADLINE = 5;
const MARKER_PROGRAM = 7;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Page script, inlined after the library (and page/xhr.js). */
/* eslint-disable no-undef -- runs in the page */
const PAGE = function () {
  "use strict";
  var synth = null;
  function bytes(b64) {
    var bin = window.atob(b64), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; ++i) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }
  function state() {
    var st = synth.getPlayStatus();
    return { play: st.play, maxTick: st.maxTick, curTick: st.curTick, song: synth.song, events: synth.song ? synth.song.ev.length : null, program: synth.pg[0] };
  }
  /* keys: what must be equal; the URL case leaves out curTick, which advances while the song plays. */
  function compare(a, b, keys) {
    var diff = [];
    (keys || ["play", "maxTick", "curTick", "events", "program"]).forEach(function (k) { if (a[k] !== b[k]) diff.push(k + " " + a[k] + " -> " + b[k]); });
    if (a.song !== b.song) diff.push("song object replaced");
    return diff;
  }
  window.__t6parse = {
    /* A synth playing the looped previous song, with program MARKER on channel 0. */
    setup: function (prevB64, marker) {
      synth = new WebAudioTinySynth({ quality: 1 });
      synth.loadMIDI(bytes(prevB64));
      synth.setLoop(1);
      synth.playMIDI();
      synth.setProgram(0, marker);
      var s = state();
      delete s.song;
      return s;
    },
    /* Loads bytes; returns the outcome and the changes, all from one synchronous call. */
    load: function (b64) {
      var data = bytes(b64);
      var before = state(), t0 = performance.now(), threw = null;
      try {
        synth.loadMIDI(data);
      } catch (e) {
        threw = { name: e && e.name, code: e && e.code, offset: e && e.offset, track: e && e.track, message: String(e && e.message) };
      }
      var ms = performance.now() - t0, after = state();
      return { threw: threw, ms: ms, changes: compare(before, after), after: { play: after.play, maxTick: after.maxTick, events: after.events } };
    },
    loadUrl: function (url) {
      window.__t6parse.urlBefore = state();
      synth.loadMIDIUrl(url);
    },
    urlResult: function (url) {
      var d = window.__t6.xhr.done(url);
      if (!d) return null;
      return { xhr: d, changes: compare(window.__t6parse.urlBefore, state(), ["play", "maxTick", "events", "program"]) };
    },
  };
};
/* eslint-enable no-undef */

/* ---- inputs, built here and read independently with lib/smf.js ---- */

function chunk(id, body, len) {
  const h = Buffer.alloc(8);
  h.write(id, 0, "latin1");
  h.writeUInt32BE(len === undefined ? body.length : len, 4);
  return Buffer.concat([h, Buffer.from(body)]);
}
const header = (format, ntrks, division) => chunk("MThd", [0, format, ntrks >> 8, ntrks & 0xff, (division >> 8) & 0xff, division & 0xff]);
const file = (format, division, tracks, ntrks = tracks.length) => Buffer.concat([header(format, ntrks, division), ...tracks.map((t) => chunk("MTrk", t))]);
const EOT = [0x00, 0xff, 0x2f, 0x00];
const NOTE = [0x00, 0x90, 60, 100, 0x83, 0x60, 0x80, 60, 0]; // note-on, note-off 480 ticks later
const NOTE2 = [0x00, 0x91, 72, 100, 0x83, 0x60, 0x81, 72, 0];

// The previous song: a C4 note every 480 ticks for 16 beats, looped while the inputs load.
const PREVIOUS = smf.write({ format: 0, division: 480, tracks: [Array.from({ length: 16 }, (_, i) => [{ dt: i ? 240 : 0, bytes: [0x90, 60, 100] }, { dt: 240, bytes: [0x80, 60, 0] }]).flat()] });

function inputs() {
  const ws = fs.readFileSync(path.join(pages.ROOT, "ws.mid"));
  const T = "SMF_TRUNCATED", M = "SMF_MALFORMED", D = "SMF_UNSUPPORTED_DIVISION";
  const fail = [
    { issue: "#4", name: "ws.mid cut at 40 bytes", bytes: ws.subarray(0, 40), code: T },
    { issue: "#4", name: "ws.mid without its last 4 bytes (End-of-Track; chunk length kept)", bytes: ws.subarray(0, ws.length - 4), code: T },
    { issue: "#4", name: "a note-on cut by its chunk end, before a second track", bytes: file(1, 480, [[...NOTE, 0x00, 0x90, 60], [...NOTE2, ...EOT]]), code: T },
    { issue: "#4", name: "a track without End-of-Track followed by trailing bytes", bytes: Buffer.concat([file(0, 480, [NOTE]), Buffer.from([0, 0, 0])]), code: M },
    { issue: "#4", name: "a delta-time longer than 4 bytes", bytes: file(0, 480, [[0x81, 0x80, 0x80, 0x80, 0x00, 0x90, 60, 100, ...EOT]]), code: M },
    { issue: "#4", name: "a tempo event with 2 data bytes", bytes: file(0, 480, [[0x00, 0xff, 0x51, 0x02, 0x07, 0xa1, ...NOTE, ...EOT]]), code: M },
    { issue: "#4", name: "a tempo of 0 microseconds per quarter note", bytes: file(0, 480, [[0x00, 0xff, 0x51, 0x03, 0, 0, 0, ...NOTE, ...EOT]]), code: M },
    { issue: "#4", name: "no MThd header (RIFF bytes)", bytes: Buffer.from("RIFF\x24\0\0\0WAVEfmt \x10\0\0\0", "latin1"), code: "SMF_INVALID_HEADER" },
    { issue: "#4", name: "format 2", bytes: file(2, 480, [[...NOTE, ...EOT]]), code: "SMF_UNSUPPORTED_FORMAT" },
    { issue: "#6", name: "SMPTE division 0xE728 (-25 fps, 40 ticks per frame)", bytes: file(0, 0xe728, [[...NOTE, ...EOT]]), code: D },
    { issue: "#6", name: "SMPTE division 0xE250 (-30 fps, 80 ticks per frame)", bytes: file(0, 0xe250, [[...NOTE, ...EOT]]), code: D },
    { issue: "#6", name: "SMPTE division 0xE878 (-24 fps, 120 ticks per frame)", bytes: file(0, 0xe878, [[...NOTE, ...EOT]]), code: D },
    { issue: "#6", name: "SMPTE division 0xE304 (-29 fps drop frame, 4 ticks per frame)", bytes: file(0, 0xe304, [[...NOTE, ...EOT]]), code: D },
    { issue: "#6", name: "division 0 (zero PPQ)", bytes: file(0, 0, [[...NOTE, ...EOT]]), code: D },
    { issue: "#6", name: "header cut inside the division field", bytes: file(0, 480, [[...NOTE, ...EOT]]).subarray(0, 13), code: T },
  ];
  // Documented recovery (D-013): a track without End-of-Track that ends on an
  // event boundary at the end of the file, or before an MTrk chunk.
  const load = [
    { issue: "#4", name: "a track without End-of-Track at the end of the file", bytes: file(0, 480, [NOTE]) },
    { issue: "#4", name: "a track without End-of-Track before a second track", bytes: file(1, 480, [NOTE, [0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, ...NOTE2, 0x83, 0x60, 0x91, 74, 100, 0x00, 0x81, 74, 0, ...EOT]]) },
  ];
  for (const c of load) {
    const r = smf.read(c.bytes);
    c.maxTick = r.endTick;
    // The library keeps channel messages and tempo; other meta events are not retained.
    c.events = r.tracks.reduce((a, tr) => a + tr.events.filter((e) => e.status < 0xf0 || (e.status === 0xff && e.type === 0x51)).length, 0);
  }
  return { fail, load };
}

function cases(shared) {
  const { matrix, options, server } = shared;
  const { fail, load } = inputs();
  const out = [];
  for (const build of matrix.builds) {
    const pageId = "parser-" + build;
    const html = () => pages.inlinePage({
      library: pages.readLibrary(build, options.overrides), seed: options.seed,
      after: [pages.pageScript("xhr.js"), "(" + PAGE.toString() + ")();"],
    });
    /* A fresh page with the previous song playing. A hung page cannot be reused, so every case opens its own. */
    const open = async (t) => {
      server.registerPage(pageId, html());
      const p = await t.newPage();
      await p.page.goto(server.origin + "/html/" + pageId);
      const before = await p.page.evaluate(([b, m]) => window.__t6parse.setup(b, m), [PREVIOUS.toString("base64"), MARKER_PROGRAM]); // eslint-disable-line no-undef -- runs in the page
      if (!t.check("the previous song plays with the channel marker", before.play === 1 && before.maxTick === smf.read(PREVIOUS).endTick && before.program === MARKER_PROGRAM, JSON.stringify(before))) throw new Error("setup failed");
      return p;
    };
    /* loadMIDI(bytes) under the external deadline; null when it did not return. */
    const timedLoad = async (t, p, bytes) => {
      if (t.isAbandoned()) return null;
      const r = await withTimeout(p.page.evaluate((b) => window.__t6parse.load(b), bytes.toString("base64")), OP_DEADLINE * 1000); // eslint-disable-line no-undef -- runs in the page
      const ok = t.check("loadMIDI() returned within the " + OP_DEADLINE + " s deadline (no hang)", r.ok, r.timedOut ? "no return; the page is closed by the case cleanup" : r.ok ? "" : short(r.error));
      if (ok) t.observe("outcome", r.value);
      return ok ? r.value : null;
    };
    for (const c of fail) {
      out.push({
        id: "parser " + build + " " + c.issue + " " + c.name, dims: { build },
        run: async (t) => {
          const p = await open(t);
          const r = await timedLoad(t, p, c.bytes);
          if (!r) return;
          const e = r.threw || {};
          t.check("throws an Error with code " + c.code + " and a byte offset", r.threw && e.name === "Error" && e.code === c.code && Number.isInteger(e.offset) && e.offset >= 0,
            r.threw ? e.code + " at byte " + e.offset + ": " + e.message : "no exception (status after: " + JSON.stringify(r.after) + ")");
          t.check("the previous song (same object, length and events), playback status and channel state are unchanged", !r.changes.length, r.changes.join("; "));
        },
      });
    }
    for (const c of load) {
      out.push({
        id: "parser " + build + " " + c.issue + " loads " + c.name, dims: { build },
        run: async (t) => {
          const p = await open(t);
          const r = await timedLoad(t, p, c.bytes);
          if (!r) return;
          t.check("loads without an exception, with the song length and event count of an independent reading (" + c.maxTick + " ticks, " + c.events + " events)",
            !r.threw && r.after.maxTick === c.maxTick && r.after.events === c.events, r.threw ? r.threw.message : r.after.maxTick + " ticks, " + r.after.events + " events");
        },
      });
    }
    out.push({
      id: "parser " + build + " #4 loadMIDIUrl(ws.mid cut at 40 bytes)", dims: { build },
      run: async (t) => {
        const p = await open(t);
        const url = "/midi/truncated/40/ws.mid?parser=" + build;
        await p.page.evaluate((u) => window.__t6parse.loadUrl(u), url); // eslint-disable-line no-undef -- runs in the page
        // The XHR's loadend follows the library's onload; a parser hang inside onload blocks this poll.
        const poll = async () => {
          for (;;) {
            const d = await p.page.evaluate((u) => window.__t6parse.urlResult(u), url); // eslint-disable-line no-undef -- runs in the page
            if (d) return d;
            await sleep(25);
          }
        };
        const r = await withTimeout(poll(), OP_DEADLINE * 1000);
        if (!t.check("the response is handled within the " + OP_DEADLINE + " s deadline (no hang)", r.ok, r.timedOut ? "no loadend; the page is closed by the case cleanup" : r.ok ? "" : short(r.error))) return;
        t.check("the previous song (same object, length and events), play status and channel state are unchanged", !r.value.changes.length, r.value.changes.join("; "));
        t.observe("outcome (the error's delivery is #14, T5)", { xhr: r.value.xhr, pageErrors: p.pageErrors.slice(0, 3) });
      },
    });
  }
  return out;
}

module.exports = { cases, inputs, PREVIOUS, MARKER_PROGRAM, OP_DEADLINE };
