import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeProvider, type FakeProvider } from "../../../packages/core/test/fake-provider";

const mainJs = fileURLToPath(new URL("../dist/main.cjs", import.meta.url));
const KEY = "good-key";
const models = [{ id: "fake-model", name: "Fake Model", context_length: 32000, pricing: { prompt: "0.000001", completion: "0.000002" } }];

let userData: string;
let app: ElectronApplication | undefined;
let fake: FakeProvider | undefined;

test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), "drimvox-e2e-"));
});

test.afterEach(async () => {
  await app?.close();
  await fake?.close();
  app = undefined;
  fake = undefined;
  rmSync(userData, { recursive: true, force: true });
});

async function launch(env: Record<string, string> = {}): Promise<Page> {
  app = await electron.launch({ args: [mainJs], env: { ...process.env, DRIMVOX_USER_DATA: userData, DRIMVOX_TEST_USD_RUB: "80", ...env } });
  const page = await app.firstWindow();
  await expect(page.getByRole("button", { name: "Ключи и модели" }).first()).toBeVisible();
  return page;
}

async function connect(page: Page, apiKey = KEY) {
  await page.getByRole("button", { name: "Ключи и модели" }).click();
  await page.getByRole("radio", { name: /OpenAI-совместимый/ }).click();
  await page.getByLabel("Название").fill("Тестовый");
  await page.getByLabel("Адрес API").fill(fake!.baseUrl);
  await page.getByLabel("Ключ API, если нужен").fill(apiKey);
  await page.getByRole("button", { name: "Подключить", exact: true }).click();
}

async function startChat(page: Page) {
  await page.getByRole("button", { name: "+ Новый чат" }).click();
  await page.getByRole("button", { name: "Выбери модель" }).click();
  await page.getByRole("option", { name: /Fake Model/ }).click();
}

async function say(page: Page, text: string) {
  const box = page.getByRole("textbox", { name: /Сообщение/ });
  await box.fill(text);
  await box.press("Enter");
}

test("connects a provider, streams an answer and counts tokens and money", async () => {
  fake = await startFakeProvider({
    key: KEY,
    models,
    chunks: [{ reasoning: "Думаю" }, { text: "Привет! " }, { text: "Я тестовая модель." }],
    usage: { prompt_tokens: 12, completion_tokens: 3 },
  });
  const page = await launch();
  await connect(page);
  await expect(page.getByText("Моделей: 1")).toBeVisible();

  await startChat(page);
  await expect(page.getByText("За 1M токенов: 80 ₽ вход, 160 ₽ выход")).toBeVisible();
  await say(page, "Привет");

  await expect(page.getByText("Привет! Я тестовая модель.")).toBeVisible();
  await expect(page.getByText("Токены: 12 → 3, 0,001 ₽")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Привет$/ })).toBeVisible();
  await expect(page.getByText("Размышления модели")).toBeVisible();
  await expect(page.getByText(/Сегодня потрачено/)).toBeVisible();
});

test("free models come first in the list, under their own heading", async () => {
  fake = await startFakeProvider({
    key: KEY,
    models: [
      { id: "paid-model", name: "Paid Model", pricing: { prompt: "0.000001", completion: "0.000002" } },
      { id: "free-model:free", name: "Free Model", pricing: { prompt: "0", completion: "0" } },
    ],
  });
  const page = await launch();
  await connect(page);
  await page.getByRole("button", { name: "+ Новый чат" }).click();
  await page.getByRole("button", { name: "Выбери модель" }).click();
  const list = page.getByRole("listbox");
  await expect(list.getByText("Бесплатные · 1")).toBeVisible();
  // Raw text: the headings are drawn in capitals by the stylesheet.
  const order = await list.locator(".picker-group, .picker-name").allTextContents();
  expect(order.map((s) => s.replace(/(free|paid)-model(:free)?$/, ""))).toEqual(["Бесплатные · 1", "Free Model", "Платные", "Paid Model"]);
});

