import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeProvider, type FakeProvider, type FakeChunk, type FakeTurn } from "../../../packages/core/test/fake-provider";

const mainJs = fileURLToPath(new URL("../dist/main.cjs", import.meta.url));
const KEY = "good-key";
const models = [{ id: "fake-model", name: "Fake Model", supported_parameters: ["tools"], architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } }];

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

async function launch(chunks: FakeChunk[], delayMs = 0, script?: FakeTurn[]): Promise<Page> {
  fake = await startFakeProvider({ key: KEY, models, chunks, delayMs, ...(script ? { script } : {}) });
  app = await electron.launch({ args: [mainJs], env: { ...process.env, DRIMVOX_USER_DATA: userData } });
  const page = await app.firstWindow();
  await expect(page.getByRole("button", { name: "Ключи и модели" }).first()).toBeVisible();
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
    const token = await (window as unknown as { drimvox: { getToken(): Promise<string> } }).drimvox.getToken();
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
  const nav = await box(".side-nav");
  expect(chats.y + chats.height).toBeLessThanOrEqual(nav.y + 1);
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

  await page.getByRole("button", { name: "Выбрать", exact: true }).click();
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
  // The view catches up with the growing answer within a frame or two; a busy machine may take a moment longer.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const desk = document.querySelector(".desk") as HTMLElement;
        return desk.scrollHeight - desk.scrollTop - desk.clientHeight;
      }),
    )
    .toBeLessThan(80);
  // The last line of the answer is above the composer, not under it.
  const lastLine = await page.locator(".msg-assistant .md > *").last().boundingBox();
  const composer = await page.locator(".composer").boundingBox();
  expect(lastLine!.y + lastLine!.height).toBeLessThanOrEqual(composer!.y + 2);
});

// Seen: the thinking, opened while the answer was still written, slid away to the bottom with the next words.
test("opened thinking stays in view while the answer goes on", async () => {
  const para = "Длинный абзац ответа о здании, его истории и архитектуре. ".repeat(6);
  const page = await launch([{ reasoning: "Сначала подумаю о здании. ".repeat(40) }, ...Array.from({ length: 60 }, () => ({ text: `${para}\n\n` }))], 150);
  await ask(page, "Расскажи про здание");
  // Opened as soon as the answer starts, with the view still following it at the bottom.
  const summary = page.locator(".reasoning summary");
  await expect(summary).toBeVisible({ timeout: 10_000 });
  await summary.click();
  const before = (await summary.boundingBox())!.y;
  await page.waitForTimeout(1500);
  // Still where it was opened: the view no longer runs after the answer.
  expect(Math.abs((await summary.boundingBox())!.y - before)).toBeLessThan(5);
  // Long thinking scrolls in its own window.
  const text = (await page.locator(".reasoning p").boundingBox())!;
  expect(text.height).toBeLessThanOrEqual(422);
});

// Seen: the answer came in jerks, a piece at a time. Now its letters come at the speed the model writes.
test("an answer appears letter by letter, not in pieces", async () => {
  const piece = "Плавный текст ответа. ".repeat(40);
  const page = await launch([{ text: piece }, { text: " Конец." }], 2500);
  await ask(page, "Скажи что-нибудь");
  const answer = page.locator(".msg-assistant .md");
  await expect(answer).toBeVisible({ timeout: 10_000 });
  // The piece came whole, but it is shown in part at first, then all of it well before the next one.
  const first = (await answer.innerText()).length;
  expect(first).toBeLessThan(piece.trim().length);
  await expect.poll(async () => (await answer.innerText()).length, { timeout: 1500 }).toBeGreaterThanOrEqual(piece.trim().length);
});

