import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeProvider, type FakeProvider, type FakeTurn } from "../../../packages/core/test/fake-provider";

const mainJs = fileURLToPath(new URL("../dist/main.cjs", import.meta.url));
const KEY = "good-key";

let userData: string;
let repo: string;
let app: ElectronApplication | undefined;
let fake: FakeProvider | undefined;

test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), "drimvox-e2e-"));
  repo = mkdtempSync(join(tmpdir(), "drimvox-repo-"));
  writeFileSync(join(repo, "README.md"), "# Лесопилка\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("add", "-A");
  git("commit", "-q", "-m", "Start");
});

test.afterEach(async () => {
  await app?.close();
  await fake?.close();
  app = undefined;
  fake = undefined;
  rmSync(userData, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

const call = (name: string, args: Record<string, unknown>): FakeTurn => ({ toolCalls: [{ name, args }] });

async function launch(script: FakeTurn[]): Promise<Page> {
  const queue = [...script];
  fake = await startFakeProvider({
    key: KEY,
    models: [{ id: "coder", name: "Coder", supported_parameters: ["tools"] }],
    respond: () => queue.shift() ?? { text: "Готово." },
  });
  app = await electron.launch({ args: [mainJs], env: { ...process.env, DRIMVOX_USER_DATA: userData, DRIMVOX_TEST_PICK_FOLDER: repo } });
  const page = await app.firstWindow();
  await expect(page.getByRole("button", { name: "Ключи и модели" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Ключи и модели" }).click();
  await page.getByRole("radio", { name: /OpenAI-совместимый/ }).click();
  await page.getByLabel("Адрес API").fill(fake.baseUrl);
  await page.getByLabel("Ключ API, если нужен").fill(KEY);
  await page.getByRole("button", { name: "Подключить", exact: true }).click();
  await expect(page.getByText("Моделей: 1")).toBeVisible();
  return page;
}

// docs/specs/project-work.md: the interview, the final plan with "Go", then one long run with its checklist on the right.
test("a project: the interview, the plan with Go, the agent works alone with its checklist, a message on the way", async () => {
  const page = await launch([
    call("ask_questions", { questions: [], understood: "Сайт лесопилки", unknown: [] }),
    call("write_plan", { summary: "Сайт лесопилки с каталогом досок.", steps: ["Каталог досок", "Проверить страницу"], checks: [], pages: [] }),
    { ...call("write_file", { path: "index.html", content: "<h1>Доски</h1>\n" }), delayMs: 1500 },
    call("ask_user", { question: "Нужна доставка?", assumption: "Пока без доставки" }),
    call("update_checklist", { items: [{ text: "Каталог досок", done: true }, { text: "Проверить страницу", done: true }] }),
    call("finish_work", { report: "Каталог готов: откройте index.html." }),
    { text: "Каталог готов: откройте index.html." },
  ]);

  await page.getByRole("button", { name: "+ Проект" }).click();
  // No task list, no points, no order: what to make and who does what.
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await page.getByLabel("Что сделать?").fill("Сайт лесопилки");
  const models = page.getByRole("group", { name: "Модели" });
  await expect(models).toContainText("Модель для опроса, плана и работы");
  await expect(models).toContainText("Сильная модель");
  await models.getByRole("button", { name: "Выбери модель" }).first().click();
  await page.getByRole("option", { name: /Coder/ }).click();
  // One pick is the model of all three stages; each can be told apart on request.
  await page.getByRole("button", { name: "Разные модели для этапов" }).click();
  await expect(models).toContainText("Опрос");
  await expect(models).toContainText("План");
  await expect(models).toContainText("Работа");
  await expect(models.getByRole("button", { name: /Coder/ })).toHaveCount(3);
  await expect(models.getByRole("button", { name: "Выбери модель" })).toHaveCount(0);
  await page.getByRole("button", { name: "Начать опрос" }).click();

  // The plan comes right under the interview: read it, then "Go".
  const plan = page.getByRole("region", { name: "Итоговый план" });
  await expect(plan).toContainText("Сайт лесопилки с каталогом досок.", { timeout: 30_000 });
  await expect(plan.getByRole("listitem")).toHaveText(["Каталог досок", "Проверить страницу"]);
  await expect(plan.getByLabel("Время, часов")).toHaveValue("2");
  await plan.getByRole("button", { name: "Начать работу" }).click();

  // The project's conversation: the plan as its first message, the panel on the right with the checklist.
  await expect(page.locator(".msg-user").first()).toContainText("Каталог досок");
  const panel = page.getByRole("complementary", { name: "Ход работы" });
  await expect(panel).toContainText("Чек-лист");
  await expect(panel).toContainText("Агент работает");
  // A message while it works goes in at once and the agent takes it on the way.
  await page.getByPlaceholder("Напиши агенту — он учтёт на ходу").fill("Сделай заголовок крупнее");
  await page.getByPlaceholder("Напиши агенту — он учтёт на ходу").press("Enter");
  await expect(page.locator(".msg-user", { hasText: "Сделай заголовок крупнее" })).toBeVisible();

  await expect(panel).toContainText("Готово", { timeout: 30_000 });
  await expect(panel).toContainText("2 из 2");
  await expect(panel).toContainText("Нужна доставка?");
  await expect(panel).toContainText("Пока считает: Пока без доставки");
  // The workspace's tabs: the actions are in the conversation; the plan, the folder's changes and the report apart.
  await expect(panel).not.toContainText("Журнал действий");
  await page.getByRole("tab", { name: "План" }).click();
  await expect(page.locator(".plan-details")).toContainText("Сайт лесопилки с каталогом досок.");
  await page.getByRole("tab", { name: "Изменения" }).click();
  await expect(page.locator(".diff")).toContainText("index.html");
  await page.getByRole("tab", { name: "Запуск" }).click();
  await expect(page.locator(".work-report")).toContainText("Каталог готов");
  await page.getByRole("tab", { name: "Работа" }).click();
  await expect(page.getByPlaceholder("Напиши агенту — он учтёт на ходу")).toBeVisible();
  expect(readFileSync(join(repo, "index.html"), "utf8")).toContain("Доски");
  // Nothing to accept, and git stays the user's.
  expect(execFileSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf8" }).trim().split("\n")).toHaveLength(1);
  expect(fake!.requests.some((r) => JSON.stringify(r.body?.messages ?? []).includes("Сделай заголовок крупнее"))).toBe(true);
});
