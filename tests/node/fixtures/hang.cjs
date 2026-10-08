// Child fixture for tests/node/runner.test.cjs: never finishes (a synchronous loop, so no timer can interrupt it).
"use strict";
console.log("hanging");
for (;;) { /* spin */ }
