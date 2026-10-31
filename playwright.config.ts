import { defineConfig } from "@playwright/test";

// The app shows rubles by default; a fixed rate keeps the amounts in tests stable.
process.env.DRIMVOX_TEST_USD_RUB = "80";
// A real Ollama on the computer running the tests stays out of them (it has models, and Drimvox connects such an
// Ollama by itself); the tests that need one start a fake and say where.
process.env.DRIMVOX_TEST_OLLAMA_URL ??= "http://127.0.0.1:9/v1";

export default defineConfig({
  // The desktop window (Electron) and the server in a browser.
  testDir: "apps",
  testMatch: "**/e2e/*.spec.ts",
  workers: 1,
  timeout: 60_000,
  reporter: [["list"]],
});
