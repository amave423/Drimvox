import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeProvider, type FakeProvider } from "../../../packages/core/test/fake-provider";

const mainJs = fileURLToPath(new URL("../dist/main.cjs", import.meta.url));
const fakeCli = fileURLToPath(new URL("../../../packages/core/test/fake-cli.mjs", import.meta.url));
const CATALOG = [
  { id: "anthropic/claude-opus-5.5", name: "Anthropic: Claude Opus 5.5", created: 200 },
  { id: "anthropic/claude-fable-5.1", name: "Anthropic: Claude Fable 5.1", created: 100 },
];

let userData: string;
let cliDir: string;
let app: ElectronApplication | undefined;
let catalog: FakeProvider | undefined;

test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), "artel-e2e-"));
  cliDir = mkdtempSync(join(tmpdir(), "artel-e2e-cli-"));
});

test.afterEach(async () => {
  await app?.close();
  await catalog?.close();
  app = undefined;
  catalog = undefined;
  rmSync(userData, { recursive: true, force: true });
  rmSync(cliDir, { recursive: true, force: true });
});

async function launch(): Promise<Page> {
  catalog = await startFakeProvider({ models: CATALOG, authorized: () => true });
  const commands = {
    "claude-code": [process.execPath, fakeCli, "claude"],
    codex: [join(cliDir, "no-such-codex.exe")],
  };
  app = await electron.launch({
    args: [mainJs],
    env: {
      ...process.env,
      ARTEL_USER_DATA: userData,
      ARTEL_TEST_CLI: JSON.stringify(commands),
      ARTEL_TEST_OPENROUTER_URL: catalog.baseUrl,
      FAKE_CLI_DIR: cliDir,
    },
  });
  const page = await app.firstWindow();
  await expect(page.getByText("Ядро запущено")).toBeVisible();
  await page.getByRole("button", { name: "Ключи и модели" }).click();
  return page;
}

test("connects Claude Code without a key, names its models and chats through it", async () => {
  writeFileSync(join(cliDir, "script.json"), JSON.stringify([{ text: "Привет из Claude Code", session: "s1", initModel: "claude-fable-5-1" }]));
  const page = await launch();
  // Subscriptions have their own place, apart from the keys.
  const subscriptions = page.getByRole("region", { name: "По подписке" });
  await expect(page.getByRole("radiogroup", { name: "Подключить провайдера" }).getByRole("radio", { name: /Claude Code/ })).toHaveCount(0);
  await subscriptions.getByRole("radio", { name: /Claude Code/ }).click();
  await expect(page.getByText("npm install -g @anthropic-ai/claude-code")).toBeVisible();
  await expect(page.getByLabel(/Ключ API/)).toHaveCount(0);
  await page.getByRole("button", { name: "Подключить", exact: true }).click();
  await expect(subscriptions.getByText("Моделей: 3")).toBeVisible();
  await expect(page.getByText("По подписке: Artel считает токены, но не деньги")).toBeVisible();
  await expect(page.getByRole("button", { name: "Заменить ключ" })).toHaveCount(0);

  await page.getByRole("button", { name: "+ Новый чат" }).click();
  await page.getByRole("button", { name: "Выбери модель" }).click();
  await expect(page.getByRole("option", { name: /Claude Fable 5\.1/ })).toBeVisible();
  await page.getByRole("option", { name: /По умолчанию.*модель, выбранная в самой программе/ }).click();
  await expect(page.getByRole("button", { name: /Claude Code \/ По умолчанию/ })).toBeVisible();
  await expect(page.getByText(/Оплачивается твоей подпиской/)).toBeVisible();
  const box = page.getByRole("textbox", { name: /Сообщение/ });
  await box.fill("Привет");
  await box.press("Enter");
  await expect(page.getByText("Привет из Claude Code")).toBeVisible();
  await expect(page.getByText(/Токены: 120 → 30/)).toBeVisible();

  // Now Artel knows what "default" turned out to be.
  await page.getByRole("button", { name: /Claude Code \/ По умолчанию/ }).click();
  await expect(page.getByRole("option", { name: /По умолчанию.*сейчас это Claude Fable 5\.1/ })).toBeVisible();
  await page.getByRole("option", { name: /Claude Opus 5\.5/ }).click();
  await expect(page.getByRole("button", { name: /Claude Code \/ claude-opus-5-5/ })).toBeVisible();
});

test("says how to install a CLI that is missing", async () => {
  const page = await launch();
  await page.getByRole("radio", { name: /Codex/ }).click();
  await page.getByRole("button", { name: "Подключить", exact: true }).click();
  await expect(page.getByText("Программа не установлена или не найдена. Установи её командой ниже и проверь снова.")).toBeVisible();
  await expect(page.locator(".error-note-detail", { hasText: "npm install -g @openai/codex" })).toBeVisible();
});
