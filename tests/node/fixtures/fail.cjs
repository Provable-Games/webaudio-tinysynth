// Child fixture for tests/node/runner.test.cjs: reports a failure the way the regression scripts do.
"use strict";
console.error("FAIL: fixture assertion");
process.exit(1);
