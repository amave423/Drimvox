import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openSection, paramsButton } from "./sections";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

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
  await openSection(page, "Инструкция");
  await expect(page.getByRole("heading", { name: "Как пользоваться Drimvox", level: 1 })).toBeVisible();
  // Someone new sees three first steps, the first with its ways and buttons.
  const steps = page.getByRole("region", { name: "Первые шаги" });
  await expect(steps).toContainText("Подключи нейросеть");
  await expect(steps).toContainText("По подписке.");
  await expect(steps.getByRole("button", { name: "Подключить нейросеть" })).toBeVisible();
  // The guide goes from what Drimvox is to the questions people ask, with contents that lead to each part.
  const parts = ["Что такое Drimvox", "Шаг 1. Подключите нейросеть", "Шаг 2. Два режима и параметры", "Чат", "Проект: агент делает всё сам", "Деньги и безопасность", "Уведомления, навыки и серверы", "Частые вопросы"];
  for (const part of parts) await expect(page.getByRole("region", { name: part })).toHaveCount(1);
  const contents = page.getByRole("navigation", { name: "Содержание" });
  await contents.getByRole("button", { name: "Частые вопросы" }).click();
  await expect(page.getByRole("region", { name: "Частые вопросы" })).toBeInViewport();
  // A project's points are steps, in order.
  await expect(page.getByRole("region", { name: "Проект: агент делает всё сам" }).locator("ol > li")).toHaveCount(8);
  // The names in the guide open what they name.
  await page.getByRole("region", { name: "Шаг 1. Подключите нейросеть" }).getByRole("link", { name: "Локальные модели" }).click();
  await expect(page.getByRole("heading", { name: "Локальные модели", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Drimvox" }).first().click();
  await expect(paramsButton(page)).toBeVisible();
  // The bottom bar names the version the app was built as.
  await expect(page.getByText(/^Drimvox \d+\.\d+\.\d+$/)).toBeVisible();

  await openSection(page, "Настройки");
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
  await openSection(page, "Настройки");
  await expect(page.getByText(/Фокусировка внимания/)).toBeVisible();
});

test("the core refuses callers that do not have the token", async () => {
  app = await launch();
  const page = await app.firstWindow();
  await expect(paramsButton(page)).toBeVisible();

  const origin = new URL(page.url()).origin;
  const res = await fetch(`${origin}/api/settings`);
  expect(res.status).toBe(401);
});

test("the page has no access to Node", async () => {
  app = await launch();
  const page = await app.firstWindow();
  await expect(paramsButton(page)).toBeVisible();

  const exposed = await page.evaluate(() => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    bridge: Object.keys((window as unknown as { drimvox?: object }).drimvox ?? {}).sort(),
  }));
  expect(exposed).toEqual({ require: "undefined", process: "undefined", bridge: ["checkUpdates", "focusAssist", "getToken", "installUpdate", "notify", "onOpenChat", "onOpenProject", "onOpenTask", "onUpdate", "openSkillsFolder", "pickFolder", "placeBrowser", "savePdf", "setTitleBar", "testNotify", "updateState"] });
});

test("the catalog switches a ready skill on and off, and shows a server's details with the token it needs", async () => {
  app = await launch();
  const page = await app.firstWindow();
  await expect(paramsButton(page)).toBeVisible();
  await openSection(page, "Настройки");
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
  // Before a server is switched on, what it may do without asking is said and chosen (asked for): the browser works
  // in its own window without the user's sign-ins, so it asks nothing.
  await expect(playwright.getByRole("radio", { name: "Без вопросов" })).toHaveAttribute("aria-checked", "true");
  await expect(playwright).toContainText("будет делать всё без вопросов");
  await page.keyboard.press("Escape");

  // GitHub needs a token: switching it on asks for one in its window; Escape closes the window, nothing is added.
  await cards.filter({ has: page.locator("strong", { hasText: /^GitHub$/ }) }).locator("label.toggle").click();
  const dialog = page.getByRole("dialog", { name: "GitHub" });
  await expect(dialog).toContainText("api.githubcopilot.com/mcp");
  await expect(dialog.getByLabel("Ключ GitHub")).toBeVisible();
  // A server that can change things asks before it does.
  await expect(dialog.getByRole("radio", { name: "Только об изменениях" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(cards.filter({ has: page.locator("strong", { hasText: /^GitHub$/ }) }).getByRole("switch")).not.toBeChecked();
});

// Seen: closing the window stopped the agents and the started site; Drimvox now stays in the tray until "Quit".
test("closing the window keeps Drimvox working in the tray, and it shows the window again", async () => {
  app = await launch();
  const page = await app.firstWindow();
  await expect(paramsButton(page)).toBeVisible();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()))).toEqual([false]);
  // The core still answers: the app did not quit.
  expect(await page.evaluate(async () => (await fetch("/api/health")).ok)).toBe(true);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.show());
  await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(true);
});

