/*
 * Test page construction for the browser matrix.
 *
 * Library builds: "source" is webaudio-tinysynth.js and "min" is
 * webaudio-tinysynth.min.js. Either path can be replaced with --source=PATH or
 * --min=PATH, for example to show that a deliberately broken scratch copy
 * fails the checks; the repository files are never modified.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const PAGE_DIR = path.resolve(__dirname, "..", "page");

const BUILDS = {
  source: "webaudio-tinysynth.js",
  min: "webaudio-tinysynth.min.js",
};

function libraryPath(build, overrides = {}) {
  if (!BUILDS[build]) throw new Error("unknown build " + build);
  return path.resolve(overrides[build] || path.join(ROOT, BUILDS[build]));
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
 * A self-contained page: the prelude (seeded Math.random and rejection
 * capture), optional instrumentation, the inlined library, then `after`
 * scripts. Nothing is fetched.
 */
function inlinePage({ library, seed = 1, instrument = false, after = [], body = "", title = "tinysynth browser matrix" }) {
  return "<!doctype html><html><head><meta charset=\"utf-8\"><title>" + title + "</title>\n" +
    script("window.__T6_SEED__ = " + (seed >>> 0) + ";") +
    script(pageScript("prelude.js")) +
    (instrument ? script(pageScript("instrument.js")) : "") +
    script(library) +
    after.map(script).join("") +
    "</head><body>" + body + "</body></html>";
}

module.exports = { ROOT, BUILDS, libraryPath, readLibrary, pageScript, inlineSafe, inlinePage };
