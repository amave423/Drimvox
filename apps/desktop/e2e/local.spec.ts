import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const mainJs = fileURLToPath(new URL("../dist/main.cjs", import.meta.url));
const FAKE_OLLAMA = fileURLToPath(new URL("../../../packages/core/test/fake-ollama.mjs", import.meta.url));
const GB = 2 ** 30;

let userData: string;
let app: ElectronApplication | undefined;
let registry: Server | undefined;

test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), "artel-e2e-"));
});

test.afterEach(async () => {
  await app?.close().catch(() => {});
  await new Promise((r) => (registry ? registry.close(r) : r(null)));
  app = undefined;
  registry = undefined;
  rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = netServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

/** Ollama's registry with three of the picks: two that fit a 10 GB card and one far too big. */
async function serveRegistry(): Promise<string> {
  const sizes: Record<string, number> = { "qwen3/1.7b": 1.3, "qwen3/8b": 4.9, "qwen3.6/35b": 60 };
  registry = createServer((req, res) => {
    const m = req.url!.match(/^\/v2\/library\/([^/]+)\/manifests\/(.+)$/);
    const gb = m ? sizes[`${m[1]}/${m[2]}`] : undefined;
    res.writeHead(gb ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(gb ? { layers: [{ size: Math.round(gb * GB) }] } : { errors: [] }));
  });
  await new Promise<void>((r) => registry!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(registry.address() as { port: number }).port}`;
}

const answers = async (port: number) => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/api/version`, { signal: AbortSignal.timeout(500) })).ok;
  } catch {
    return false;
  }
};

test("local models: Ollama starts by itself, picks fit the computer, a download reaches the chat, and Ollama goes with the app", async () => {
  test.setTimeout(120_000);
  const port = await freePort();
  const local = {
    command: [process.execPath, FAKE_OLLAMA],
    commandEnv: { FAKE_OLLAMA_PULL_MS: "80" },
    idleMs: 600_000,
    hardware: { ramBytes: 32 * GB, gpu: { name: "NVIDIA GeForce RTX 3080", vramBytes: 10 * GB }, unified: false },
    registryUrl: await serveRegistry(),
    hfUrl: "http://127.0.0.1:9",
  };
  app = await electron.launch({
    args: [mainJs],
    env: { ...process.env, ARTEL_USER_DATA: userData, ARTEL_TEST_OLLAMA_URL: `http://127.0.0.1:${port}/v1`, ARTEL_TEST_LOCAL: JSON.stringify(local) },
  });
  const page: Page = await app.firstWindow();
  await expect(page.getByText("Ядро запущено")).toBeVisible();

  await page.getByRole("button", { name: "Локальные модели" }).click();
  await expect(page.getByText(/Ollama 0\.31\.1-fake запущена Artel/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/видеокарта NVIDIA GeForce RTX 3080, 10 ГБ; память 32 ГБ/)).toBeVisible();

  // Only what runs here: the 60 GB model is not offered at all.
  const cards = page.locator(".local-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText("qwen3:1.7b");
  await expect(cards.nth(0)).toContainText("быстро");
  await expect(page.getByText("qwen3.6:35b")).toHaveCount(0);

  await cards.nth(0).getByRole("button", { name: /Скачать · 1,3 ГБ/ }).click();
  await expect(page.getByRole("progressbar", { name: "Скачивание qwen3:1.7b" })).toBeVisible();
  await expect(page.getByText("Скачано")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".local-row", { hasText: "qwen3:1.7b" }).first()).toBeVisible();
  await expect(cards.nth(0)).toContainText("Скачана");

  // The download added the Ollama provider: the model is in the chat and answers.
  await page.getByRole("button", { name: "+ Новый чат" }).click();
  await page.getByRole("button", { name: "Выбери модель" }).click();
  await page.getByRole("option", { name: /qwen3:1\.7b/ }).click();
  // A model this small gets no search: the switch says so instead of offering it.
  await page.getByRole("button", { name: /^Интернет:/ }).click();
  await expect(page.getByText("Эта модель слишком мала, чтобы искать в интернете: она отвечает сама.")).toBeVisible();
  await expect(page.getByRole("option", { name: /Поиск Artel/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  const box = page.getByRole("textbox", { name: /Сообщение/ });
  await box.fill("Привет");
  await box.press("Enter");
  await expect(page.getByText("Привет из Ollama")).toBeVisible({ timeout: 20_000 });

  // Closing the app stops the Ollama it started.
  expect(await answers(port)).toBe(true);
  await app.close();
  app = undefined;
  await expect.poll(() => answers(port), { timeout: 10_000 }).toBe(false);
});

// docs/specs/local-models.md: without Ollama the sheet offers to install it, with the size of the download first.
test("installs Ollama from the sheet: the size first, then Artel finds it", async () => {
  const setup = Buffer.alloc(3 * 1024 * 1024, 1);
  registry = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(setup.length) });
    res.end(req.method === "HEAD" ? undefined : setup);
  });
  await new Promise<void>((r) => registry!.listen(0, "127.0.0.1", r));
  const port = await freePort();
  const local = {
    command: null,
    hardware: { ramBytes: 16 * GB, gpu: null, unified: false },
    registryUrl: "http://127.0.0.1:9",
    hfUrl: "http://127.0.0.1:9",
    // After the setup, the fake Ollama is the one found.
    install: { url: `http://127.0.0.1:${(registry.address() as { port: number }).port}/OllamaSetup.exe`, skipRun: true, command: [process.execPath, FAKE_OLLAMA], can: true },
  };
  app = await electron.launch({ args: [mainJs], env: { ...process.env, ARTEL_USER_DATA: userData, ARTEL_TEST_OLLAMA_URL: `http://127.0.0.1:${port}/v1`, ARTEL_TEST_LOCAL: JSON.stringify(local) } });
  const page: Page = await app.firstWindow();
  await expect(page.getByText("Ядро запущено")).toBeVisible();

  await page.getByRole("button", { name: "Локальные модели" }).click();
  await expect(page.getByText(/Ollama не установлена/)).toBeVisible();
  await page.getByRole("button", { name: "Установить Ollama · 3 МБ" }).click();
  await expect(page.getByText(/Ollama 0\.31\.1-fake запущена Artel/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Ollama не установлена/)).toHaveCount(0);
});