// Seen live: free models that a provider lists but no longer serves, or that answer "busy", failed every chat; and
// OpenRouter's free models past the first two hundred names were cut off the list.
test("asks the free models a word, hides those that are gone and marks the busy ones", async () => {
  const paid = Array.from({ length: 250 }, (_, i) => ({ id: `a-paid-${String(i).padStart(3, "0")}`, pricing: { prompt: "0.000001", completion: "0.000002" } }));
  fake = await startFakeProvider({
    key: KEY,
    models: [
      ...paid,
      { id: "z-works:free", name: "Z Works", pricing: { prompt: "0", completion: "0" } },
      { id: "z-gone:free", name: "Z Gone", pricing: { prompt: "0", completion: "0" } },
      { id: "z-busy:free", name: "Z Busy", pricing: { prompt: "0", completion: "0" } },
    ],
    respond: (body) =>
      body.model === "z-gone:free"
        ? { fail: { status: 404, message: "No endpoints found" } }
        : body.model === "z-busy:free"
          ? { fail: { status: 429, message: "Provider returned error" } }
          : { text: "hi" },
  });
  const page = await launch();
  await connect(page);
  await page.getByRole("button", { name: "+ Новый чат" }).click();
  await page.getByRole("button", { name: "Выбери модель" }).click();
  const list = page.getByRole("listbox");
  await expect(list.getByText("Бесплатные · 2")).toBeVisible();
  await expect(list.getByRole("option", { name: /Z Works/ })).toBeVisible();
  await expect(list.getByRole("option", { name: /Z Busy/ })).toContainText("перегружена");
  await expect(list.getByRole("option", { name: /Z Gone/ })).toHaveCount(0);
  await expect(page.getByText("Скрыто 1: сейчас не отвечают")).toBeVisible();
});

test("thinks in a small window, then draws formulas, a chart and highlighted code", async () => {
  const answer =
    "Энергия: $E = mc^2$, а площадь \\(S = \\pi r^2\\).\n\n" +
    '```mermaid\npie title Доли\n  "Чай" : 60\n  "Кофе" : 40\n```\n\n' +
    "```js\nconst total = 1;\n```";
  fake = await startFakeProvider({
    key: KEY,
    models,
    chunks: [{ reasoning: "Сначала подумаю. ".repeat(30) }, { reasoning: "https://example.org/" + "очень-длинный-путь/".repeat(20) }, { text: answer }],
    delayMs: 500,
  });
  const page = await launch();
  await connect(page);
  await startChat(page);
  await say(page, "Покажи пример");

  // While thinking: the time and a window that does not grow with the thoughts.
  await expect(page.getByText(/Думает… \d+ с/)).toBeVisible();
  const tail = page.locator(".reasoning-tail");
  const first = (await tail.boundingBox())!.height;
  await page.waitForTimeout(600);
  expect((await tail.boundingBox())!.height).toBeCloseTo(first, 0);
  // A long address wraps instead of widening the page.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await expect(page.locator(".md .katex")).toHaveCount(2);
  await expect(page.locator(".diagram svg")).toBeVisible();
  await expect(page.locator(".diagram")).toContainText("Чай");
  await expect(page.locator(".md .hljs-keyword").first()).toHaveText("const");
  await expect(page.getByText(/Размышления/)).toBeVisible();
});

test("stops an answer halfway and keeps what was written", async () => {
  fake = await startFakeProvider({
    key: KEY,
    models,
    chunks: [{ text: "Первая часть." }, { text: " Вторая." }, { text: " Третья." }, { text: " Четвёртая." }],
    delayMs: 700,
  });
  const page = await launch();
  await connect(page);
  await startChat(page);
  await say(page, "Длинный ответ");

  await expect(page.getByText("Первая часть.")).toBeVisible();
  await page.getByRole("button", { name: "Стоп" }).click();
  await expect(page.getByText("Остановлено")).toBeVisible();
  await expect(page.getByText(/Четвёртая/)).toHaveCount(0);
});

test("explains a wrong key", async () => {
  fake = await startFakeProvider({ key: KEY, models });
  const page = await launch();
  await connect(page, "wrong-key");
  await expect(page.getByText("Ключ не подходит. Проверь его или замени.")).toBeVisible();
});

