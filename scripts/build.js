#!/usr/bin/env node
/*
 * Builds webaudio-tinysynth.min.js and webaudio-tinysynth.min.js.map from
 * webaudio-tinysynth.js with the pinned Terser.
 *
 * Every input and option of the build is in this file. `npm run build`
 * writes the outputs to the repository root; `npm run verify` calls build()
 * with a temporary directory and compares the bytes with the committed files.
 * The Terser version must equal the exact version pinned in package.json
 * (and package-lock.json), otherwise the build stops.
 *
 * Usage: node scripts/build.js [outDir]    (default: the repository root)
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = "webaudio-tinysynth.js";
const OUTPUT = "webaudio-tinysynth.min.js";
const MAP = OUTPUT + ".map";

/*
 * Keep the source's header comment: it names the author, the upstream
 * project and the Apache License 2.0, and points to NOTICE. The minified
 * file is embedded onchain on its own, without LICENSE or NOTICE beside it.
 */
function licenseHeader(node, comment) {
  return comment.type === "comment2" && /Apache License/.test(comment.value);
}

/*
 * Terser minify() options. They are spelled out, including values equal to
 * Terser's defaults, so a Terser upgrade cannot silently change a default
 * we rely on.
 */
const TERSER_OPTIONS = {
  ecma: 5,              // output syntax level; ES2015+ input syntax is kept as written
  module: false,        // classic script, not an ES module
  toplevel: false,      // the wrapper's this/window binding stays as written
  ie8: false,
  safari10: false,
  keep_classnames: true, // WebAudioTinySynth.name stays "WebAudioTinySynth"
  keep_fnames: false,
  rename: false,        // as the Terser CLI without --rename
  parse: {},
  compress: {},         // all default compress options (the CLI's --compress)
  mangle: {             // local variable and parameter names only:
    properties: false,  // never property names, so every method, option and
    toplevel: false,    // property keeps its name
    eval: false,
    reserved: [],
  },
  format: {
    comments: licenseHeader,
    ascii_only: true,   // escape any non-ASCII in strings and regexps
    inline_script: true, // escape "</script" and "<!--" inside strings
    beautify: false,
    semicolons: true,
    max_line_len: false,
    preamble: null,
  },
  sourceMap: {
    filename: OUTPUT,   // the map's "file" field names the minified file
    url: null,          // no sourceMappingURL comment in the minified file
    root: null,
    includeSources: false,
    asObject: false,
    content: null,
  },
};

function pinnedTerser() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const pinned = pkg.devDependencies && pkg.devDependencies.terser;
  if (!/^\d+\.\d+\.\d+$/.test(pinned || ""))
    throw new Error("package.json must pin terser to an exact version, found " + JSON.stringify(pinned));
  const installed = require("terser/package.json").version;
  if (installed !== pinned)
    throw new Error("installed terser is " + installed + " but package.json pins " + pinned + "; run npm ci");
  return { minify: require("terser").minify, version: installed };
}

/* Minify SOURCE into outDir. Returns the output paths and the Terser version. */
async function build(outDir) {
  const terser = pinnedTerser();
  // LF line endings, so a CRLF checkout builds the same bytes (the kept header spans lines).
  const code = fs.readFileSync(path.join(ROOT, SOURCE), "utf8").replace(/\r\n?/g, "\n");
  // The key is the name recorded in the map's "sources": the file next to the map.
  const result = await terser.minify({ [SOURCE]: code }, TERSER_OPTIONS);
  fs.mkdirSync(outDir, { recursive: true });
  const out = { min: path.join(outDir, OUTPUT), map: path.join(outDir, MAP), terser: terser.version };
  fs.writeFileSync(out.min, result.code);
  fs.writeFileSync(out.map, result.map);
  return out;
}

module.exports = { ROOT, SOURCE, OUTPUT, MAP, TERSER_OPTIONS, build };

if (require.main === module) {
  build(path.resolve(process.argv[2] || ROOT)).then((out) => {
    console.log("terser " + out.terser + ": " + SOURCE + " -> " +
      path.relative(process.cwd(), out.min) + ", " + path.relative(process.cwd(), out.map));
  }, (e) => {
    console.error("build failed: " + (e && e.stack || e));
    process.exit(1);
  });
}
