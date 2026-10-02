import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Frontend unit and component tests: Vitest with jsdom and Testing Library.
 *
 * Nothing reaches a real server — `src/test/api.ts` stands in for the backend
 * at `fetch`, the one place every request goes through.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/test/**", "src/**/*.d.ts", "src/types/**"],
      reporter: ["text-summary", "json-summary", "json", "html"],
      reportsDirectory: "./coverage",
    },
  },
});
