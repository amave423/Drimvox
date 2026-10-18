import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeProvider, type FakeProvider, type FakeChunk } from "../../../packages/core/test/fake-provider";

const mainJs = fileURLToPath(new URL("../dist/main.cjs", import.meta.url));
const KEY = "good-key";
const models = [{ id: "fake-model", name: "Fake Model", supported_parameters: ["tools"], architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } }];

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

async function launch(chunks: FakeChunk[], delayMs = 0): Promise<Page> {
  fake = await startFakeProvider({ key: KEY, models, chunks, delayMs });
  app = await electron.launch({ args: [mainJs], env: { ...process.env, ARTEL_USER_DATA: userData } });
  const page = await app.firstWindow();
  await expect(page.getByText("Ядро запущено")).toBeVisible();
  await page.getByRole("button", { name: "Ключи и модели" }).click();
  await page.getByRole("radio", { name: /OpenAI-совместимый/ }).click();
  await page.getByLabel("Название").fill("Тестовый");
  await page.getByLabel("Адрес API").fill(fake.baseUrl);
  await page.getByLabel("Ключ API, если нужен").fill(KEY);
  await page.getByRole("button", { name: "Подключить", exact: true }).click();
  await expect(page.getByText("Моделей: 1")).toBeVisible();
  return page;
}

async function ask(page: Page, text: string) {
  await page.getByRole("button", { name: "+ Новый чат" }).click();
  const picker = page.getByRole("button", { name: "Выбери модель" });
  if (await picker.isVisible()) {
    await picker.click();
    await page.getByRole("option", { name: /Fake Model/ }).click();
  }
  const box = page.getByRole("textbox", { name: /Сообщение/ });
  await box.fill(text);
  await box.press("Enter");
}

/** Chats made through the API, as many as a long-used app has. */
async function manyChats(page: Page, n: number) {
  await page.evaluate(async (count) => {
    const token = await (window as unknown as { artel: { getToken(): Promise<string> } }).artel.getToken();
    const h = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const providers = (await (await fetch("/api/providers", { headers: h })).json()) as { id: string }[];
    for (let i = 0; i < count; i++) {
      const chat = (await (await fetch("/api/chats", { method: "POST", headers: h, body: JSON.stringify({ providerId: providers[0]!.id, model: "fake-model" }) })).json()) as { id: string };
      await fetch(`/api/chats/${chat.id}`, { method: "PATCH", headers: h, body: JSON.stringify({ title: `Чат номер ${i}` }) });
    }
  }, n);
  await page.reload();
}

// Seen: with many chats the system block and the menu ran over the chat list.
test("many chats scroll inside their own list, without running over the rest of the sidebar", async () => {
  const page = await launch([{ text: "Привет" }]);
  await manyChats(page, 40);
  await expect(page.getByText("Чат номер 39")).toBeVisible();
  const box = async (selector: string) => (await page.locator(selector).boundingBox())!;
  const chats = await box(".side-chats-group");
  const system = await box(".side-system");
  const nav = await box(".side-nav");
  expect(chats.y + chats.height).toBeLessThanOrEqual(system.y + 1);
  expect(system.y + system.height).toBeLessThanOrEqual(nav.y + 1);
});

test("renames a chat, deletes one from the list, and deletes several at once", async () => {
  const page = await launch([{ text: "Привет" }]);
  await manyChats(page, 4);
  const row = (name: string) => page.locator(".side-chat", { hasText: name });

  await row("Чат номер 0").hover();
  await page.getByRole("button", { name: "Переименовать «Чат номер 0»" }).click();
  await page.getByLabel("Название чата").fill("Про здание");
  await page.getByLabel("Название чата").press("Enter");
  await expect(row("Про здание")).toBeVisible();

  await row("Чат номер 1").hover();
  await page.getByRole("button", { name: "Удалить «Чат номер 1»" }).click();
  await row("Чат номер 1").getByRole("button", { name: "Удалить", exact: true }).click();
  await expect(page.getByText("Чат номер 1")).toHaveCount(0);

  await page.getByRole("button", { name: "Выбрать" }).click();
  await page.getByRole("checkbox", { name: "Чат номер 2" }).check();
  await page.getByRole("checkbox", { name: "Чат номер 3" }).check();
  await page.getByRole("button", { name: "Удалить (2)" }).click();
  await expect(page.getByText("Чат номер 2")).toHaveCount(0);
  await expect(page.getByText("Чат номер 3")).toHaveCount(0);
  await expect(row("Про здание")).toBeVisible();
});

