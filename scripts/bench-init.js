#!/usr/bin/env node
/*
 * Initialization benchmark (#18): what a synth costs before and at its first notes.
 *
 *   node scripts/bench-init.js node    [--src=FILE] [--reps=N]
 *   node scripts/bench-init.js browser [--src=FILE] [--engines=chromium,firefox,webkit]
 *                                      [--cold=N] [--warm=N] [--json=OUT]
 *
 * --src measures another copy of the library (for example the base commit's
 * source, saved with `git show <commit>:webaudio-tinysynth.js`); the default is
 * this checkout's webaudio-tinysynth.js. Nothing in the repository is written.
 *
 * The library is first instrumented: a call __t8m(label) is inserted before a
 * few statements of setAudioContext() (ANCHORS below; an anchor a source does
 * not have is reported as n/a). The browser mode then minifies that copy with
 * the pinned build options (scripts/build.js), so it measures the min.js a
 * consumer embeds plus those calls; the node mode runs the instrumented source.
 *
 * node: the mock WebAudio of tests/harness.js, loaded into the main V8 context
 * with new Function(). (The harness's vm contexts run Math.sin about 15 times
 * slower than the main context, so its timings are not representative.) Prints
 * the constructor, setQuality() and setAudioContext() breakdown, the first
 * noise notes, and the JS heap and ArrayBuffer memory a synth keeps. The mock
 * has no audio rendering: use it for breakdowns, not absolute browser costs.
 *
 * browser: Playwright (playwright-core, or PLAYWRIGHT_CORE) launches each
 * engine headless; the page is served from an ephemeral 127.0.0.1 port with
 * COOP/COEP headers so performance.now() has its finest resolution
 * (crossOriginIsolated is recorded with the measured resolution). For each
 * quality (0, 1), useReverb (0, 1) and sample rate (44100, 48000), on an
 * OfflineAudioContext:
 *   cold   --cold fresh browser contexts (default 8), one measurement each: the
 *          consumer's first construction new WebAudioTinySynth({context, ...}),
 *          split into the constructor's own work and setAudioContext() (with
 *          the instrumented segments), then its first note (program 0), its
 *          first n0 note, its first n1 note (program 119, Reverse Cymbal) and a
 *          second n1 note;
 *   warm   the same sequence --warm times (default 20) in one page after 3
 *          untimed runs, plus a lazy constructor and setQuality(q) alone;
 *   graph  nodes and buffer bytes created by the install and by the first notes;
 *   poly   a dense chord (60 melodic voices on 15 channels and 12 drum hits,
 *          64 voices allowed) scheduled on a 2 s OfflineAudioContext: the
 *          construction, reading noiseBuf.n1 (the whole generation when it is
 *          lazy), the JS time to schedule the chord and startRendering().
 * Each engine first runs two discarded rounds (its start-up is slower). Chromium also measures the realtime default path, new WebAudioTinySynth()
 * with its internal AudioContext, cold. Results are printed as median
 * [p10, p90] in milliseconds and, with --json, saved with every sample.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");

const ROOT = path.resolve(__dirname, "..");

/*
 * [label, the statement it is inserted before]. A segment runs from its mark to the next one:
 * core (the per-instance tables and option checks), quality (the constructor's setQuality()
 * calls and options), init (timer and state, up to the install), then setAudioContext()'s parts.
 */
const ANCHORS = [
  ["core", ["WebAudioTinySynthCore.bind(this)(this);"]],
  ["quality", ["this._lazy=l;"]],
  ["init", ["this.init(c,d);"]],
  ["install", ["this._check(actx,dest);\n      /* The registered"]],
  ["buffers", ["var blen=this.actx.sampleRate*.5|0;"]],
  ["conv", ["let g=rnd(0);"]],
  ["n0", ["\n      g=rnd(1);", "\n      const dn=this.noiseBuf.n0.getChannelData(0),g=rnd(1);"]],
  ["n1", ["\n      g=rnd(2);"]],
  ["graph", ["if(this.useReverb){\n        this.conv="]],
  ["channels", ["this.chvol=[]; this.chmod=[]; this.chpan=[];\n      this.wave="]],
  ["reset", ["this.setReverbLev();\n      this.reset();"]],
];
const END = "this.send([0x90,60,0]);\n    },\n  });";

