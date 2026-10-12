import { defineConfig } from "@playwright/test";

// The app shows rubles by default; a fixed rate keeps the amounts in tests stable.
process.env.ARTEL_TEST_USD_RUB = "80";

export default defineConfig({
  testDir: "apps/desktop/e2e",
  workers: 1,
  timeout: 60_000,
  reporter: [["list"]],
});
