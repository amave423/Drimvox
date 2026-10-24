import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const mainJs = fileURLToPath(new URL("../dist/main.cjs", import.meta.url));

let userData: string;
let app: ElectronApplication | undefined;

test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), "drimvox-e2e-"));
});

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  rmSync(userData, { recursive: true, force: true });
});

function launch() {
  return electron.launch({ args: [mainJs], env: { ...process.env, DRIMVOX_USER_DATA: userData } });
}

test("opens with a working core and remembers theme and language", async () => {
  app = await launch();
  let page = await app.firstWindow();

  await expect(page.getByRole("heading", { name: "Добро пожаловать в Drimvox" })).toBeVisible();
  // Someone new sees three first steps, the first with its ways and buttons.
  const steps = page.getByRole("region", { name: "Первые шаги" });
  await expect(steps).toContainText("Подключи нейросеть");
  await expect(steps).toContainText("По подписке.");
  await expect(steps.getByRole("button", { name: "Подключить нейросеть" })).toBeVisible();
  // The first page explains how to use the app, part by part.
  for (const part of ["Модели", "Чат", "Проект", "Разрешения и расходы"]) await expect(page.getByRole("region", { name: part })).toBeVisible();
  await expect(page.getByText(/«Папка» подключает папку/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Ключи и модели" }).first()).toBeVisible();
  // The bottom bar names the version the app was built as.
  await expect(page.getByText(/^Drimvox \d+\.\d+\.\d+$/)).toBeVisible();

  await page.getByRole("button", { name: "Настройки" }).first().click();
  // Updating says where it stands; a build that is not installed does not check.
  await expect(page.getByRole("region", { name: "Обновления" })).toContainText("Обновления проверяет только установленный Drimvox.");
  await expect(page.getByRole("button", { name: "Проверить сейчас" })).toBeDisabled();
  await page.getByRole("radio", { name: "Тёмное" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByText("Сохранено")).toBeVisible();

  await page.getByRole("radio", { name: "English" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");

  await app.close();
  app = await launch();
  page = await app.firstWindow();

  await expect(page.getByRole("heading", { name: "Welcome to Drimvox" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

// Seen: notifications went straight to the action centre without a sound, all of them: Focus Assist was on ("alarms
// only"). The settings say so next to the notifications.
test("says when Windows hides notifications by Focus Assist", async () => {
  app = await electron.launch({ args: [mainJs], env: { ...process.env, DRIMVOX_USER_DATA: userData, DRIMVOX_TEST_FOCUS_ASSIST: "2" } });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Настройки" }).first().click();
  await expect(page.getByText(/Фокусировка внимания/)).toBeVisible();
});

test("the core refuses callers that do not have the token", async () => {
  app = await launch();
  const page = await app.firstWindow();
  await expect(page.getByRole("button", { name: "Ключи и модели" }).first()).toBeVisible();

  const origin = new URL(page.url()).origin;
  const res = await fetch(`${origin}/api/settings`);
  expect(res.status).toBe(401);
});

test("the page has no access to Node", async () => {
  app = await launch();
  const page = await app.firstWindow();
  await expect(page.getByRole("button", { name: "Ключи и модели" }).first()).toBeVisible();

  const exposed = await page.evaluate(() => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    bridge: Object.keys((window as unknown as { drimvox?: object }).drimvox ?? {}).sort(),
  }));
  expect(exposed).toEqual({ require: "undefined", process: "undefined", bridge: ["checkUpdates", "focusAssist", "getToken", "installUpdate", "notify", "onOpenTask", "onUpdate", "openSkillsFolder", "pickFolder", "setTitleBar", "testNotify", "updateState"] });
});

test("creates and deletes a shared skill in the settings", async () => {
  app = await launch();
  const page = await app.firstWindow();
  await expect(page.getByRole("button", { name: "Ключи и модели" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Настройки" }).first().click();

  await page.getByRole("button", { name: "Создать скилл" }).click();
  await page.getByLabel("Название").fill("Отчёты");
  await page.getByLabel("Когда он нужен").fill("Когда нужен отчёт для клиента");
  await page.getByLabel("Инструкция для агента").fill("Вывод первой строкой.");
  await page.getByRole("button", { name: "Сохранить скилл" }).click();

  const row = page.locator(".skill-list li", { hasText: "otchety" });
  await expect(row).toContainText("Когда нужен отчёт для клиента");
  await row.getByRole("button", { name: "Удалить" }).click();
  await row.getByRole("button", { name: "Точно удалить" }).click();
  await expect(page.getByText("Общих скиллов пока нет.")).toBeVisible();
});