// Asked for: one "Parameters" button; the parameters a page of their own, sections on the right, a way back, the mode kept.
test("opens the parameters as a page of their own and goes back, keeping the mode", async () => {
  app = await launch();
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Проекты", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Над чем поработаем?" })).toBeVisible();
  await paramsButton(page).click();
  const nav = page.getByRole("navigation", { name: "Разделы параметров" });
  for (const name of ["Настройки", "Ключи и модели", "Локальные модели", "Галерея", "Инструкция"]) await expect(nav.getByRole("button", { name })).toBeVisible();
  // The page covers the window: no sidebar; the mode stays the one it was opened from.
  await expect(page.locator(".side")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Проекты", exact: true })).toHaveAttribute("aria-pressed", "true");
  await nav.getByRole("button", { name: "Галерея" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Галерея" })).toBeVisible();
  await page.getByRole("button", { name: "Назад" }).click();
  await expect(page.getByRole("heading", { name: "Над чем поработаем?" })).toBeVisible();
  await expect(page.locator(".side")).toBeVisible();
});

// Asked for: notifications of Drimvox's own, like Telegram's, with a sound of its own.
test("shows its own notification window with the chosen sound, and it goes away when closed", async () => {
  app = await launch();
  const page = await app.firstWindow();
  await openSection(page, "Настройки");
  const sounds = page.getByRole("radiogroup", { name: "Звук уведомлений" });
  await sounds.getByRole("radio", { name: "Колокольчик" }).click();
  await expect(sounds.getByRole("radio", { name: "Колокольчик" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("slider", { name: "Громкость" })).toBeVisible();
  await page.getByRole("button", { name: "Проверить уведомление" }).click();
  // A window of its own, at the bottom right, never in the taskbar.
  const notice = await app.waitForEvent("window", (w) => w.url().endsWith("#notice"));
  const card = notice.locator(".notice-card");
  await expect(card).toContainText("Уведомления работают");
  const bounds = await app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith("#notice"))!;
    return { win: w.getBounds(), area: screen.getPrimaryDisplay().workArea, visible: w.isVisible(), focusable: w.isFocusable() };
  });
  expect(bounds.visible).toBe(true);
  expect(bounds.focusable).toBe(false);
  expect(bounds.win.x + bounds.win.width).toBeLessThanOrEqual(bounds.area.x + bounds.area.width);
  expect(bounds.win.y + bounds.win.height).toBeLessThanOrEqual(bounds.area.y + bounds.area.height);
  await card.hover();
  await notice.getByRole("button", { name: "Закрыть уведомление" }).click();
  await expect(card).toHaveCount(0);
  await expect
    .poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith("#notice"))!.isVisible()))
    .toBe(false);
  // The setting stays.
  await page.reload();
  await openSection(page, "Настройки");
  await expect(page.getByRole("radiogroup", { name: "Звук уведомлений" }).getByRole("radio", { name: "Колокольчик" })).toHaveAttribute("aria-checked", "true");
});

