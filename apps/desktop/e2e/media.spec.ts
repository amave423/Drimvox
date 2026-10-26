import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeProvider, type FakeProvider, type FakeTurn } from "../../../packages/core/test/fake-provider";
import { newChat, openSection, paramsButton } from "./sections";

const mainJs = fileURLToPath(new URL("../dist/main.cjs", import.meta.url));
const KEY = "good-key";
// A real 1×1 PNG, so the window can show it.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

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
  rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function launch(script?: FakeTurn[]): Promise<Page> {
  fake = await startFakeProvider({
    key: KEY,
    models: [{ id: "chatty", name: "Chatty" }],
    ...(script ? { script } : {}),
    handle: (method, path) => {
      if (method === "GET" && path === "/v1/images/models") {
        return {
          json: {
            data: [
              { id: "img/cheap", name: "Cheap Painter", supported_parameters: { aspect_ratio: { type: "enum", values: ["1:1", "16:9"] } } },
              { id: "img/dear", name: "Dear Painter", supported_parameters: {} },
              { id: "img/ref", name: "Portrait Painter", supported_parameters: { input_references: { type: "range", min: 0, max: 4 } } },
            ],
          },
        };
      }
      if (method === "GET" && path === "/v1/images/models/img/cheap/endpoints") {
        return { json: { endpoints: [{ pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.04 }] }] } };
      }
      if (method === "GET" && path === "/v1/images/models/img/ref/endpoints") {
        return { json: { endpoints: [{ pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.04 }] }] } };
      }
      if (method === "GET" && path === "/v1/images/models/img/dear/endpoints") {
        return { json: { endpoints: [{ pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.25 }] }] } };
      }
      if (method === "GET" && path === "/v1/videos/models") return { json: { data: [] } };
      if (method === "POST" && path === "/v1/images") {
        return { json: { data: [{ b64_json: PNG.toString("base64"), media_type: "image/png" }], usage: { cost: 0.039 } } };
      }
      return undefined;
    },
  });
  app = await electron.launch({ args: [mainJs], env: { ...process.env, DRIMVOX_USER_DATA: userData, DRIMVOX_TEST_USD_RUB: "80" } });
  const page = await app.firstWindow();
  await expect(paramsButton(page)).toBeVisible();

  await openSection(page, "Ключи и модели");
  await page.getByRole("radio", { name: /OpenAI-совместимый/ }).click();
  await page.getByLabel("Адрес API").fill(fake.baseUrl);
  await page.getByLabel("Ключ API, если нужен").fill(KEY);
  await page.getByRole("button", { name: "Подключить", exact: true }).click();
  await expect(page.getByText("Моделей: 1")).toBeVisible();
  return page;
}

