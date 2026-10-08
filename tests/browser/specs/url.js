/*
 * loadMIDIUrl against the controlled server (scripts/browser-server.js), #14.
 *
 * Asserted (baseline and later): a 200 response installs the song, with the
 * length of an independent SMF reading, after exactly one GET. Observed and
 * recorded per engine (phase B asserts the #14 contract after T5): the return
 * value, non-200 responses (404, 500, 204, a redirect), an empty body,
 * non-MIDI bytes, a reset connection, a refused connection, and two races in
 * which a slow response arrives after a newer URL or direct load.
 *
 * Since T5 (#14) the specs/api-url.js assert spec asserts the loadMIDIUrl()
 * promise contract that these observations preceded (tasks/T6.md §13, §18);
 * this phase-A spec is kept unchanged as the baseline record.
 *
 * Every scenario first installs a small "previous" song directly, so the
 * observation shows whether a failed load kept it. Truncated MIDI bytes hang
 * the page at baseline (#4) and are exercised by the hang spec instead.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const pages = require("../lib/pages");
const smf = require("../lib/smf");
const { refusedOrigin } = require("../../../scripts/browser-server");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* eslint-disable no-undef -- page.evaluate callbacks run in the page */
const pageLoad = (p, url) => p.page.evaluate((u) => window.__t6url.load(u), url);
const pageBytes = (p, b64) => p.page.evaluate((b) => window.__t6url.loadBytes(b), b64);
const pageStatus = (p) => p.page.evaluate(() => window.__t6url.status());
/* eslint-enable no-undef */

// The "previous" song: one note, 960 ticks long.
const PREVIOUS = smf.write({ format: 0, division: 480, tracks: [[{ dt: 0, bytes: [0x90, 60, 100] }, { dt: 960, bytes: [0x80, 60, 0] }]] });
const PREVIOUS_TICKS = smf.read(PREVIOUS).endTick;

/*
 * Waits until the page has seen the request for `url` end (page/url.js records
 * each XMLHttpRequest's loadend, which follows the library's onload). Fails
 * the case if it does not happen within LOAD_WAIT_MS.
 */
const LOAD_WAIT_MS = 15000;
async function loaded(p, url) {
  const end = Date.now() + LOAD_WAIT_MS;
  for (;;) {
    const d = await p.page.evaluate((u) => window.__t6url.done(u), url); // eslint-disable-line no-undef -- runs in the page
    if (d) return d;
    if (Date.now() > end) throw new Error("no loadend for " + url + " within " + LOAD_WAIT_MS / 1000 + " s");
    await sleep(25);
  }
}