// Seen: going elsewhere while the model answered lost the chat until the answer was done; the bottom of a growing
// answer could not be reached, the last lines stayed under the composer.
test("a chat is in the list while the model answers, and the answer can be followed to its very end", async () => {
  const para = "Длинный абзац ответа о здании, его истории и архитектуре. ".repeat(6);
  const page = await launch(
    Array.from({ length: 40 }, () => ({ text: `${para}\n\n` })),
    100,
  );
  await ask(page, "Расскажи про здание");
  await expect(page.locator(".side-chat", { hasText: "Расскажи про здание" })).toBeVisible({ timeout: 3_000 });

  await page.waitForTimeout(2500);
  const gap = await page.evaluate(() => {
    const desk = document.querySelector(".desk") as HTMLElement;
    return desk.scrollHeight - desk.scrollTop - desk.clientHeight;
  });
  expect(gap).toBeLessThan(80);
  // The last line of the answer is above the composer, not under it.
  const lastLine = await page.locator(".msg-assistant .md > *").last().boundingBox();
  const composer = await page.locator(".composer").boundingBox();
  expect(lastLine!.y + lastLine!.height).toBeLessThanOrEqual(composer!.y + 2);
});

test("a code block has a copy button", async () => {
  const page = await launch([{ text: "Вот код:\n\n```js\nconst total = 1;\n```" }]);
  await ask(page, "Покажи код");
  const block = page.locator(".code-block");
  await expect(block).toContainText("js");
  await block.getByRole("button", { name: "Копировать" }).click();
  await expect(block.getByRole("button", { name: "Скопировано" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("const total = 1;");
});

// Seen: a 4.5 MB photo came back as "too heavy" from the provider.
test("a big photo is made smaller before it goes", async () => {
  const page = await launch([{ text: "Вижу фото." }]);
  await page.getByRole("button", { name: "+ Новый чат" }).click();
  await page.getByRole("button", { name: "Выбери модель" }).click();
  await page.getByRole("option", { name: /Fake Model/ }).click();
  // A 4000×3000 picture of noise: about 5 MB as PNG.
  const png = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 4000;
    canvas.height = 3000;
    const ctx = canvas.getContext("2d")!;
    const data = ctx.createImageData(4000, 3000);
    for (let i = 0; i < data.data.length; i++) data.data[i] = (i * 7919) % 251;
    ctx.putImageData(data, 0, 0);
    const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), "image/png"));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await page.locator('.composer input[type="file"]').setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: Buffer.from(png) });
  await expect(page.locator(".attachments.is-pending")).toContainText("photo.webp");
  const size = await page.locator(".attachments.is-pending .attachment .mono").first().textContent();
  expect(size).toMatch(/KB|1\.\d MB/);
});

// Seen live: left to itself, a model thought for minutes and wrote nothing; the user can now say how much it thinks.
test("the thinking switch goes with the question, and an answer of thoughts only says so", async () => {
  const page = await launch([{ reasoning: "Думаю…" }]);
  await page.getByRole("button", { name: "+ Новый чат" }).click();
  await page.getByRole("button", { name: "Выбери модель" }).click();
  await page.getByRole("option", { name: /Fake Model/ }).click();
  await page.getByRole("button", { name: "Мышление: авто" }).click();
  await page.getByRole("option", { name: /без/ }).click();
  const box = page.getByRole("textbox", { name: /Сообщение/ });
  await box.fill("Что это за игра?");
  await box.press("Enter");
  await expect(page.getByText(/Модель долго думала, но так и не ответила/)).toBeVisible();
  const body = fake!.requests.find((r) => r.path === "/v1/chat/completions")!.body;
  expect(body.reasoning).toEqual({ enabled: false });
});
