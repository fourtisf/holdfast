import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PGlite boots a WASM Postgres per test.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
