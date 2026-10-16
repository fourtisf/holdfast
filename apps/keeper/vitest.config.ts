import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The e2e tests boot PGlite and an in-process SVM with the compiled program per test.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
