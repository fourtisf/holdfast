import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PGlite boots a WASM Postgres per test file.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
