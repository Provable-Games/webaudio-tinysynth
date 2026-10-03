import { defineConfig } from "vitest/config";

// Unit tests only. The standalone regression scripts (tests/*.js), the native
// Node tests (tests/node/**/*.test.cjs) and the browser smoke test are run by
// their own commands and must not be collected here: the regression scripts run
// at import and call process.exit.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.mjs"],
    watch: false,
  },
});
