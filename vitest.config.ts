import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // React 19 automatic runtime for component tests (*.test.tsx run under jsdom per file).
  esbuild: { jsx: "automatic" },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    environment: "node",
    // Unit tests must never reach PayPal or an LLM.
    env: { PAYGUARD_TEST: "1" },
  },
});