// Asked for: a browser exactly like Claude's: a real tab inside Drimvox's window, over the panel's page box, where a
// check is passed as in any browser.
test("opens the agent's browser as a real tab in the panel, where a page is clicked and typed into", async () => {
  test.setTimeout(60_000);
  const site = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (req.url === "/b") return res.end("<title>Вторая</title><h1>Вторая</h1>");
    res.end(`<title>Проверка</title><body style="margin:0"><button style="width:400px;height:250px" onclick="document.title='Нажато'">Я не робот</button><input oninput="document.title='Введено: '+this.value"></body>`);
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  const port = (site.address() as AddressInfo).port;
  /** Where the window holds the agent's tab, by its address. */
  const tabBounds = () =>
    app!.evaluate(({ BrowserWindow }, port) => {
      const views = BrowserWindow.getAllWindows()[0]!.contentView.children as unknown as { webContents?: { getURL(): string }; getBounds(): Electron.Rectangle }[];
      return views.find((v) => v.webContents?.getURL().includes(`:${port}/`))?.getBounds() ?? null;
    }, port);
  try {
    app = await launch();
    const page = await app.firstWindow();
    await expect(paramsButton(page)).toBeVisible();
    await page.getByRole("button", { name: "Браузер", exact: true }).click();
    const pane = page.getByRole("complementary", { name: "Браузер агента" });
    await expect(pane).toContainText("закрыт");
    await pane.getByRole("button", { name: "Открыть браузер" }).click();
    await pane.getByLabel("Адрес").fill(`http://127.0.0.1:${port}/`);
    await pane.getByLabel("Адрес").press("Enter");
    await expect(pane.getByRole("tab", { selected: true })).toHaveText("Проверка", { timeout: 20_000 });

    // The tab lies exactly over the panel's page box: the page fills the panel, nothing squeezed or empty.
    const box = (await pane.locator(".browser-view").boundingBox())!;
    await expect.poll(async () => JSON.stringify(await tabBounds())).toBe(JSON.stringify({ x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }));

    // The tab is a page of its own, clicked and typed into as any page (Cyrillic too).
    let tab: Page | undefined;
    await expect.poll(() => (tab = app!.windows().find((w) => w.url().includes(`:${port}/`))) !== undefined).toBe(true);
    await tab!.getByRole("button", { name: "Я не робот" }).click();
    await expect(pane.getByRole("tab", { selected: true })).toHaveText("Нажато", { timeout: 10_000 });
    await tab!.locator("input").pressSequentially("кедр");
    await expect(pane.getByRole("tab", { selected: true })).toHaveText("Введено: кедр", { timeout: 10_000 });
    await expect(page.locator(".topbar-browser-dot")).toBeVisible({ timeout: 10_000 });

    // Several tabs: a new one, then back to the first, and the second closed (asked for: a switch between them).
    const tabs = pane.getByRole("tablist", { name: "Вкладки" });
    await tabs.getByRole("button", { name: "Новая вкладка" }).click();
    await expect(tabs.getByRole("tab")).toHaveCount(2);
    await pane.getByLabel("Адрес").fill(`http://127.0.0.1:${port}/b`);
    await pane.getByLabel("Адрес").press("Enter");
    await expect(pane.getByRole("tab", { selected: true })).toHaveText("Вторая", { timeout: 10_000 });
    await tabs.getByRole("tab", { name: "Введено: кедр" }).click();
    await expect(pane.getByRole("tab", { selected: true })).toHaveText("Введено: кедр", { timeout: 10_000 });
    await tabs.getByRole("button", { name: "Закрыть вкладку «Вторая»" }).click();
    await expect(tabs.getByRole("tab")).toHaveCount(1);

    // The panel closed: the tab goes out of sight but stays, for the agent to work on.
    await pane.getByRole("button", { name: "Закрыть", exact: true }).click();
    await expect.poll(async () => (await tabBounds())?.x ?? 0).toBeLessThan(0);
  } finally {
    site.closeAllConnections();
    await new Promise((r) => site.close(r));
  }
});

// Asked for: reading answers aloud with Piper's voices instead of the system's.
test("offers Piper's voices on the audio tab and in the settings", async () => {
  app = await launch();
  const page = await app.firstWindow();
  await openSection(page, "Локальные модели");
  await page.getByRole("tab", { name: "Аудио" }).click();
  await expect(page.getByRole("heading", { name: "Озвучка ответов" })).toBeVisible();
  await expect(page.locator(".local-card", { hasText: "Ирина" })).toContainText("русский, женский");
  await openSection(page, "Настройки");
  await page.getByRole("tab", { name: "Модели и деньги" }).click();
  await expect(page.getByRole("region", { name: "Голос для чтения ответов" })).toContainText("Скачать голоса Piper");
});

// Seen again and again: a model list fixed to open downwards ran off the window near the bottom of a page.
test("a model list near the bottom of the window opens upwards and stays inside it", async () => {
  app = await launch();
  const page = await app.firstWindow();
  await expect(paramsButton(page)).toBeVisible();
  await openSection(page, "Настройки");
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
  await expect(paramsButton(page)).toBeVisible();
  await openSection(page, "Настройки");
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