/* Inserts each label's mark before the first of its statements that occurs exactly once (after a leading line break). */
function instrument(src) {
  const found = [];
  for (const [label, alts] of ANCHORS) {
    const at = alts.find((a) => src.split(a).length === 2);
    if (!at) continue;
    const i = src.indexOf(at) + (at.length - at.trimStart().length);
    src = src.slice(0, i) + "__t8m(" + JSON.stringify(label) + ");" + src.slice(i);
    found.push(label);
  }
  if (src.split(END).length !== 2) throw new Error("end anchor not found: the bench needs setAudioContext() to end with the warm-up note");
  src = src.replace(END, () => "this.send([0x90,60,0]);__t8m(\"end\");\n    },\n  });");
  return { src, found };
}

function args(argv) {
  const o = { mode: argv[0], src: path.join(ROOT, "webaudio-tinysynth.js"), engines: ["chromium", "firefox", "webkit"], cold: 8, warm: 20, reps: 30, json: null };
  for (const a of argv.slice(1)) {
    const m = /^--(\w+)=(.*)$/.exec(a);
    if (!m) throw new Error("unknown argument " + a);
    if (m[1] === "engines") o.engines = m[2].split(",");
    else if (["cold", "warm", "reps"].includes(m[1])) o[m[1]] = +m[2];
    else if (m[1] === "src" || m[1] === "json") o[m[1]] = path.resolve(m[2]);
    else throw new Error("unknown option " + a);
  }
  if (!["node", "browser"].includes(o.mode)) throw new Error("usage: bench-init.js node|browser [options]");
  return o;
}

const q = (a, p) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const f = (x) => x == null ? "n/a" : x < 10 ? x.toFixed(3) : x.toFixed(1);
const stat = (a) => a.length && a.every((x) => x != null) ? f(q(a, 0.5)) + " [" + f(q(a, 0.1)) + ", " + f(q(a, 0.9)) + "]" : "n/a";

/* Splits the marks of one install [[label, t], ...] into segment durations. */
function segments(marks) {
  const out = {};
  for (let i = 0; i + 1 < marks.length; ++i) out[marks[i][0]] = (out[marks[i][0]] || 0) + marks[i + 1][1] - marks[i][1];
  return out;
}

const CONFIGS = [];
for (const quality of [0, 1]) for (const useReverb of [0, 1]) for (const sr of [44100, 48000]) CONFIGS.push({ quality, useReverb, sr });
const cfgName = (c) => "q" + c.quality + " rev" + c.useReverb + " " + c.sr / 1000 + "k";

/* ---------------- node mode ---------------- */

