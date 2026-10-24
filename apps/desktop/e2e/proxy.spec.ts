import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeProvider, type FakeProvider } from "../../../packages/core/test/fake-provider";
import { startFakeProxy, type FakeProxy } from "../../../packages/core/test/fake-proxy";

const mainJs = fileURLToPath(new URL("../dist/main.cjs", import.meta.url));
const KEY = "good-key";

let userData: string;
let app: ElectronApplication | undefined;
let fake: FakeProvider;
let page204: FakeProvider;
let proxy: FakeProxy;

test.beforeEach(async () => {
  userData = mkdtempSync(join(tmpdir(), "drimvox-e2e-"));
  fake = await startFakeProvider({ key: KEY, models: [{ id: "m1", name: "Model 1" }] });
  // Its own address: the proxy keeps a tunnel per address open, and the provider's requests must open their own.
  page204 = await startFakeProvider({ routes: { "/ping": { ok: true } } });
  proxy = await startFakeProxy({ user: "artem", password: "s3cret" });
});

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  await fake.close();
  await page204.close();
  await proxy.close();
  rmSync(userData, { recursive: true, force: true });
});

async function launch(): Promise<Page> {
  app = await electron.launch({
    args: [mainJs],
    env: { ...process.env, DRIMVOX_USER_DATA: userData, DRIMVOX_TEST_PROXY_CHECK_URL: `${page204.origin}/ping` },
  });
  const page = await app.firstWindow();
  await expect(page.getByRole("button", { name: "Ключи и модели" }).first()).toBeVisible();
  return page;
}

test("notifications are a switch, the proxy is set once and each provider opts in", async () => {
  const page = await launch();
  await page.getByRole("button", { name: "Настройки" }).click();
  const notify = page.getByRole("switch", { name: /Уведомлять в Windows/ });
  await expect(notify).toBeChecked();
  await notify.click({ force: true });
  await expect(notify).not.toBeChecked();

  // The settings are in sections; the internet's has the search service and the proxy, explained by a "?".
  await page.getByRole("tab", { name: "Интернет" }).click();
  await expect(page.getByRole("heading", { name: /Поиск в интернете/ })).toBeVisible();
  await expect(page.getByText("Сейчас — бесплатный поиск", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: /Бесплатный поиск \(DuckDuckGo\) часто блокирует/ }).hover();
  await expect(page.getByRole("tooltip")).toContainText("Tavily или Brave");
  await page.getByLabel("Адрес прокси").fill(proxy.url);
  await page.getByRole("button", { name: "Сохранить" }).last().click();
  await expect(page.getByText(`http://artem:•••@127.0.0.1:${proxy.port}`)).toBeVisible();
  await expect(page.getByText(/Прокси работает: ответ за \d+ мс/)).toBeVisible();
  await expect(page.getByText("s3cret")).toHaveCount(0);

  await page.getByRole("button", { name: "Ключи и модели" }).click();
  await page.getByRole("radio", { name: /OpenAI-совместимый/ }).click();
  await page.getByLabel("Адрес API").fill(fake.baseUrl);
  await page.getByLabel("Ключ API, если нужен").fill(KEY);
  await page.getByRole("button", { name: "Подключить", exact: true }).click();
  await expect(page.getByText("Моделей: 1")).toBeVisible();
  const before = proxy.hits.length;

  const viaProxy = page.getByRole("switch", { name: "Через прокси" });
  await expect(viaProxy).not.toBeChecked();
  await viaProxy.click({ force: true });
  await expect(viaProxy).toBeChecked();
  await expect(page.getByText("Моделей: 1")).toBeVisible();
  await expect.poll(() => proxy.hits.length).toBeGreaterThan(before);
});
