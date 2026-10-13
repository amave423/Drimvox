import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The app as the installer puts it: built by `npm run dist`. Without a build there is nothing to check.
const unpacked = fileURLToPath(new URL("../release/", import.meta.url));
const exe = join(unpacked, process.platform === "win32" ? "win-unpacked/Artel.exe" : "linux-unpacked/artel");

let app: ElectronApplication | undefined;
let userData: string;

test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), "artel-e2e-"));
});

test.afterEach(async () => {
  await app?.close().catch(() => {});
  app = undefined;
  rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test("the packaged app starts its core from the archive and shows the interface", async () => {
  test.skip(!existsSync(exe), "no packaged build: run npm run dist");
  app = await electron.launch({ executablePath: exe, env: { ...process.env, ARTEL_USER_DATA: userData, ARTEL_NO_UPDATES: "1" } });
  const page = await app.firstWindow();
  await expect(page.getByText("Ядро запущено")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Artel 0.1.0")).toBeVisible();
  expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
  // Fonts and styles come from resources/web, not from the internet.
  expect(await page.evaluate(() => document.fonts.check('600 16px "Source Serif 4"'))).toBe(true);
  await page.getByRole("button", { name: "Настройки" }).click();
  await expect(page.getByRole("button", { name: "Проверить уведомление" })).toBeVisible();
});
