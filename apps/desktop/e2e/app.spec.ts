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
  // The start page shows someone new how to connect a model; the explanations are on the guide's page.
  await expect(page.locator(".home-center").getByRole("button", { name: "Подключить нейросеть" })).toBeVisible();
  await page.getByRole("button", { name: "Инструкция" }).click();
  await expect(page.getByRole("heading", { name: "Как пользоваться Drimvox", level: 1 })).toBeVisible();
  // Someone new sees three first steps, the first with its ways and buttons.
  const steps = page.getByRole("region", { name: "Первые шаги" });
  await expect(steps).toContainText("Подключи нейросеть");
  await expect(steps).toContainText("По подписке.");
  await expect(steps.getByRole("button", { name: "Подключить нейросеть" })).toBeVisible();
  // The first page explains how to use the app, part by part.
  for (const part of ["Модели", "Чат", "Проект", "Разрешения и расходы"]) await expect(page.getByRole("region", { name: part })).toBeVisible();
  await expect(page.getByText(/«Папка» подключает папку/)).toBeVisible();
  // The names in the guide open what they name.
  await page.getByRole("region", { name: "Модели" }).getByRole("link", { name: "Локальные модели" }).click();
  await expect(page.getByRole("heading", { name: "Локальные модели", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Drimvox" }).first().click();
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
  expect(exposed).toEqual({ require: "undefined", process: "undefined", bridge: ["checkUpdates", "focusAssist", "getToken", "installUpdate", "notify", "onOpenTask", "onUpdate", "openSkillsFolder", "pickFolder", "savePdf", "setTitleBar", "testNotify", "updateState"] });
});

test("the catalog switches a ready skill on and off, and shows a server's details with the token it needs", async () => {
  app = await launch();
  const page = await app.firstWindow();
  await expect(page.getByRole("button", { name: "Ключи и модели" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Настройки" }).first().click();
  // Skills and servers each on their own tab.
  await page.getByRole("tab", { name: "Скиллы" }).click();
  const cards = page.locator(".catalog-card");
  await expect(cards).toHaveCount(16);
  for (const name of ["Дизайн интерфейсов", "Сначала тест", "Документы Word"]) await expect(page.locator(".catalog-grid")).toContainText(name);
  // A filter by what the card is about.
  await page.getByRole("button", { name: "Документы", exact: true }).click();
  await expect(cards).toHaveCount(4);

  const word = cards.filter({ hasText: "Документы Word" });
  await word.getByRole("switch").click({ force: true });
  await expect(word.getByRole("switch")).toBeChecked();
  // A ready skill lives on its card, not in the list of skills added by hand; the card can delete it at once.
  await expect(page.locator(".skill-list li", { hasText: "docx" })).toHaveCount(0);
  await word.getByRole("switch").click({ force: true });
  await expect(word.getByRole("switch")).not.toBeChecked();
  await expect(page.getByText("Общих скиллов пока нет.")).toBeVisible();
  await word.getByRole("switch").click({ force: true });
  await expect(word.getByRole("switch")).toBeChecked();
  await word.getByRole("button", { name: "Удалить «Документы Word»" }).click();
  await expect(word.getByRole("switch")).not.toBeChecked();
  await expect(word.getByRole("button", { name: /^Удалить/ })).toHaveCount(0);

  // The details show what using it looks like.
  await page.getByRole("tab", { name: "Серверы MCP" }).click();
  await expect(cards).toHaveCount(13);
  for (const name of ["Playwright", "Chrome DevTools", "Context7", "GitHub", "Figma"]) await expect(page.locator(".catalog-grid")).toContainText(name);
  await cards.first().getByRole("button", { name: "Подробнее" }).click();
  const playwright = page.getByRole("dialog", { name: "Playwright" });
  await expect(playwright.getByRole("figure", { name: "Как это выглядит" })).toContainText("проверь, что форма входа работает");
  await expect(playwright).toContainText("Microsoft · лицензия Apache-2.0");
  await page.keyboard.press("Escape");

  // GitHub needs a token: switching it on asks for one in its window; Escape closes the window, nothing is added.
  await cards.filter({ has: page.locator("strong", { hasText: /^GitHub$/ }) }).locator("label.toggle").click();
  const dialog = page.getByRole("dialog", { name: "GitHub" });
  await expect(dialog).toContainText("api.githubcopilot.com/mcp");
  await expect(dialog.getByLabel("Ключ GitHub")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(cards.filter({ has: page.locator("strong", { hasText: /^GitHub$/ }) }).getByRole("switch")).not.toBeChecked();
});

// Seen: closing the window stopped the agents and the started site; Drimvox now stays in the tray until "Quit".
test("closing the window keeps Drimvox working in the tray, and it shows the window again", async () => {
  app = await launch();
  const page = await app.firstWindow();
  await expect(page.getByRole("button", { name: "Ключи и модели" }).first()).toBeVisible();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()))).toEqual([false]);
  // The core still answers: the app did not quit.
  expect(await page.evaluate(async () => (await fetch("/api/health")).ok)).toBe(true);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.show());
  await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(true);
});

// Asked for: the sections at the bottom of the sidebar fold under one button.
test("folds the sidebar's sections under one button, and remembers it", async () => {
  app = await launch();
  const page = await app.firstWindow();
  const sections = page.getByRole("button", { name: "Разделы" });
  await expect(page.getByRole("navigation", { name: "Разделы" }).getByRole("button", { name: "Галерея" })).toBeVisible();
  await sections.click();
  await expect(sections).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("navigation", { name: "Разделы" }).getByRole("button", { name: "Галерея" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Разделы" })).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Разделы" }).click();
  await expect(page.getByRole("navigation", { name: "Разделы" }).getByRole("button", { name: "Настройки" })).toBeVisible();
});

// Asked for: reading answers aloud with Piper's voices instead of the system's.
test("offers Piper's voices on the audio tab and in the settings", async () => {
  app = await launch();
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Локальные модели" }).first().click();
  await page.getByRole("tab", { name: "Аудио" }).click();
  await expect(page.getByRole("heading", { name: "Озвучка ответов" })).toBeVisible();
  await expect(page.locator(".local-card", { hasText: "Ирина" })).toContainText("русский, женский");
  await page.getByRole("button", { name: "Настройки" }).first().click();
  await page.getByRole("tab", { name: "Модели и деньги" }).click();
  await expect(page.getByRole("region", { name: "Голос для чтения ответов" })).toContainText("Скачать голоса Piper");
});

// Seen again and again: a model list fixed to open downwards ran off the window near the bottom of a page.
test("a model list near the bottom of the window opens upwards and stays inside it", async () => {
  app = await launch();
  const page = await app.firstWindow();
  await expect(page.getByRole("button", { name: "Ключи и модели" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Настройки" }).first().click();
  await page.getByRole("tab", { name: "Модели и деньги" }).click();
  const setting = page.getByRole("region", { name: "Проверка по скриншотам" });
  const button = setting.getByRole("button", { name: "Выбери модель" });
  await button.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await button.click();
  const panel = setting.locator(".picker-panel");
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  const height = await page.evaluate(() => window.innerHeight);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(height);
});

test("creates and deletes a shared skill in the settings", async () => {
  app = await launch();
  const page = await app.firstWindow();
  await expect(page.getByRole("button", { name: "Ключи и модели" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Настройки" }).first().click();
  await page.getByRole("tab", { name: "Скиллы" }).click();

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
