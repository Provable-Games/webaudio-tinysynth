/*
 * Offline embedding (#16): the library and a MIDI file inlined in one page,
 * every request aborted, loaded two ways: page.setContent() (about:blank) and
 * a base64 data: URL, as the onchain consumer embeds it. Asserts zero network
 * requests, no errors, the global export, the quality option, and the song
 * length against an independent SMF reading. Whether the realtime context
 * runs on these origins is engine policy and is recorded, not asserted (the
 * gesture spec covers startup).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const pages = require("../lib/pages");
const smf = require("../lib/smf");

const FIXTURES = ["ws.mid", "test-midi/all-gm-sounds.mid"];

const PAGE_SCRIPT = `
window.__t6.embed = function (quality) {
  var out = { exported: typeof window.WebAudioTinySynth, songs: [], pageSeed: window.__t6.currentSeed };
  var synth = new WebAudioTinySynth({ quality: quality });
  out.quality = synth.quality;
  var nodes = document.querySelectorAll("script[type='application/x-midi-base64']");
  for (var k = 0; k < nodes.length; ++k) {
    var bin = atob(nodes[k].textContent.trim());
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; ++i) bytes[i] = bin.charCodeAt(i);
    synth.loadMIDI(bytes.buffer);
    var st = synth.getPlayStatus();
    synth.playMIDI();
    out.songs.push({ name: nodes[k].id, maxTick: st.maxTick, events: synth.song.ev.length, playing: synth.getPlayStatus().play });
    synth.stopMIDI();
  }
  synth.playMIDI();
  var before = synth.getPlayStatus().curTick;
  return new Promise(function (r) { setTimeout(r, 1000); }).then(function () {
    out.contextState = synth.getAudioContext().state;
    out.curTickAdvanced = synth.getPlayStatus().curTick > before;
    synth.stopMIDI();
    out.rejections = window.__t6.rejections.slice();
    return out;
  });
};`;

function cases(shared) {
  const { matrix, options } = shared;
  const midi = FIXTURES.map((f) => ({ name: f, bytes: fs.readFileSync(path.join(pages.ROOT, f)) }));
  const expected = Object.fromEntries(midi.map((m) => [m.name, smf.read(m.bytes).endTick]));
  const body = midi.map((m) => "<script type=\"application/x-midi-base64\" id=\"" + m.name + "\">" + m.bytes.toString("base64") + "</script>").join("\n");
  const out = [];
  for (const build of matrix.builds) {
    for (const quality of matrix.qualities) {
      out.push({
        id: "embed " + build + " q" + quality,
        dims: { build, quality },
        run: async (t) => {
          const html = pages.inlinePage({ library: pages.readLibrary(build, options.overrides), seed: options.seed, after: [PAGE_SCRIPT], body });
          for (const how of ["setContent", "data-url"]) {
            const p = await t.newPage({ offline: true });
            if (how === "setContent") await p.page.setContent(html);
            else await p.page.goto("data:text/html;base64," + Buffer.from(html).toString("base64"));
            const r = await p.page.evaluate((q) => window.__t6.embed(q), quality); // eslint-disable-line no-undef -- runs in the page
            const network = p.requests.filter((u) => !u.startsWith("data:"));
            t.check(how + ": window.WebAudioTinySynth is a function", r.exported === "function", r.exported);
            t.check(how + ": the page's Math.random seed is the run's seed", r.pageSeed === options.seed, r.pageSeed + " vs " + options.seed);
            t.check(how + ": quality option applied", r.quality === quality, "quality " + r.quality);
            for (const s of r.songs) {
              t.check(how + ": " + s.name + " maxTick equals the SMF end tick", s.maxTick === expected[s.name], s.maxTick + " vs " + expected[s.name]);
              t.check(how + ": " + s.name + " parsed events and plays", s.events > 0 && s.playing === 1, s.events + " events, play " + s.playing);
            }
            t.check(how + ": zero network requests", network.length === 0 && p.aborted.length === 0,
              network.length + " requests, " + p.aborted.length + " aborted" + (network.length ? ": " + network.slice(0, 3).join(" ") : ""));
            t.check(how + ": no page or console errors", !p.pageErrors.length && !p.consoleErrors.length, [...p.pageErrors, ...p.consoleErrors].slice(0, 3).join(" | "));
            t.observe(how + ": realtime context after 1 s", { state: r.contextState, curTickAdvanced: r.curTickAdvanced, unhandledRejections: r.rejections });
          }
        },
      });
    }
  }
  return out;
}

module.exports = { cases };
