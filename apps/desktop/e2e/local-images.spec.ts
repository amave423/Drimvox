// docs/specs/local-images.md: a picture model downloaded on the local models' sheet draws in a picture chat, for free.
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeHub } from "../../../packages/core/test/fake-hub";

const mainJs = fileURLToPath(new URL("../dist/main.cjs", import.meta.url));
const FAKE_SD = fileURLToPath(new URL("../../../packages/core/test/fake-sd.mjs", import.meta.url));
const GB = 2 ** 30;

let userData: string;
let app: ElectronApplication | undefined;
let hub: Awaited<ReturnType<typeof startFakeHub>> | undefined;

test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), "drimvox-e2e-"));
});

test.afterEach(async () => {
  await app?.close();
  await hub?.close();
  app = undefined;
  hub = undefined;
  rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test("downloads a picture model on the local models' sheet and draws with it in a chat", async () => {
  hub = await startFakeHub();
  const local = {
    command: null,
    hardware: { ramBytes: 32 * GB, gpu: { name: "RTX 3080", vramBytes: 10 * GB }, unified: false },
    registryUrl: "http://127.0.0.1:9",
    hfUrl: hub.url,
    hfFiles: [hub.url],
    images: { engineUrl: `${hub.url}/engine.zip`, serverCommand: [process.execPath, FAKE_SD], idleMs: 60_000 },
  };
  // Never this computer's own Ollama: an address where nothing answers.
  app = await electron.launch({
    args: [mainJs],
    env: { ...process.env, DRIMVOX_USER_DATA: userData, DRIMVOX_TEST_OLLAMA_URL: "http://127.0.0.1:9/v1", DRIMVOX_TEST_LOCAL: JSON.stringify(local) },
  });
  const page = await app.firstWindow();
  await expect(page.getByRole("button", { name: "Ключи и модели" }).first()).toBeVisible();

  await page.getByRole("button", { name: "Локальные модели" }).click();
  // Text, pictures and video are parts of the sheet.
  await page.getByRole("tab", { name: "Картинки" }).click();
  await expect(page.getByRole("heading", { name: "Картинки на этом компьютере" })).toBeVisible();
  const card = page.locator(".local-card", { hasText: "Z-Image Turbo" });
  await expect(card.getByText("быстро")).toBeVisible();
  await expect(page.locator(".local-card", { hasText: "Qwen-Image 2512" }).getByText("медленно")).toBeVisible();
  await card.getByRole("button", { name: /^Скачать · / }).click();
  await expect(card.getByText(/^Скачана · /)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Скачанные модели — во вкладке «Картинки»/)).toBeVisible();

  // The engine lives in "Local models", not among the keys (asked for: Ollama and the picture engine are not providers to manage).
  await page.getByRole("button", { name: "Ключи и модели" }).click();
  await expect(page.getByText(/Картинки на этом компьютере, бесплатно/)).toHaveCount(0);

  await page.getByRole("button", { name: "+ Новый чат" }).click();
  await page.getByRole("button", { name: "Выбери модель" }).click();
  await page.getByRole("option", { name: /Z-Image Turbo/ }).click();
  await page.getByLabel(/Опиши картинку/).fill("Лиса в шарфе");
  await page.getByRole("button", { name: "Создать" }).click();
  const picture = page.getByRole("img", { name: "Лиса в шарфе" });
  await expect(picture).toBeVisible({ timeout: 20_000 });
  expect(await picture.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
});

// The installer's "picture engine" box: a note beside the program, and the first start downloads the engine and opens
// the local models. The note is used once.
test("downloads the picture engine on the first start when the installer was asked to", async () => {
  hub = await startFakeHub();
  const local = {
    command: null,
    hardware: { ramBytes: 32 * GB, gpu: { name: "RTX 3080", vramBytes: 10 * GB }, unified: false },
    registryUrl: "http://127.0.0.1:9",
    hfUrl: hub.url,
    hfFiles: [hub.url],
    images: { engineUrl: `${hub.url}/engine.zip`, serverCommand: [process.execPath, FAKE_SD] },
  };
  const program = mkdtempSync(join(tmpdir(), "drimvox-e2e-program-"));
  writeFileSync(join(program, "install-images"), "");
  app = await electron.launch({
    args: [mainJs],
    env: { ...process.env, DRIMVOX_USER_DATA: userData, DRIMVOX_TEST_PROGRAM_DIR: program, DRIMVOX_TEST_OLLAMA_URL: "http://127.0.0.1:9/v1", DRIMVOX_TEST_LOCAL: JSON.stringify(local) },
  });
  const page = await app.firstWindow();
  await expect(page.getByRole("heading", { name: "Локальные модели" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Картинки на этом компьютере" })).toBeVisible();
  // Downloaded: the sheet no longer offers the engine on its own.
  await expect(page.getByRole("button", { name: /Скачать движок/ })).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator(".local-card", { hasText: "Z-Image Turbo" })).toBeVisible();
  expect(existsSync(join(program, "install-images"))).toBe(false);
});

test("offers the picture engine on its own on the sheet", async () => {
  hub = await startFakeHub();
  const local = {
    command: null,
    hardware: { ramBytes: 32 * GB, gpu: { name: "RTX 3080", vramBytes: 10 * GB }, unified: false },
    registryUrl: "http://127.0.0.1:9",
    hfUrl: hub.url,
    hfFiles: [hub.url],
    images: { engineUrl: `${hub.url}/engine.zip`, serverCommand: [process.execPath, FAKE_SD] },
  };
  app = await electron.launch({ args: [mainJs], env: { ...process.env, DRIMVOX_USER_DATA: userData, DRIMVOX_TEST_OLLAMA_URL: "http://127.0.0.1:9/v1", DRIMVOX_TEST_LOCAL: JSON.stringify(local) } });
  const page = await app.firstWindow();
  await expect(page.getByRole("button", { name: "Ключи и модели" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Локальные модели" }).click();
  await page.getByRole("tab", { name: "Картинки" }).click();
  await page.getByRole("button", { name: "Скачать движок · 30 МБ" }).click();
  await expect(page.getByRole("button", { name: /Скачать движок/ })).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText(/Движок stable-diffusion\.cpp/)).toHaveCount(0);
});

test("downloads a video model in the video part and films a free clip in a chat", async () => {
  hub = await startFakeHub();
  const local = {
    command: null,
    hardware: { ramBytes: 32 * GB, gpu: { name: "RTX 3080", vramBytes: 10 * GB }, unified: false },
    registryUrl: "http://127.0.0.1:9",
    hfUrl: hub.url,
    hfFiles: [hub.url],
    images: { engineUrl: `${hub.url}/engine.zip`, serverCommand: [process.execPath, FAKE_SD] },
  };
  app = await electron.launch({ args: [mainJs], env: { ...process.env, DRIMVOX_USER_DATA: userData, DRIMVOX_TEST_OLLAMA_URL: "http://127.0.0.1:9/v1", DRIMVOX_TEST_LOCAL: JSON.stringify(local) } });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Локальные модели" }).click();
  await page.getByRole("tab", { name: "Видео" }).click();
  await expect(page.getByRole("heading", { name: "Видео на этом компьютере" })).toBeVisible();
  // Only video models here.
  await expect(page.locator(".local-card", { hasText: "Z-Image Turbo" })).toHaveCount(0);
  const card = page.locator(".local-card", { hasText: "Wan 2.1 1.3B" });
  await card.getByRole("button", { name: /^Скачать · / }).click();
  await expect(card.getByText(/^Скачана · /)).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "+ Новый чат" }).click();
  await page.getByRole("button", { name: "Выбери модель" }).click();
  await page.getByRole("tab", { name: "Видео" }).click();
  await page.getByRole("option", { name: /Wan 2\.1 1\.3B/ }).click();
  await page.getByLabel(/Опиши/).fill("Лиса бежит по снегу");
  // Free: started at once, no price to confirm.
  await page.getByRole("button", { name: /^Создать/ }).click();
  await expect(page.locator(".msg-assistant .player")).toHaveCount(1, { timeout: 20_000 });
});

test("finds a picture model on Hugging Face, greys out an unknown family and downloads a known one", async () => {
  hub = await startFakeHub();
  const local = {
    command: null,
    hardware: { ramBytes: 32 * GB, gpu: { name: "RTX 3080", vramBytes: 10 * GB }, unified: false },
    registryUrl: "http://127.0.0.1:9",
    hfUrl: hub.url,
    hfFiles: [hub.url],
    images: { engineUrl: `${hub.url}/engine.zip`, serverCommand: [process.execPath, FAKE_SD] },
  };
  app = await electron.launch({ args: [mainJs], env: { ...process.env, DRIMVOX_USER_DATA: userData, DRIMVOX_TEST_OLLAMA_URL: "http://127.0.0.1:9/v1", DRIMVOX_TEST_LOCAL: JSON.stringify(local) } });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Локальные модели" }).click();
  await page.getByRole("tab", { name: "Картинки" }).click();
  await page.getByPlaceholder(/z-image или qwen-image/).fill("turbo");
  await page.getByRole("button", { name: "Найти" }).click();
  await expect(page.locator(".local-repo.is-unsupported", { hasText: "someone/flux-mystery-GGUF" })).toContainText("пока не знает");
  await page.getByRole("button", { name: /someone\/Z-Image-Turbo-Fun-GGUF/ }).click();
  const row = page.locator(".local-variants .local-row", { hasText: "Q5_K_M" });
  await row.getByRole("button", { name: /^Скачать · / }).click();
  await expect(row.getByText(/^Скачана · /)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".local-card", { hasText: "Z-Image-Turbo-Fun-GGUF · Q5_K_M" })).toContainText("Найдена на Hugging Face");
});
