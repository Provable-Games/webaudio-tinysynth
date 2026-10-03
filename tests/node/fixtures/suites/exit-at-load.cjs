// node:test suite fixture for tests/node/runner.test.cjs: exits 0 while loading.
"use strict";
const test = require("node:test");
test("never runs", () => {});
process.exit(0);