test("keeps keys and chats after a restart", async () => {
  fake = await startFakeProvider({ key: KEY, models, chunks: [{ text: "Ответ" }] });
  let page = await launch();
  await connect(page);
  await startChat(page);
  await say(page, "Первый");
  await expect(page.getByText("Ответ", { exact: true })).toBeVisible();
  await app!.close();

  page = await launch();
  await page.getByRole("button", { name: /^Первый/ }).click();
  await say(page, "Второй");
  await expect(page.getByText("Ответ", { exact: true })).toHaveCount(2);
  expect(fake.requests.at(-1)?.auth).toBe(`Bearer ${KEY}`);
});

// Seen live: a local model's page of HTML ran past the sheet, the sheet stayed 900 px on any screen, and a long model
// name squeezed the internet switch into two lines.
test("fits code to the sheet, widens the sheet with the window and keeps the composer bar one row", async () => {
  const long = "a-very-long-provider-model-name-that-goes-on-and-on-v2.5-instruct-preview-q4_K_M";
  const css = `.calculator { background: linear-gradient(135deg, rgba(30, 30, 60, 0.95), rgba(60, 20, 90, 0.95)); box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.1); }`;
  fake = await startFakeProvider({
    key: KEY,
    models: [{ id: long, name: "Long Model" }],
    chunks: [{ text: `Вот сайт:\n\n\`\`\`html\n<style>\n${css}\n${css}\n</style>\n\`\`\`\n\nГотово.` }],
  });
  const page = await launch();
  await connect(page);
  await page.getByRole("button", { name: "+ Новый чат" }).click();
  await page.getByRole("button", { name: "Выбери модель" }).click();
  await page.getByRole("option", { name: /Long Model/ }).click();
  await say(page, "Сделай калькулятор");
  await expect(page.getByText("Готово.")).toBeVisible();

  const resize = (width: number, height: number) =>
    app!.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setSize(w!, h!), [width, height]);
  const sheetWidth = async () => (await page.locator(".sheet.chat").boundingBox())!.width;

  await resize(1280, 860);
  await page.waitForTimeout(300);
  const narrow = await sheetWidth();
  // The code scrolls inside its box instead of running past the sheet.
  const fits = await page.evaluate(() => {
    const pre = document.querySelector(".md pre")!.getBoundingClientRect();
    const sheet = document.querySelector(".sheet.chat")!.getBoundingClientRect();
    return pre.right <= sheet.right + 1 && document.documentElement.scrollWidth <= window.innerWidth;
  });
  expect(fits).toBe(true);

  // The bar is one row: the paperclip, the model, the options and the send button stand on one line, one height,
  // the model's name cut short; the send button keeps to the right edge of the field.
  const bar = () =>
    page.evaluate(() => {
      const box = (e: Element) => e.getBoundingClientRect();
      const items = [...document.querySelectorAll(".composer-bar .attach-button, .composer-bar .picker-button, .composer-send")].map(box);
      const field = box(document.querySelector(".composer textarea")!);
      const send = box(document.querySelector(".composer-send")!);
      return {
        count: items.length,
        tops: items.map((r) => Math.round(r.top)),
        heights: items.map((r) => Math.round(r.height)),
        sendRight: Math.round(field.right - send.right),
        // Nothing of the tools runs onto the send button.
        gapToSend: Math.round(send.left - Math.max(...[...document.querySelectorAll(".composer-tools > *")].map((e) => box(e).right))),
        modelWidth: Math.round(box(document.querySelector(".composer-tools > .picker:not(.chat-options)") ?? document.body).width),
        model: !!document.querySelector(".composer-tools > .picker:not(.chat-options)"),
      };
    });
  const wide = await bar();
  expect(wide.count).toBe(4);
  expect(wide.model).toBe(true);
  expect(Math.max(...wide.tops) - Math.min(...wide.tops)).toBeLessThanOrEqual(1);
  expect(Math.max(...wide.heights) - Math.min(...wide.heights)).toBeLessThanOrEqual(1);
  expect(Math.abs(wide.sendRight)).toBeLessThanOrEqual(1);
  expect(wide.gapToSend).toBeGreaterThanOrEqual(8);
  expect(wide.modelWidth).toBeLessThanOrEqual(240);

  // The narrowest window still keeps the whole bar in one row.
  await resize(960, 860);
  await page.waitForTimeout(300);
  const least = await bar();
  expect(least.model).toBe(true);
  expect(Math.max(...least.tops) - Math.min(...least.tops)).toBeLessThanOrEqual(1);
  expect(Math.abs(least.sendRight)).toBeLessThanOrEqual(1);
  expect(least.gapToSend).toBeGreaterThanOrEqual(8);

  // Narrower than that (a phone in the server's browser): the model and the paperclip go into Options, the send
  // button stays where it was. The window cannot get that narrow, so the field is.
  await page.locator(".composer").evaluate((el) => ((el as HTMLElement).style.width = "420px"));
  await page.waitForTimeout(300);
  const tight = await bar();
  expect(tight.model).toBe(false);
  expect(Math.abs(tight.sendRight)).toBeLessThanOrEqual(1);
  expect(Math.max(...tight.tops) - Math.min(...tight.tops)).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: /^Параметры/ }).click();
  await expect(page.getByRole("dialog", { name: "Параметры" }).getByRole("button", { name: /Long Model|a-very-long/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator(".composer").evaluate((el) => ((el as HTMLElement).style.width = ""));

  await resize(2400, 1300);
  await page.waitForTimeout(300);
  expect(await sheetWidth()).toBeGreaterThan(narrow * 1.3);
});

// docs/specs/chat-folder.md: a chat with a folder works right in it, and one button undoes an answer.
test("works in a connected folder and undoes an answer", async () => {
  const folder = mkdtempSync(join(tmpdir(), "drimvox-e2e-folder-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: folder });
  writeFileSync(join(folder, "README.md"), "# Демо\n");
  fake = await startFakeProvider({
    key: KEY,
    models,
    script: [{ toolCalls: [{ name: "write_file", args: { path: "hello.txt", content: "привет\n" } }] }, { text: "Создал hello.txt." }],
  });
  const page = await launch({ DRIMVOX_TEST_PICK_FOLDER: folder });
  await connect(page);
  await startChat(page);
  await page.getByRole("button", { name: "Параметры", exact: true }).click();
  await page.getByRole("button", { name: "Папка" }).click();
  // A connected folder is never hidden: the options button names it.
  await expect(page.getByRole("button", { name: /^Параметры: Папка: drimvox-e2e-folder-/ })).toBeVisible();

  await say(page, "Создай hello.txt");
  await expect(page.getByText("Создал hello.txt.")).toBeVisible();
  // What it did stays under the answer, folded (seen: it vanished once the chat reloaded).
  await page.getByText("Действия: 1").click();
  await expect(page.getByText("Пишет hello.txt")).toBeVisible();
  expect(readFileSync(join(folder, "hello.txt"), "utf8")).toBe("привет\n");

  await page.getByRole("button", { name: "Откатить" }).click();
  await expect(page.getByRole("button", { name: "Откатить" })).toHaveCount(0);
  expect(existsSync(join(folder, "hello.txt"))).toBe(false);
  rmSync(folder, { recursive: true, force: true });
});

// docs/specs/chat-attachments.md: a file goes with the message, the model reads it, the chat shows it.
test("attaches a file: the model gets its content and the chat shows it under the question", async () => {
  fake = await startFakeProvider({ key: KEY, models, script: [{ text: "В заметках — купить молоко." }] });
  const page = await launch();
  await connect(page);
  await startChat(page);
  await page.locator('.composer input[type="file"]').setInputFiles({ name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# План\nкупить молоко\n") });
  await expect(page.locator(".attachments.is-pending")).toContainText("notes.md");
  await say(page, "Что в заметках?");
  await expect(page.getByText("В заметках — купить молоко.")).toBeVisible();
  await expect(page.locator(".msg-user .attachments")).toContainText("notes.md");
  const asked = JSON.stringify(fake.requests.filter((r) => r.path === "/v1/chat/completions").at(-1)!.body.messages);
  expect(asked).toContain("купить молоко");
});

test("keeps the model picker and chat actions within reach in a long chat", async () => {
  fake = await startFakeProvider({
    key: KEY,
    models: [...models, { id: "other-model", name: "Other Model" }],
    chunks: [{ text: "Длинный ответ. ".repeat(120) }],
  });
  const page = await launch();
  await connect(page);
  await startChat(page);
  for (const n of [1, 2, 3]) {
    await say(page, `Вопрос ${n}`);
    await expect(page.getByText(/^Токены:/)).toHaveCount(n);
  }

  const picker = page.getByRole("button", { name: /Тестовый \/ fake-model/ });
  await expect(picker).toBeInViewport();
  await expect(page.getByRole("button", { name: "Удалить чат" })).toBeInViewport();

  await picker.click();
  await page.getByRole("option", { name: /Other Model/ }).click();
  await expect(page.getByRole("button", { name: /Тестовый \/ other-model/ })).toBeInViewport();

  // Only the conversation scrolls, never the window (seen: hidden labels of the questions stretched it, a second
  // scrollbar appeared and the whole app could be scrolled out of sight).
  const page_ = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, window: innerHeight }));
  expect(page_.height).toBeLessThanOrEqual(page_.window);
});

test("an MCP server from the settings gives the chat a tool that asks first", async () => {
  fake = await startFakeProvider({
    key: KEY,
    models,
    script: [{ toolCalls: [{ name: "mcp_demo_echo", args: { text: "привет" } }] }, { text: "Сервер ответил: echo: привет" }],
  });
  const page = await launch();
  await connect(page);
  await expect(page.getByText("Моделей: 1")).toBeVisible();

  const server = fileURLToPath(new URL("../../../packages/core/test/mcp-server.mjs", import.meta.url));
  await page.getByRole("button", { name: "Настройки" }).first().click();
  await page.getByRole("button", { name: "Добавить сервер" }).click();
  await page.getByLabel("Название").fill("demo");
  await page.getByLabel("Команда", { exact: true }).fill(`node "${server}"`);
  await page.getByRole("button", { name: "Подключить" }).click();
  await expect(page.getByText(/Инструментов: 3/)).toBeVisible({ timeout: 20_000 });

  await startChat(page);
  await say(page, "Повтори привет через сервер");
  await expect(page.getByText("Инструмент MCP-сервера")).toBeVisible();
  await page.getByRole("button", { name: "Разрешать всегда" }).click();
  await expect(page.getByText("Сервер ответил: echo: привет")).toBeVisible();

  await page.getByRole("button", { name: "Настройки" }).first().click();
  await expect(page.getByText("Разрешены всегда:")).toBeVisible();
  await expect(page.getByRole("button", { name: "echo ×" })).toBeVisible();
});

// Like ChatGPT and Claude: leave a chat while it answers, see a spinner on it, come back and watch the answer go on;
// an answer that came while the chat was closed leaves a dot until it is opened.
test("an answer goes on live after coming back to the chat, with a spinner and then a dot in the list", async () => {
  fake = await startFakeProvider({
    key: KEY,
    models,
    chunks: [{ reasoning: "Думаю о кусках" }, ...Array.from({ length: 30 }, (_, i) => ({ text: `кусок${i} ` }))],
    delayMs: 120,
  });
  const page = await launch();
  await connect(page);
  await expect(page.getByText("Моделей: 1")).toBeVisible();
  await startChat(page);
  await say(page, "Длинно");
  await expect(page.getByText(/кусок1 /)).toBeVisible();

  // Away, in a new chat: the first one is still answering.
  await page.getByRole("button", { name: "+ Новый чат" }).click();
  const row = page.locator(".side-chat", { hasText: "Длинно" });
  await expect(row.getByRole("img", { name: "Модель отвечает" })).toBeVisible();

  // Back: the answer goes on before the eyes, word after word, not only "the model is answering".
  await row.getByRole("button", { name: /Длинно/ }).click();
  await expect(page.getByText(/кусок12 /)).toBeVisible();
  await expect(page.getByText(/кусок20 /)).toBeVisible();
  await expect(page.getByText(/кусок29/)).toBeVisible({ timeout: 15_000 });
  await expect(row.getByRole("img", { name: "Модель отвечает" })).toHaveCount(0);

  // Another answer while the chat is closed: a dot until it is opened.
  await say(page, "Ещё");
  await page.getByRole("button", { name: "+ Новый чат" }).click();
  await expect(row.getByRole("img", { name: "Новый ответ" })).toBeVisible({ timeout: 20_000 });
  await row.getByRole("button", { name: /Длинно/ }).click();
  await expect(row.getByRole("img", { name: "Новый ответ" })).toHaveCount(0);
});