// Seen: back in a chat whose answer was still being written, the page said a clip was being made and nothing stopped it.
test("an answer still being written shows how far it got after coming back, and stops from there", async () => {
  const page = await launch(Array.from({ length: 80 }, (_, i) => ({ text: `часть ${i} ` })), 150);
  await ask(page, "Пиши долго");
  await expect(page.locator(".msg-assistant .md")).toContainText("часть 0", { timeout: 10_000 });
  await page.getByRole("button", { name: "Настройки" }).first().click();
  await page.locator(".side-chat", { hasText: "Пиши долго" }).click();
  // Under way: "answering" shows only until the window follows the answer live, then the words go on with a caret.
  await expect(page.getByRole("button", { name: "Стоп" })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(/Ролик/)).toHaveCount(0);
  await expect(page.locator(".msg-assistant .md")).toContainText("часть 0");
  const before = (await page.locator(".msg-assistant .md").textContent())?.length ?? 0;
  await expect.poll(async () => (await page.locator(".msg-assistant .md").textContent())?.length ?? 0, { timeout: 5_000 }).toBeGreaterThan(before);
  await page.getByRole("button", { name: "Стоп" }).click();
  await expect(page.getByText("Модель отвечает…")).toHaveCount(0, { timeout: 5_000 });
  await expect(page.getByRole("button", { name: "Отправить" })).toBeVisible();
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

// Asked for: edit one's own message, get a new answer, and switch between the versions.
test("an edited message gets a new answer, and the arrows switch back to the first version", async () => {
  const page = await launch([], 0, [{ text: "Ответ про кошек" }, { text: "Ответ про собак" }]);
  await ask(page, "Расскажи про кошек");
  await expect(page.locator(".msg-assistant").last()).toContainText("Ответ про кошек");
  const mine = page.locator(".msg-user").first();
  await mine.hover();
  await mine.getByRole("button", { name: "Изменить сообщение" }).click();
  await page.getByLabel("Новый текст сообщения").fill("Расскажи про собак");
  await page.locator(".msg-editing").getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(page.locator(".msg-assistant .md").last()).toHaveText("Ответ про собак");
  await expect(page.locator(".msg-user")).toHaveCount(1);
  await expect(page.locator(".msg-versions")).toContainText("2/2");
  await page.getByRole("button", { name: "Предыдущая версия" }).click();
  await expect(page.locator(".msg-user").first()).toContainText("Расскажи про кошек");
  await expect(page.locator(".msg-assistant .md").last()).toHaveText("Ответ про кошек");
  await expect(page.locator(".msg-versions")).toContainText("1/2");
});

// Seen: links in answers were hard to tell from the text; popular sites now carry their mark, drawn without the network.
test("links in an answer stand out, and a popular site's carries its mark", async () => {
  const page = await launch([{ text: "Код на [GitHub](https://github.com/amave423/Drimvox), пример на [сайте](https://example.com/)." }]);
  await ask(page, "Где код?");
  const github = page.getByRole("link", { name: "GitHub" });
  await expect(github).toHaveAttribute("href", "https://github.com/amave423/Drimvox");
  await expect(github.locator("svg.md-link-icon")).toHaveCount(1);
  await expect(page.getByRole("link", { name: "сайте" }).locator("svg")).toHaveCount(0);
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

  // The picture opens big before it goes, and again from the message after (seen: neither could be opened).
  await page.getByRole("button", { name: "Открыть photo.webp" }).click();
  await expect(page.getByRole("dialog", { name: "photo.webp" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("textbox", { name: /Сообщение/ }).press("Enter");
  await expect(page.getByText("Вижу фото.")).toBeVisible();
  await page.locator(".msg-user").getByRole("button", { name: "Открыть photo.webp" }).click();
  // Save and copy come on a right click (seen: the buttons under the picture were awkward), the cross closes it.
  await page.getByRole("dialog", { name: "photo.webp" }).getByRole("img", { name: "photo.webp" }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Сохранить изображение" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Копировать изображение" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.locator(".msg-user").getByRole("button", { name: "Открыть photo.webp" }).click();
  await page.getByRole("button", { name: "Закрыть" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

// Seen live: left to itself, a model thought for minutes and wrote nothing; the user can now say how much it thinks.
test("the thinking switch goes with the question, and an answer of thoughts only says so", async () => {
  const page = await launch([{ reasoning: "Думаю…" }]);
  await page.getByRole("button", { name: "+ Новый чат" }).click();
  await page.getByRole("button", { name: "Выбери модель" }).click();
  await page.getByRole("option", { name: /Fake Model/ }).click();
  // Internet, thinking and the folder wait behind one button; what differs from the usual shows on it.
  await page.getByRole("button", { name: "Параметры", exact: true }).click();
  await page.getByRole("button", { name: "Мышление: авто" }).click();
  await page.getByRole("option", { name: /без/ }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Параметры: Мышление: без" })).toBeVisible();
  const box = page.getByRole("textbox", { name: /Сообщение/ });
  await box.fill("Что это за игра?");
  await box.press("Enter");
  await expect(page.getByText(/Модель долго думала, но так и не ответила/)).toBeVisible();
  const body = fake!.requests.find((r) => r.path === "/v1/chat/completions")!.body;
  expect(body.reasoning).toEqual({ enabled: false });
});
