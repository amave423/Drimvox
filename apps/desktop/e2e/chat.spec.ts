import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
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
  userData = mkdtempSync(join(tmpdir(), "artel-e2e-"));
});

test.afterEach(async () => {
  await app?.close();
  await fake?.close();
  app = undefined;
  fake = undefined;
  rmSync(userData, { recursive: true, force: true });
});

async function launch(): Promise<Page> {
  app = await electron.launch({ args: [mainJs], env: { ...process.env, ARTEL_USER_DATA: userData } });
  const page = await app.firstWindow();
  await expect(page.getByText("Ядро запущено")).toBeVisible();
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
  await expect(page.getByRole("button", { name: /^Привет fake-model/ })).toBeVisible();
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
  expect((await tail.boundingBox())!.height).toBe(first);
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
