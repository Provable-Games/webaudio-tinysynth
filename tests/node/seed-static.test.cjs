/*
 * Static guard for #7 (D-004): no Math.random anywhere in the library, on any
 * path, including those no runtime test exercises. Both builds are re-printed
 * by the pinned Terser with comments dropped and nothing else changed, so a
 * mention in a comment does not count and code is matched as code. Any
 * `random` identifier, property or string (Math.random, Math["random"], a
 * destructured `random`) fails the test. The source build and the minified
 * build are both checked: `npm run verify` ties the minified build to the
 * source, and this test does not depend on it.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { minify } = require("terser");
const H = require("../harness");

for (const build of H.forkVariants()) {
  test(build.name + " contains no Math.random (comments ignored)", async () => {
    const out = await minify(build.source, { compress: false, mangle: false, format: { comments: false, beautify: true } });
    const hits = out.code.split("\n").filter((line) => /random/i.test(line));
    assert.deepEqual(hits, [], "random in code: " + hits.slice(0, 3).join(" | "));
    assert.ok(out.code.includes("Math.imul"), "the re-printed code holds the generator (sanity check)");
  });
}
