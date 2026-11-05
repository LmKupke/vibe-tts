import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@vibe-tts/shared": resolve(import.meta.dirname, "packages/shared/src/index.ts"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "apps/**/*.test.tsx"],
    setupFiles: [resolve(import.meta.dirname, "tests/vitest.setup.ts")],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
