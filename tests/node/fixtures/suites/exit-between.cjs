// node:test suite fixture for tests/node/runner.test.cjs: exits 0 after its first test, before the rest finish.
"use strict";
const test = require("node:test");
test("first", () => { setImmediate(() => process.exit(0)); });
test("second", async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
test("third", () => {});
