import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "apps/desktop/e2e",
  workers: 1,
  timeout: 60_000,
  reporter: [["list"]],
});