function nodeMode(o) {
  const H = require("../tests/harness");
  const { src, found } = instrument(fs.readFileSync(o.src, "utf8"));
  const env = H.createEnvironment({ push() {} });
  const marks = [];
  const M = { exports: {} };
  new Function("module", "exports", "AudioContext", "setInterval", "clearInterval", "__t8m", src)(M, M.exports, env.sandbox.AudioContext,
    env.sandbox.setInterval, env.sandbox.clearInterval, (l) => marks.push([l, performance.now()]));
  const S = M.exports;
  const ctx = (sr) => { const c = new env.sandbox.AudioContext(); c.sampleRate = sr; return c; };
  const segs = found;
  console.log("node " + process.version + ", " + path.relative(process.cwd(), o.src) + ", segments: " + segs.join(" ") + "\n");
  console.log("ms, median [p10, p90] of " + o.reps + " runs after 5 untimed ones. new WebAudioTinySynth({context, quality, useReverb}), its segments, then notes; then a lazy constructor and setQuality(q) alone.\n");
  console.log("| config | construct | " + segs.join(" | ") + " | first n1 note | second n1 note | lazy constructor | setQuality(q) |");
  console.log("|---|---|" + segs.map(() => "---|").join("") + "---|---|---|---|");
  for (const c of CONFIGS) {
    const r = { construct: [], n1a: [], n1b: [], lazy: [], sq: [] }, seg = {};
    for (let i = 0; i < o.reps + 5; ++i) {
      const x = ctx(c.sr);
      marks.length = 0;
      let t = performance.now();
      const s = new S({ context: x, quality: c.quality, useReverb: c.useReverb });
      const construct = performance.now() - t;
      const sg = segments(marks);
      s.send([0xc1, 119]);
      t = performance.now();
      s.send([0x91, 60, 100]);
      const n1a = performance.now() - t;
      t = performance.now();
      s.send([0x91, 62, 100]);
      const n1b = performance.now() - t;
      s.dispose();
      t = performance.now();
      const l = new S({ lazy: true, quality: c.quality, useReverb: c.useReverb });
      const lazy = performance.now() - t;
      t = performance.now();
      l.setQuality(c.quality);
      const sq = performance.now() - t;
      l.dispose();
      if (i < 5) continue;
      r.construct.push(construct); r.n1a.push(n1a); r.n1b.push(n1b); r.lazy.push(lazy); r.sq.push(sq);
      for (const k of segs) (seg[k] = seg[k] || []).push(sg[k] == null ? null : sg[k]);
    }
    console.log("| " + cfgName(c) + " | " + stat(r.construct) + " | " + segs.map((k) => stat(seg[k] || [])).join(" | ") + " | " +
      [r.n1a, r.n1b, r.lazy, r.sq].map(stat).join(" | ") + " |");
  }
  if (typeof global.gc === "function") {
    console.log("\nMemory kept per synth, KiB (20 synths, after gc; the mock's buffers are Float32Arrays, counted as ArrayBuffers):\n");
    console.log("| config | lazy constructor: heap | install: heap | install: buffers | first n1 note: buffers |");
    console.log("|---|---|---|---|---|");
    for (const c of CONFIGS) {
      global.gc();
      const m0 = process.memoryUsage();
      const keep = [];
      for (let i = 0; i < 20; ++i) keep.push(new S({ lazy: true, quality: c.quality, useReverb: c.useReverb }));
      global.gc();
      const m1 = process.memoryUsage();
      keep.forEach((s) => s.setAudioContext(ctx(c.sr)));
      global.gc();
      const m2 = process.memoryUsage();
      keep.forEach((s) => { s.send([0xc1, 119]); s.send([0x91, 60, 100]); });
      global.gc();
      const m3 = process.memoryUsage();
      const kb = (a, b, k) => ((b[k] - a[k]) / 20 / 1024).toFixed(1);
      console.log("| " + cfgName(c) + " | " + kb(m0, m1, "heapUsed") + " | " + kb(m1, m2, "heapUsed") + " | " + kb(m1, m2, "arrayBuffers") + " | " + kb(m2, m3, "arrayBuffers") + " |");
      keep.forEach((s) => s.dispose());
    }
  } else {
    console.log("\n(run with node --expose-gc for the memory table)");
  }
}

/* ---------------- browser mode ---------------- */

