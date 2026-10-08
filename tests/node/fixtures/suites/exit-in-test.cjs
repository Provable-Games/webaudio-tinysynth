// node:test suite fixture for tests/node/runner.test.cjs: exits 0 inside its second test.
"use strict";
const test = require("node:test");
test("first", () => {});
test("second exits", () => { process.exit(0); });
test("third", () => {});
