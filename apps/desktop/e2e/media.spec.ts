import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeProvider, type FakeProvider } from "../../../packages/core/test/fake-provider";

const mainJs = fileURLToPath(new URL("../dist/main.cjs", import.meta.url));
const KEY = "good-key";
// A real 1×1 PNG, so the window can show it.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

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
  rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function launch(): Promise<Page> {
  fake = await startFakeProvider({
    key: KEY,
    models: [{ id: "chatty", name: "Chatty" }],
    handle: (method, path) => {
      if (method === "GET" && path === "/v1/images/models") {
        return {
          json: {
            data: [
              { id: "img/cheap", name: "Cheap Painter", supported_parameters: { aspect_ratio: { type: "enum", values: ["1:1", "16:9"] } } },
              { id: "img/dear", name: "Dear Painter", supported_parameters: {} },
            ],
          },
        };
      }
      if (method === "GET" && path === "/v1/images/models/img/cheap/endpoints") {
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
  app = await electron.launch({ args: [mainJs], env: { ...process.env, ARTEL_USER_DATA: userData } });
  const page = await app.firstWindow();
  await expect(page.getByText("Ядро запущено")).toBeVisible();

  await page.getByRole("button", { name: "Ключи и модели" }).click();
  await page.getByRole("radio", { name: /OpenAI-совместимый/ }).click();
  await page.getByLabel("Адрес API").fill(fake.baseUrl);
  await page.getByLabel("Ключ API, если нужен").fill(KEY);
  await page.getByRole("button", { name: "Подключить", exact: true }).click();
  await expect(page.getByText("Моделей: 1")).toBeVisible();
  return page;
}

test("a picture in a chat: the price before, the picture after, the gallery", async () => {
  const page = await launch();
  await page.getByRole("button", { name: "+ Новый чат" }).click();
  await page.getByRole("button", { name: "Выбери модель" }).click();
  await page.getByRole("tab", { name: "Картинки" }).click();
  await page.getByRole("option", { name: /Dear Painter/ }).click();
  // A dear picture names its price on the button.
  await expect(page.getByRole("button", { name: "Запустить за ≈ 20,00 ₽" })).toBeVisible();

  await page.getByRole("button", { name: /img\/dear/ }).click();
  await page.getByRole("tab", { name: "Картинки" }).click();
  await page.getByRole("option", { name: /Cheap Painter/ }).click();
  await expect(page.getByText("≈ 3,20 ₽")).toBeVisible();
  await page.getByLabel("Формат").selectOption("16:9");
  await page.getByLabel(/Опиши картинку/).fill("Лиса в шарфе");
  await page.getByRole("button", { name: "Создать" }).click();

  const picture = page.getByRole("img", { name: "Лиса в шарфе" });
  await expect(picture).toBeVisible();
  expect(await picture.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  await expect(page.getByText("3,12 ₽").first()).toBeVisible();
  const sent = fake!.requests.find((r) => r.path === "/v1/images")!.body;
  expect(sent).toMatchObject({ model: "img/cheap", prompt: "Лиса в шарфе", aspect_ratio: "16:9" });

  await page.getByRole("button", { name: "Галерея" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Галерея" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Лиса в шарфе" })).toBeVisible();
  await page.getByRole("button", { name: "Открыть чат" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Лиса в шарфе" })).toBeVisible();
});
