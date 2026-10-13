import { defineConfig } from "@playwright/test";

// The app shows rubles by default; a fixed rate keeps the amounts in tests stable.
process.env.ARTEL_TEST_USD_RUB = "80";

export default defineConfig({
  // The desktop window (Electron) and the server in a browser.
  testDir: "apps",
  testMatch: "**/e2e/*.spec.ts",
  workers: 1,
  timeout: 60_000,
  reporter: [["list"]],
});
