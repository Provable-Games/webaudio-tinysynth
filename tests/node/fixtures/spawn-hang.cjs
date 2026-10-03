// Child fixture for tests/node/runner.test.cjs: starts a grandchild that never exits,
// writes its pid to $PIDFILE, then hangs itself.
"use strict";
const fs = require("fs");
const { spawn } = require("child_process");
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(process.env.PIDFILE, String(grandchild.pid));
console.log("grandchild " + grandchild.pid);
for (;;) { /* spin */ }
