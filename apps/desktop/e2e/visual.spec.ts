import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeProvider, type FakeProvider, type FakeTurn } from "../../../packages/core/test/fake-provider";
import { makeRepo } from "../../../packages/core/test/git-repo";

const mainJs = fileURLToPath(new URL("../dist/main.cjs", import.meta.url));
const KEY = "good-key";

let userData: string;
let repo: string;
let app: ElectronApplication | undefined;
let fake: FakeProvider | undefined;
let site: Server | undefined;

test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), "artel-e2e-"));
  repo = makeRepo({ "index.html": "<h1>Привет</h1>\n" });
});

test.afterEach(async () => {
  await app?.close();
  await fake?.close();
  await new Promise((r) => (site ? site.close(r) : r(null)));
  app = undefined;
  fake = undefined;
  site = undefined;
  rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** The app the agent "built": a page on this computer. */
async function serveSite(): Promise<string> {
  site = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    // A long page: what is below the first screen must be in the picture too.
    res.end(
      '<body style="margin:0;background:#c0392b"><h1 style="color:white;font:64px sans-serif;padding:40px">Привет, Artel</h1>' +
        '<div style="height:2200px"></div><footer style="color:white;font:32px sans-serif">Контакты внизу</footer></body>',
    );
  });
  await new Promise<void>((r) => site!.listen(0, "127.0.0.1", r));
  const address = site.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return `http://localhost:${address.port}/`;
}

test("an agent looks at its page: a real screenshot goes to the model and into the feed", async () => {
  const url = await serveSite();
  // The coder sees pictures itself, so it also checks its own screenshots.
  const coder: FakeTurn[] = [
    { toolCalls: [{ name: "look_at_page", args: { url, question: "Виден заголовок «Привет, Artel»?" } }] },
    { toolCalls: [{ name: "finish", args: { summary: "Проверил страницу.", commit_message: "Check" } }] },
  ];
  fake = await startFakeProvider({
    key: KEY,
    models: [{ id: "coder", name: "Coder", supported_parameters: ["tools"], architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } }],
    respond: (body) =>
      JSON.stringify(body.messages).includes("data:image/png;base64,") && !body.tools
        ? { text: "Да: белый заголовок «Привет, Artel» на красном фоне." }
        : (coder.shift() ?? { text: "Done." }),
  });
  app = await electron.launch({ args: [mainJs], env: { ...process.env, ARTEL_USER_DATA: userData, ARTEL_TEST_PICK_FOLDER: repo } });
  const page: Page = await app.firstWindow();
  await expect(page.getByText("Ядро запущено")).toBeVisible();

  await page.getByRole("button", { name: "Ключи и модели" }).click();
  await page.getByRole("radio", { name: /OpenAI-совместимый/ }).click();
  await page.getByLabel("Адрес API").fill(fake.baseUrl);
  await page.getByLabel("Ключ API, если нужен").fill(KEY);
  await page.getByRole("button", { name: "Подключить", exact: true }).click();
  await expect(page.getByText("Моделей: 1")).toBeVisible();

  await page.getByRole("button", { name: "+ Проект" }).click();
  await page.getByLabel("Новая задача").fill("Проверь, как выглядит страница");
  await page.getByRole("button", { name: "Выбери модель" }).click();
  await page.getByRole("option", { name: /Coder/ }).click();
  await page.getByLabel("Сначала задать мне вопросы").uncheck();
  await page.getByLabel("Написать спеку и план").uncheck();
  await page.getByRole("button", { name: "Запустить агента" }).click();

  await expect(page.getByText("Проверил страницу.")).toBeVisible({ timeout: 30_000 });
  await page.getByText("Как агент работал").click();
  const shot = page.getByRole("img", { name: `Скриншот ${url}` });
  await expect(shot).toBeVisible();
  expect(await shot.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(600);

  // The model got a real PNG of the page, not an empty picture.
  const sent = fake.requests.find((r) => JSON.stringify(r.body?.messages ?? "").includes("data:image/png;base64,"))!;
  const dataUrl = JSON.stringify(sent.body.messages).match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/)![1]!;
  const png = Buffer.from(dataUrl, "base64");
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  expect(png.length).toBeGreaterThan(5000);
  // The whole page, not only its first screen (PNG height sits at byte 20).
  expect(png.readUInt32BE(20)).toBeGreaterThan(2000);
});