test("a picture in a chat: the price before, the picture after, the gallery", async () => {
  const page = await launch();
  await newChat(page);
  await page.getByRole("button", { name: "Выбери модель" }).click();
  await page.getByRole("tab", { name: "Картинки" }).click();
  await page.getByRole("option", { name: /Dear Painter/ }).click();
  // A dear picture names its price on the button.
  await expect(page.getByRole("button", { name: "Запустить за ≈ 20,00 ₽" })).toBeVisible();

  await page.getByRole("button", { name: /img\/dear/ }).click();
  await page.getByRole("tab", { name: "Картинки" }).click();
  // The list names what one picture costs (seen: no prices at all).
  await expect(page.getByRole("option", { name: /Cheap Painter.*≈ 3,20 ₽ за картинку/ })).toBeVisible();
  await page.getByRole("option", { name: /Cheap Painter/ }).click();
  await expect(page.getByText("≈ 3,20 ₽")).toBeVisible();
  // The settings of the picture are pills behind the options button, not bare selects under the box.
  await expect(page.locator("select")).toHaveCount(0);
  await page.locator(".composer").getByRole("button", { name: /^Параметры/ }).click();
  await page.getByRole("radiogroup", { name: "Формат" }).getByRole("radio", { name: "16:9" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Параметры: 16:9" })).toBeVisible();
  await page.getByLabel(/Опиши картинку/).fill("Лиса в шарфе");
  await page.getByRole("button", { name: "Создать" }).click();

  const picture = page.getByRole("img", { name: "Лиса в шарфе" });
  await expect(picture).toBeVisible();
  expect(await picture.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  await expect(page.getByText("3,12 ₽").first()).toBeVisible();
  const sent = fake!.requests.find((r) => r.path === "/v1/images")!.body;
  expect(sent).toMatchObject({ model: "img/cheap", prompt: "Лиса в шарфе", aspect_ratio: "16:9" });

  await openSection(page, "Галерея");
  await expect(page.getByRole("heading", { level: 1, name: "Галерея" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Лиса в шарфе" })).toBeVisible();
  await page.getByRole("button", { name: "Открыть чат" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Лиса в шарфе" })).toBeVisible();
});

// Asked for: a text model that knows the picture model, writes the prompt, looks at the picture and redoes it.
test("a director writes the prompt, looks at the picture and says what it made", async () => {
  const page = await launch([
    { toolCalls: [{ name: "make_picture", args: { prompt: "A red fox in a knitted scarf, autumn forest, soft light" } }] },
    { text: "Рыжая лиса в вязаном шарфе в осеннем лесу." },
    { text: "Готово: лиса в шарфе, с первой попытки." },
  ]);
  await newChat(page);
  await page.getByRole("button", { name: "Выбери модель" }).click();
  await page.getByRole("tab", { name: "Картинки" }).click();
  await page.getByRole("option", { name: /Cheap Painter/ }).click();
  await page.locator(".composer").getByRole("button", { name: /^Параметры/ }).click();
  const panel = page.getByRole("dialog", { name: "Параметры" });
  await panel.locator("label.toggle").click();
  await panel.getByRole("button", { name: "Выбери модель" }).click();
  await page.getByRole("option", { name: /Chatty/ }).click();
  await panel.getByRole("radiogroup", { name: "Попыток" }).getByRole("radio", { name: "1" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /Параметры: .*режиссёр · 1/ })).toBeVisible();
  await page.getByLabel(/Опиши картинку/).fill("Лиса в шарфе");
  await page.getByRole("button", { name: "Создать" }).click();

  await expect(page.locator(".msg-assistant").last()).toContainText("Готово: лиса в шарфе, с первой попытки.");
  await expect(page.locator(".msg-assistant").last().locator("img")).toHaveCount(1);
  expect(fake!.requests.find((r) => r.path === "/v1/images")!.body).toMatchObject({ model: "img/cheap", prompt: "A red fox in a knitted scarf, autumn forest, soft light" });
});

// docs/specs/media.md: a photo only for a model that takes one; the others say they do not.
test("a photo goes only to a model that takes one, and the others say so", async () => {
  const page = await launch();
  await newChat(page);
  await page.getByRole("button", { name: "Выбери модель" }).click();
  await page.getByRole("tab", { name: "Картинки" }).click();
  // The list marks what takes a photo.
  await expect(page.getByRole("option", { name: /по фото.*Portrait Painter/ })).toBeVisible();
  await page.getByRole("option", { name: /Cheap Painter/ }).click();
  // A model without photos: the paperclip is there, off, with why.
  await expect(page.getByRole("button", { name: /Эта модель не работает по фото/ })).toBeDisabled();

  await page.getByRole("button", { name: /img\/cheap/ }).click();
  await page.getByRole("tab", { name: "Картинки" }).click();
  await page.getByRole("option", { name: /Portrait Painter/ }).click();
  await page.locator("input[type=file]").setInputFiles({ name: "face.png", mimeType: "image/png", buffer: PNG });
  // With a photo waiting, a model that takes none cannot be picked.
  await page.getByRole("button", { name: /img\/ref/ }).click();
  await expect(page.getByRole("option", { name: /Cheap Painter/ }).getByRole("button")).toBeDisabled();
  await expect(page.getByRole("option", { name: /Cheap Painter/ })).toContainText("не работает по фото");
  await page.keyboard.press("Escape");
  // Opening the list sent nothing (seen: the picker's button sent the form with the photo in it).
  await expect(page.locator(".msg-user")).toHaveCount(0);

  await page.getByLabel(/Опиши картинку/).fill("Этот человек в космосе");
  await page.getByRole("button", { name: /^Создать/ }).click();
  // The photo is uploaded first, then the picture drawn: under the whole suite this takes longer.
  await expect(page.getByRole("img", { name: "Этот человек в космосе" })).toBeVisible({ timeout: 15_000 });
  const sent = fake!.requests.find((r) => r.path === "/v1/images")!.body;
  expect(sent.model).toBe("img/ref");
  expect(sent.input_references[0].image_url.url).toMatch(/^data:image\/png;base64,/);
});
