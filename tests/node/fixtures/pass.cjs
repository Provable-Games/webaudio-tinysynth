// Child fixture for tests/node/runner.test.cjs: succeeds, echoing its arguments.
"use strict";
console.log(["PASS: fixture", ...process.argv.slice(2)].join(" "));
