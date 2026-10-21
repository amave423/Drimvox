import { chromium, expect, test, type Browser } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeProvider, type FakeProvider } from "../../../packages/core/test/fake-provider";

const serverJs = fileURLToPath(new URL("../dist/server.mjs", import.meta.url));
const KEY = "good-key";
const PASSWORD = "correct horse";

let dataDir: string;
let server: ChildProcess | undefined;
let browser: Browser | undefined;
let fake: FakeProvider;

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

/** Starts the built server and waits for the setup code it writes to its log. */
async function startArtel(port: number): Promise<string> {
  server = spawn(process.execPath, [serverJs], {
    env: { ...process.env, ARTEL_DATA_DIR: dataDir, ARTEL_PORT: String(port), ARTEL_TEST_USD_RUB: "80" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No setup code in the log:\n${log}`)), 30_000);
    const read = (chunk: Buffer) => {
      log += chunk.toString();
      const code = /code to set it in the browser: (\d{6})/.exec(log)?.[1];
      if (code) {
        clearTimeout(timer);
        resolve(code);
      }
    };
    server!.stdout!.on("data", read);
    server!.stderr!.on("data", read);
  });
}

test.beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "artel-server-e2e-"));
  fake = await startFakeProvider({
    key: KEY,
    models: [{ id: "fake-model", name: "Fake Model", pricing: { prompt: "0.000001", completion: "0.000002" } }],
    chunks: [{ text: "Привет с сервера!" }],
  });
});

test.afterEach(async () => {
  await browser?.close();
  // The database stays locked until the server has really exited.
  const running = server;
  if (running && running.exitCode === null) await new Promise((done) => (running.once("exit", done), running.kill()));
  await fake.close();
  browser = undefined;
  server = undefined;
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test("a browser sets the password with the setup code, chats, signs out and back in", async () => {
  const port = await freePort();
  const code = await startArtel(port);
  const base = `http://127.0.0.1:${port}`;

  // The API is closed without a session.
  expect((await fetch(`${base}/api/settings`)).status).toBe(401);

  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome" });
  const page = await (await browser.newContext({ locale: "ru-RU" })).newPage();
  await page.goto(base);
  await expect(page.getByRole("heading", { name: "Задай пароль" })).toBeVisible();
  await page.getByLabel("Код первого входа").fill(code === "000000" ? "111111" : "000000");
  await page.getByLabel("Новый пароль, от 8 символов").fill(PASSWORD);
  await page.getByLabel("Пароль ещё раз").fill(PASSWORD);
  await page.getByRole("button", { name: "Задать пароль и войти" }).click();
  await expect(page.getByText("Неверный код первого входа.")).toBeVisible();
  await page.getByLabel("Код первого входа").fill(code);
  await page.getByRole("button", { name: "Задать пароль и войти" }).click();
  await expect(page.getByRole("button", { name: "Ключи и модели" }).first()).toBeVisible();

  await page.getByRole("button", { name: "Ключи и модели" }).click();
  await page.getByRole("radio", { name: /OpenAI-совместимый/ }).click();
  await page.getByLabel("Адрес API").fill(fake.baseUrl);
  await page.getByLabel("Ключ API, если нужен").fill(KEY);
  await page.getByRole("button", { name: "Подключить", exact: true }).click();
  await expect(page.getByText("Моделей: 1")).toBeVisible();

  await page.getByRole("button", { name: "+ Новый чат" }).click();
  await page.getByRole("button", { name: "Выбери модель" }).click();
  await page.getByRole("option", { name: /Fake Model/ }).click();
  const box = page.getByRole("textbox", { name: /Сообщение/ });
  await box.fill("Привет");
  await box.press("Enter");
  await expect(page.getByText("Привет с сервера!")).toBeVisible();

  await page.getByRole("button", { name: "Настройки" }).click();
  await expect(page.getByRole("switch", { name: /Уведомлять в браузере/ })).toBeVisible();
  await page.getByRole("button", { name: "Выйти" }).click();
  await expect(page.getByRole("heading", { name: "Вход в Drimvox" })).toBeVisible();
  await page.getByLabel("Пароль").fill("wrong password");
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByText("Неверный пароль.")).toBeVisible();
  await page.getByLabel("Пароль").fill(PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("button", { name: "Ключи и модели" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /^Привет$/ })).toBeVisible();
});