function cases(shared) {
  const { matrix, options, server } = shared;
  const ticks = (f) => smf.read(fs.readFileSync(path.join(pages.ROOT, f))).endTick;
  const WS = ticks("ws.mid"), GM = ticks("test-midi/all-gm-sounds.mid");
  const out = [];
  for (const build of matrix.builds) {
    out.push({
      id: "url " + build,
      dims: { build },
      deadline: 120,
      run: async (t) => {
        const pageId = "url-" + build;
        server.registerPage(pageId, pages.inlinePage({ library: pages.readLibrary(build, options.overrides), seed: options.seed, after: [pages.pageScript("xhr.js"), pages.pageScript("url.js")] }));
        let n = 0;
        const open = async () => {
          const p = await t.newPage();
          await p.page.goto(server.origin + "/html/" + pageId);
          const before = await pageBytes(p, PREVIOUS.toString("base64"));
          return { p, before };
        };
        const tag = () => "?t6=" + build + "-" + (++n);
        const result = async (p, before, urlPath) => {
          const after = await pageStatus(p);
          const reqs = server.requests.filter((r) => r.path.split("?")[1] === urlPath.split("?")[1]).map((r) => ({ path: r.path.split("?")[0], status: r.status, outcome: r.outcome }));
          return {
            maxTick: after.maxTick, keptPrevious: after.maxTick === before.maxTick && after.events === before.events,
            pageErrors: p.pageErrors.slice(), consoleErrors: p.consoleErrors.slice(0, 3), rejections: after.rejections, requests: reqs,
          };
        };
        const observed = {};

        // Success (asserted).
        {
          const { p, before } = await open();
          t.check("previous song installed directly", before.maxTick === PREVIOUS_TICKS, before.maxTick + " vs " + PREVIOUS_TICKS);
          const u = "/midi/ok/ws.mid" + tag();
          const ret = await pageLoad(p, u);
          const end = await loaded(p, u);
          const r = await result(p, before, u);
          t.check("200: the request completed (loadend after load)", end.outcome === "load" && end.status === 200, JSON.stringify(end));
          t.check("200: the song is installed (ws.mid end tick " + WS + ")", r.maxTick === WS, "maxTick " + r.maxTick);
          t.check("200: exactly one GET reached the server", r.requests.length === 1 && r.requests[0].status === 200, JSON.stringify(r.requests));
          t.check("200: no page errors", !r.pageErrors.length, r.pageErrors.join(" | "));
          observed["200 ok"] = Object.assign({ returned: ret.returned }, r);
        }
        // Failure modes (observed).
        const failures = [
          ["404", "/midi/status/404/ws.mid"], ["500", "/midi/status/500/ws.mid"], ["204", "/midi/status/204/ws.mid"],
          ["302 redirect to all-gm-sounds.mid", "/midi/redirect/test-midi/all-gm-sounds.mid"],
          ["200 empty body", "/midi/empty"], ["200 non-MIDI bytes", "/midi/garbage"], ["connection reset", "/midi/reset"],
        ];
        for (const [name, route] of failures) {
          const { p, before } = await open();
          const u = route + tag();
          const ret = await pageLoad(p, u);
          const end = await loaded(p, u);
          observed[name] = Object.assign({ returned: ret.returned, xhr: end }, await result(p, before, u));
        }
        {
          const { p, before } = await open();
          const u = (await refusedOrigin()) + "/midi/ok/ws.mid";
          const ret = await pageLoad(p, u);
          const end = await loaded(p, u);
          const after = await pageStatus(p);
          observed["connection refused (other port)"] = { returned: ret.returned, xhr: end, maxTick: after.maxTick, keptPrevious: after.maxTick === before.maxTick, pageErrors: p.pageErrors.slice(), consoleErrors: p.consoleErrors.slice(0, 3), rejections: after.rejections };
        }
        // Races (observed): a held response released after a newer load.
        {
          const { p, before } = await open();
          const key = "race-a-" + build;
          server.hold(key);
          const slow = "/midi/hold/" + key + "/ws.mid" + tag();
          await pageLoad(p, slow);
          const fast = "/midi/ok/test-midi/all-gm-sounds.mid" + tag();
          await pageLoad(p, fast);
          await loaded(p, fast);
          const mid = await pageStatus(p);
          server.release(key);
          await loaded(p, slow);
          const end = await pageStatus(p);
          observed["race: older URL answered after a newer URL"] = { afterNewer: mid.maxTick, final: end.maxTick, newerTicks: GM, olderTicks: WS, staleWins: end.maxTick === WS && mid.maxTick === GM, previous: before.maxTick };
        }
        {
          const { p } = await open();
          const key = "race-b-" + build;
          server.hold(key);
          const slow = "/midi/hold/" + key + "/ws.mid" + tag();
          await pageLoad(p, slow);
          const direct = await pageBytes(p, PREVIOUS.toString("base64"));
          server.release(key);
          await loaded(p, slow);
          const end = await pageStatus(p);
          observed["race: URL answered after a direct loadMIDI()"] = { afterDirect: direct.maxTick, final: end.maxTick, staleWins: end.maxTick === WS && direct.maxTick === PREVIOUS_TICKS };
        }
        t.observe("baseline URL loading (phase B asserts the #14 contract)", observed);
      },
    });
  }
  return out;
}

module.exports = { cases };
