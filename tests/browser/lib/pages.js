/*
 * Test page construction for the browser matrix.
 *
 * Library builds: "source" is webaudio-tinysynth.js and "min" is the
 * minified build of the current source (scripts/test-build.js: .build/, or
 * TINYSYNTH_MIN), not the committed webaudio-tinysynth.min.js. Either path can
 * be replaced with --source=PATH or --min=PATH, for example to show that a
 * deliberately broken scratch copy fails the checks; the repository files are
 * never modified.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const testBuild = require("../../../scripts/test-build");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const PAGE_DIR = path.resolve(__dirname, "..", "page");

const BUILDS = {
  source: () => path.join(ROOT, "webaudio-tinysynth.js"),
  min: () => testBuild.existingMinPath(),
};

function libraryPath(build, overrides = {}) {
  if (!BUILDS[build]) throw new Error("unknown build " + build);
  return path.resolve(overrides[build] || BUILDS[build]());
}

function readLibrary(build, overrides) {
  return fs.readFileSync(libraryPath(build, overrides), "utf8");
}

function pageScript(name) {
  return fs.readFileSync(path.join(PAGE_DIR, name), "utf8");
}

/* Text safe to place inside an inline <script> element. */
function inlineSafe(js) {
  return js.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
}

function script(js) {
  return "<script>" + inlineSafe(js) + "</script>\n";
}

/*
 * A self-contained page: the prelude (seeded Math.random, interval and
 * rejection records) and optional instrumentation, then the inlined library,
 * in <head>; `body`, then the `after` scripts, in <body>. Nothing is fetched.
 */
function inlinePage({ library, seed = 1, instrument = false, after = [], body = "", title = "tinysynth browser matrix" }) {
  return "<!doctype html><html><head><meta charset=\"utf-8\"><title>" + title + "</title>\n" +
    script("window.__T6_SEED__ = " + (seed >>> 0) + ";") +
    script(pageScript("prelude.js")) +
    (instrument ? script(pageScript("instrument.js")) : "") +
    script(library) +
    "</head><body>" + body + "\n" + after.map(script).join("") + "</body></html>";
}

module.exports = { ROOT, BUILDS, libraryPath, readLibrary, pageScript, inlineSafe, inlinePage };
