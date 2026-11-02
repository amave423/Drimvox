import { defineConfig } from "@playwright/test";

// The README's screenshots: `npm run screenshots` (apps/desktop/shots).
process.env.DRIMVOX_TEST_OLLAMA_URL ??= "http://127.0.0.1:9/v1";

export default defineConfig({
  testDir: "apps",
  testMatch: "**/shots/*.shots.ts",
  workers: 1,
  timeout: 300_000,
  reporter: [["list"]],
});