/* eslint-disable no-undef -- runs in the page */
function pageMain() {
  const marks = [];
  window.__t8m = (l) => marks.push([l, performance.now()]);
  const counts = { on: false, nodes: {}, bufferBytes: 0 };
  for (const k of Object.getOwnPropertyNames(BaseAudioContext.prototype)) {
    if (!/^create/.test(k)) continue;
    const fn = BaseAudioContext.prototype[k];
    BaseAudioContext.prototype[k] = function () {
      if (counts.on) {
        counts.nodes[k] = (counts.nodes[k] || 0) + 1;
        if (k === "createBuffer") counts.bufferBytes += arguments[0] * arguments[1] * 4;
      }
      return fn.apply(this, arguments);
    };
  }
  const now = () => performance.now();
  const seg = () => {
    const out = {};
    for (let i = 0; i + 1 < marks.length; ++i) out[marks[i][0]] = (out[marks[i][0]] || 0) + marks[i + 1][1] - marks[i][1];
    return out;
  };
  /* The consumer's first construction and first notes. */
  function flow(c) {
    const ctx = new OfflineAudioContext(2, c.sr, c.sr);
    marks.length = 0;
    const t0 = now();
    const s = new WebAudioTinySynth({ context: ctx, quality: c.quality, useReverb: c.useReverb });
    const t1 = now();
    const m = marks.find((x) => x[0] === "install");
    const sacStart = m ? m[1] : null;
    const sg = seg();
    s.send([0x90, 60, 100]);
    const t2 = now();
    s.send([0x99, c.quality ? 38 : 42, 100]); // an n0 drum in either quality (snare 38 at q1, closed hi-hat 42 at q0)
    const t3 = now();
    s.send([0xc1, 119]);
    const t4 = now();
    s.send([0x91, 60, 100]); // program 119 uses n1 in both qualities
    const t5 = now();
    s.send([0x91, 64, 100]);
    const t6 = now();
    s.dispose();
    return { construct: t1 - t0, ctorOwn: sacStart == null ? null : sacStart - t0, install: sacStart == null ? null : t1 - sacStart, seg: sg,
      firstNote: t2 - t1, ready: t2 - t0, n0Note: t3 - t2, n1Note: t5 - t4, n1Note2: t6 - t5 };
  }
  function resolution() {
    let min = Infinity, t = now();
    for (let i = 0; i < 2e5; ++i) { const u = now(); if (u > t) { min = Math.min(min, u - t); t = u; } }
    return min;
  }
  window.__bench = {
    cold: (c) => flow(c),
    info: () => ({ crossOriginIsolated: window.crossOriginIsolated, resolution: resolution(), ua: navigator.userAgent }),
    warm: (c, n) => {
      for (let i = 0; i < 3; ++i) flow(c);
      const r = [];
      for (let i = 0; i < n; ++i) r.push(flow(c));
      const lazy = [], sq = [];
      for (let i = 0; i < n + 3; ++i) {
        let t = now();
        const s = new WebAudioTinySynth({ lazy: true, quality: c.quality, useReverb: c.useReverb });
        const a = now() - t;
        t = now();
        s.setQuality(c.quality);
        const b = now() - t;
        s.dispose();
        if (i >= 3) { lazy.push(a); sq.push(b); }
      }
      return { flows: r, lazyCtor: lazy, setQuality: sq };
    },
    graph: (c) => {
      const ctx = new OfflineAudioContext(2, c.sr, c.sr);
      counts.on = true; counts.nodes = {}; counts.bufferBytes = 0;
      const s = new WebAudioTinySynth({ context: ctx, quality: c.quality, useReverb: c.useReverb });
      const install = { nodes: Object.assign({}, counts.nodes), bufferBytes: counts.bufferBytes };
      counts.nodes = {}; counts.bufferBytes = 0;
      s.send([0xc1, 119]);
      s.send([0x91, 60, 100]);
      const n1 = { nodes: Object.assign({}, counts.nodes), bufferBytes: counts.bufferBytes };
      counts.on = false;
      s.dispose();
      return { install, n1Note: n1 };
    },
    poly: async (c) => {
      const ctx = new OfflineAudioContext(2, 2 * c.sr, c.sr);
      const t00 = now();
      const s = new WebAudioTinySynth({ context: ctx, quality: c.quality, useReverb: c.useReverb, voices: 64 });
      const t01 = now();
      s.noiseBuf.n1; // a lazily generated n1 is paid here, not in the schedule time below
      const t02 = now();
      const progs = [0, 16, 24, 32, 40, 48, 56, 61, 73, 80, 88, 104, 114, 119, 127];
      const t0 = now();
      progs.forEach((p, i) => {
        const ch = i < 9 ? i : i + 1;
        s.send([0xc0 | ch, p], 0);
        for (let k = 0; k < 4; ++k) s.send([0x90 | ch, 48 + 7 * k + i, 100], 0.05);
        for (let k = 0; k < 4; ++k) s.send([0x80 | ch, 48 + 7 * k + i, 0], 1.2);
      });
      for (let k = 0; k < 12; ++k) s.send([0x99, 35 + 2 * k, 110], 0.05 + 0.1 * k);
      const t1 = now();
      await ctx.startRendering();
      const t2 = now();
      await s.dispose();
      return { construct: t01 - t00, n1: t02 - t01, schedule: t1 - t0, render: t2 - t1 };
    },
    realtime: (c) => {
      const t0 = now();
      const s = new WebAudioTinySynth({ quality: c.quality, useReverb: c.useReverb });
      const t1 = now();
      s.send([0x90, 60, 100]);
      const t2 = now();
      const sr = s.getAudioContext().sampleRate;
      s.dispose();
      return { construct: t1 - t0, ready: t2 - t0, sr };
    },
  };
}
/* eslint-enable no-undef */

