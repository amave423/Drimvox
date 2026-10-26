import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The app as the installer puts it: built by `npm run dist`. Without a build there is nothing to check.
const unpacked = fileURLToPath(new URL("../release/", import.meta.url));
const exe = join(unpacked, process.platform === "win32" ? "win-unpacked/Drimvox.exe" : "linux-unpacked/drimvox");

let app: ElectronApplication | undefined;
let userData: string;

test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), "drimvox-e2e-"));
});

test.afterEach(async () => {
  await app?.close().catch(() => {});
  app = undefined;
  rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test("the packaged app starts its core from the archive and shows the interface", async () => {
  test.skip(!existsSync(exe), "no packaged build: run npm run dist");
  app = await electron.launch({ executablePath: exe, env: { ...process.env, DRIMVOX_USER_DATA: userData, DRIMVOX_NO_UPDATES: "1" } });
  const page = await app.firstWindow();
  await expect(page.getByRole("button", { name: "Ключи и модели" }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/^Drimvox \d+\.\d+\.\d+$/)).toBeVisible();
  expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
  // Fonts and styles come from resources/web, not from the internet.
  // Loaded on purpose: whether the start page already used the face depends on timing; a missing file loads nothing.
  expect(await page.evaluate(async () => (await document.fonts.load('600 16px "Source Serif 4"')).length > 0)).toBe(true);
  await page.getByRole("button", { name: "Настройки" }).click();
  await expect(page.getByRole("button", { name: "Проверить уведомление" })).toBeVisible();
});

// Seen: an installed 0.2.0 never updated and nothing said why. Now the settings say what GitHub answered.
test("the installed app says whether it is the latest version, and what went wrong when it cannot tell", async () => {
  test.skip(!existsSync(exe), "no packaged build: run npm run dist");
  // A feed with an older version: nothing to download.
  const feed = createServer((req, res) => {
    if (req.url?.startsWith("/ok/latest.yml")) {
      res.writeHead(200, { "content-type": "text/yaml" });
      res.end(["version: 0.0.1", "files:", "  - url: Drimvox-Setup-0.0.1.exe", "    sha512: x", "    size: 1", "path: Drimvox-Setup-0.0.1.exe", "sha512: x", ""].join("\n"));
    } else {
      res.writeHead(500);
      res.end("down");
    }
  });
  await new Promise<void>((r) => feed.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(feed.address() as { port: number }).port}`;
  try {
    for (const [path, expected] of [["ok", /Это последняя версия/], ["broken", /Не получилось проверить обновления/]] as const) {
      app = await electron.launch({ executablePath: exe, env: { ...process.env, DRIMVOX_USER_DATA: userData, DRIMVOX_TEST_UPDATE_URL: `${base}/${path}` } });
      const page = await app.firstWindow();
      await expect(page.getByRole("button", { name: "Ключи и модели" }).first()).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: "Настройки" }).click();
      const section = page.getByRole("region", { name: "Обновления" });
      await section.getByRole("button", { name: "Проверить сейчас" }).click();
      await expect(section).toContainText(expected, { timeout: 15_000 });
      if (path === "broken") await expect(section).toContainText("logs/updates.log");
      await app.close();
      app = undefined;
    }
  } finally {
    await new Promise((r) => feed.close(r));
  }
});
