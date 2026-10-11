import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeProvider, type FakeProvider, type FakeTurn } from "../../../packages/core/test/fake-provider";
import { git, makeRepo } from "../../../packages/core/test/git-repo";

const mainJs = fileURLToPath(new URL("../dist/main.cjs", import.meta.url));
const KEY = "good-key";
const models = [{ id: "coder", name: "Coder", supported_parameters: ["tools"] }];

let userData: string;
let repo: string;
let app: ElectronApplication | undefined;
let fake: FakeProvider | undefined;

test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), "artel-e2e-"));
  repo = makeRepo({ "src/app.ts": "export const greeting = 'hi';\n" });
});

test.afterEach(async () => {
  await app?.close();
  await fake?.close();
  app = undefined;
  fake = undefined;
  rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function launch(script: FakeTurn[]): Promise<Page> {
  fake = await startFakeProvider({ key: KEY, models, script });
  app = await electron.launch({ args: [mainJs], env: { ...process.env, ARTEL_USER_DATA: userData, ARTEL_TEST_PICK_FOLDER: repo } });
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

async function startTask(page: Page, task: string) {
  await page.getByRole("button", { name: "+ Проект" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/artel-repo-/);
  await page.getByLabel("Новая задача").fill(task);
  await page.getByRole("button", { name: "Выбери модель" }).click();
  await page.getByRole("option", { name: /Coder/ }).click();
  await page.getByRole("button", { name: "Запустить агента" }).click();
}

test("an agent changes a copy, takes a line comment and lands as one commit", async () => {
  const page = await launch([
    { text: "Меняю приветствие.", toolCalls: [{ name: "edit_file", args: { path: "src/app.ts", old: "'hi'", new: "'hello'" } }] },
    { toolCalls: [{ name: "finish", args: { summary: "Поменял приветствие на hello.", commit_message: "Change greeting to hello" } }] },
    { toolCalls: [{ name: "edit_file", args: { path: "src/app.ts", old: "'hello'", new: "'hello there'" } }] },
    { toolCalls: [{ name: "finish", args: { summary: "Учёл замечание.", commit_message: "Change greeting to hello there" } }] },
  ]);
  await startTask(page, "Поменяй приветствие на hello");

  await expect(page.getByText("Агент закончил. Посмотри правки")).toBeVisible();
  await expect(page.getByText("Поменял приветствие на hello.")).toBeVisible();
  expect(readFileSync(join(repo, "src", "app.ts"), "utf8")).toBe("export const greeting = 'hi';\n");

  await page.getByRole("button", { name: "src/app.ts:1" }).last().click();
  await page.getByLabel("Замечание к строке").fill("Сделай 'hello there'");
  await page.getByRole("button", { name: "Добавить" }).click();
  await expect(page.getByText("Сделай 'hello there'").first()).toBeVisible();
  await page.getByRole("button", { name: "Вернуть на доработку" }).click();

  await expect(page.getByText("Учёл замечание.")).toBeVisible();
  await expect(page.getByLabel("Сообщение коммита")).toHaveValue("Change greeting to hello there");
  await page.getByRole("button", { name: "Принять", exact: true }).click();

  await expect(page.getByText(/Принято: коммит [0-9a-f]{7} в проекте/)).toBeVisible();
  expect(readFileSync(join(repo, "src", "app.ts"), "utf8")).toBe("export const greeting = 'hello there';\n");
  expect(git(repo, "log", "--format=%s", "-1")).toBe("Change greeting to hello there");
  expect(git(repo, "status", "--porcelain")).toBe("");
});

test("the agent asks before git push and respects a refusal", async () => {
  const page = await launch([
    { toolCalls: [{ name: "run_command", args: { command: "git push origin main" } }] },
    { toolCalls: [{ name: "finish", args: { summary: "Пуш не разрешили, ничего не менял.", commit_message: "Nothing" } }] },
  ]);
  await startTask(page, "Запушь проект");

  await expect(page.getByText("Агент просит разрешения")).toBeVisible();
  await expect(page.getByText("Отправка кода на сервер (git push)")).toBeVisible();
  await page.getByRole("button", { name: "Запретить" }).click();

  await expect(page.getByText("Агент закончил, но файлы не изменились.")).toBeVisible();
  await expect(page.getByText("Пуш не разрешили, ничего не менял.")).toBeVisible();
});

test("discarding removes the copy and leaves the project alone", async () => {
  const page = await launch([
    { toolCalls: [{ name: "write_file", args: { path: "extra.txt", content: "x" } }] },
    { toolCalls: [{ name: "finish", args: { summary: "Добавил extra.txt.", commit_message: "Add extra" } }] },
  ]);
  await startTask(page, "Добавь extra.txt");
  await expect(page.getByText("Добавил extra.txt.")).toBeVisible();

  await page.getByRole("button", { name: "Отказаться от правок" }).click();
  await page.getByRole("button", { name: "Отказаться от правок" }).click();
  await expect(page.getByText("Правки отменены, копия удалена.")).toBeVisible();
  expect(existsSync(join(repo, "extra.txt"))).toBe(false);
  expect(git(repo, "branch", "--list", "artel/*")).toBe("");
});