async function minify(src) {
  const { TERSER_OPTIONS } = require("./build");
  const r = await require("terser").minify({ "webaudio-tinysynth.js": src }, Object.assign({}, TERSER_OPTIONS, { sourceMap: false }));
  return r.code;
}

function serve(html) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp", "cache-control": "no-store" });
    res.end(html);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: "http://127.0.0.1:" + server.address().port + "/" })));
}

async function browserMode(o) {
  const playwright = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
  const { src, found } = instrument(fs.readFileSync(o.src, "utf8"));
  const lib = await minify(src);
  const html = "<!doctype html><html><head><meta charset=\"utf-8\"><title>bench</title><script>(" + pageMain.toString() + ")();</script><script>" +
    lib.replace(/<\/script/gi, "<\\/script") + "</script></head><body></body></html>";
  const { server, url } = await serve(html);
  const out = { src: o.src, marks: found, host: { cpus: os.cpus().length, model: os.cpus()[0].model, load: os.loadavg(), node: process.version }, started: new Date().toISOString(), engines: {} };
  try {
    for (const engine of o.engines) {
      const browser = await playwright[engine].launch({ headless: true, timeout: 60000 });
      const E = out.engines[engine] = { version: browser.version(), configs: {} };
      try {
        const page0 = await (await browser.newContext()).newPage();
        await page0.goto(url);
        E.info = await page0.evaluate(() => globalThis.__bench.info());
        await page0.context().close();
        /* The first measurements of a browser process run slower (its own start-up); two discarded rounds, in fresh pages, absorb that. */
        for (let i = 0; i < 2; ++i) {
          const wc = await browser.newContext();
          const wp = await wc.newPage();
          await wp.goto(url);
          await wp.evaluate((c) => { globalThis.__bench.cold(c); return globalThis.__bench.poly(c); }, CONFIGS[0]);
          await wc.close();
        }
        console.log("== " + engine + " " + E.version + " crossOriginIsolated=" + E.info.crossOriginIsolated + " resolution=" + E.info.resolution.toFixed(4) + " ms");
        for (const c of CONFIGS) {
          const R = E.configs[cfgName(c)] = { cold: [], warm: null, graph: null, poly: [], realtime: [] };
          for (let i = 0; i < o.cold; ++i) {
            const bc = await browser.newContext();
            const p = await bc.newPage();
            await p.goto(url);
            R.cold.push(await p.evaluate((c) => globalThis.__bench.cold(c), c));
            await bc.close();
            if (engine === "chromium" && c.sr === 44100) { // the internal context has the device's rate
              const rc = await browser.newContext();
              const rp = await rc.newPage();
              await rp.goto(url);
              R.realtime.push(await rp.evaluate((c) => globalThis.__bench.realtime(c), c));
              await rc.close();
            }
          }
          const bc = await browser.newContext();
          const p = await bc.newPage();
          await p.goto(url);
          R.warm = await p.evaluate(([c, n]) => globalThis.__bench.warm(c, n), [c, o.warm]);
          R.graph = await p.evaluate((c) => globalThis.__bench.graph(c), c);
          for (let i = 0; i < 5; ++i) R.poly.push(await p.evaluate((c) => globalThis.__bench.poly(c), c));
          await bc.close();
          process.stdout.write(".");
        }
        process.stdout.write("\n");
      } finally {
        await browser.close();
      }
    }
  } finally {
    server.close();
  }
  out.finished = new Date().toISOString();
  report(out);
  if (o.json) fs.writeFileSync(o.json, JSON.stringify(out, null, 1));
}

function report(out) {
  const segs = out.marks;
  for (const [engine, E] of Object.entries(out.engines)) {
    console.log("\n### " + engine + " " + E.version + " (crossOriginIsolated " + E.info.crossOriginIsolated + ", timer resolution " + E.info.resolution.toFixed(4) + " ms)\n");
    console.log("Cold (fresh browser context, first construction), ms:\n");
    console.log("| config | construct + first note | constructor's own | of which: core | quality | setAudioContext | of which: n1 | first n0 note | first n1 note | second n1 note |");
    console.log("|---|---|---|---|---|---|---|---|---|---|");
    for (const [k, R] of Object.entries(E.configs)) {
      const col = (key) => stat(R.cold.map((x) => x[key]));
      const sc = (key) => stat(R.cold.map((x) => x.seg[key] == null ? null : x.seg[key]));
      console.log("| " + k + " | " + [col("ready"), col("ctorOwn"), sc("core"), sc("quality"), col("install"), sc("n1"), col("n0Note"), col("n1Note"), col("n1Note2")].join(" | ") + " |");
    }
    console.log("\nWarm, ms:\n");
    console.log("| config | construct + first note | setAudioContext | " + segs.join(" | ") + " | first n1 note | lazy constructor | setQuality(q) |");
    console.log("|---|---|---|" + segs.map(() => "---|").join("") + "---|---|---|");
    for (const [k, R] of Object.entries(E.configs)) {
      const W = R.warm.flows;
      console.log("| " + k + " | " + stat(W.map((x) => x.ready)) + " | " + stat(W.map((x) => x.install)) + " | " +
        segs.map((s) => stat(W.map((x) => x.seg[s] == null ? null : x.seg[s]))).join(" | ") + " | " + stat(W.map((x) => x.n1Note)) + " | " +
        stat(R.warm.lazyCtor) + " | " + stat(R.warm.setQuality) + " |");
    }
    console.log("\nGraph and buffers created; dense chord (64 voices, 2 s offline), ms:\n");
    console.log("| config | install: nodes | install: buffer KiB | chord: construct | chord: read n1 | chord: schedule | chord: render |");
    console.log("|---|---|---|---|---|---|---|");
    for (const [k, R] of Object.entries(E.configs)) {
      const n = Object.values(R.graph.install.nodes).reduce((a, b) => a + b, 0);
      console.log("| " + k + " | " + n + " | " + (R.graph.install.bufferBytes / 1024).toFixed(1) + " | " + stat(R.poly.map((x) => x.construct)) + " | " + stat(R.poly.map((x) => x.n1)) + " | " +
        stat(R.poly.map((x) => x.schedule)) + " | " + stat(R.poly.map((x) => x.render)) + " |");
    }
    if (engine === "chromium") {
      console.log("\nRealtime default path, new WebAudioTinySynth() + first note, cold, ms (the context's own rate):\n");
      console.log("| config | sample rate | construct | construct + first note |");
      console.log("|---|---|---|---|");
      for (const [k, R] of Object.entries(E.configs)) {
        if (!/ 44\.1k$/.test(k)) continue; // the rate option does not apply to the internal context
        console.log("| " + k.replace(/ 44\.1k$/, "") + " | " + R.realtime[0].sr + " | " + stat(R.realtime.map((x) => x.construct)) + " | " + stat(R.realtime.map((x) => x.ready)) + " |");
      }
    }
  }
}

if (require.main === module) {
  const o = args(process.argv.slice(2));
  if (o.mode === "node") nodeMode(o);
  else browserMode(o).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
}

module.exports = { instrument, ANCHORS };
