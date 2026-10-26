import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeProvider, type FakeProvider, type FakeTurn } from "../../../packages/core/test/fake-provider";
import { openSection, paramsButton } from "./sections";

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
  await expect(paramsButton(page)).toBeVisible();
  await openSection(page, "Ключи и модели");
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

  await page.getByRole("button", { name: "Проекты", exact: true }).click();

  await page.getByRole("button", { name: "+ Проект" }).click();
  // No task list, no points, no order: what to make and who does what.
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await page.getByLabel("Что сделать?").fill("Сайт лесопилки");
  const models = page.getByRole("group", { name: "Модели" });
  await expect(models).toContainText("Модель для опроса, плана и работы");
  await expect(models).toContainText("Сильная модель");
  await models.getByRole("button", { name: "Выбери модель" }).first().click();
  // The list opens whole inside the window, not cut by the workshop's column (seen).
  const list = await page.locator(".model-panel").boundingBox();
  const view = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  expect(list!.x).toBeGreaterThanOrEqual(0);
  expect(list!.x + list!.width).toBeLessThanOrEqual(view.width);
  expect(await page.locator(".workshop-main").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
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

  // The workshop: the run's timeline with the plan as its first message, the state in the top bar, the checklist in
  // the sidebar.
  await expect(page.locator(".timeline .msg-user").first()).toContainText("Каталог досок");
  const state = page.locator(".topbar").getByRole("status");
  await expect(state).toContainText("Агент работает");
  // A message while it works goes in at once and the agent takes it on the way.
  await page.getByPlaceholder("Напиши агенту — он учтёт на ходу").fill("Сделай заголовок крупнее");
  await page.getByPlaceholder("Напиши агенту — он учтёт на ходу").press("Enter");
  await expect(page.locator(".msg-user", { hasText: "Сделай заголовок крупнее" })).toBeVisible();

  await expect(state).toContainText("Готово", { timeout: 30_000 });
  await expect(state).toContainText("2 из 2");
  await expect(page.getByRole("list", { name: "Чек-лист" })).toContainText("Проверить страницу");
  await expect(page.locator(".work-questions-note")).toContainText("Нужна доставка?");
  await expect(page.locator(".work-questions-note")).toContainText("Пока считает: Пока без доставки");
  // The plan and the questions are tabs over the timeline.
  await page.getByRole("tab", { name: "Вопросы · 1" }).click();
  await expect(page.locator(".work-question")).toContainText("Нужна доставка?");
  await page.getByRole("tab", { name: "План" }).click();
  await expect(page.locator(".workshop-main .plan-details")).toContainText("Сайт лесопилки с каталогом досок.");
  await page.getByRole("tab", { name: "Ход работы" }).click();
  // The result panel: the report and the folder's changes; the handle beside it folds it away and brings it back.
  const result = page.getByRole("complementary", { name: "Результат" });
  await expect(result.locator(".work-report")).toContainText("Каталог готов");
  await result.getByRole("tab", { name: "Изменения" }).click();
  await expect(result.locator(".diff")).toContainText("index.html");
  const grip = page.getByRole("button", { name: "Скрыть панель результата" });
  await expect(grip).toHaveAttribute("aria-expanded", "true");
  await grip.click();
  await expect(result).toBeHidden();
  const back = page.getByRole("button", { name: "Показать панель результата" });
  await expect(back).toHaveAttribute("aria-expanded", "false");
  await back.click();
  await expect(result).toBeVisible();
  await expect(page.getByPlaceholder("Напиши агенту — он учтёт на ходу")).toBeVisible();
  // Chats are the other mode: the workshop comes back with the project opened last.
  await page.getByRole("button", { name: "Чат", exact: true }).click();
  await expect(page.locator(".workshop")).toHaveCount(0);
  await page.getByRole("button", { name: "Проекты", exact: true }).click();
  await expect(page.locator(".topbar .crumb")).toHaveText(/drimvox-repo-/);
  // The mark leads to the projects' start, not to the chats.
  await page.locator(".topbar .logo").click();
  await expect(page.getByRole("heading", { name: "Над чем поработаем?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Проекты", exact: true })).toHaveAttribute("aria-pressed", "true");
  // The sidebar has a handle of its own: it folds away and comes back.
  await page.getByRole("button", { name: "Скрыть боковую панель" }).click();
  await expect(page.locator("#sidebar")).toBeHidden();
  await page.getByRole("button", { name: "Показать боковую панель" }).click();
  await expect(page.locator("#sidebar")).toBeVisible();
  expect(readFileSync(join(repo, "index.html"), "utf8")).toContain("Доски");
  // Nothing to accept, and git stays the user's.
  expect(execFileSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf8" }).trim().split("\n")).toHaveLength(1);
  expect(fake!.requests.some((r) => JSON.stringify(r.body?.messages ?? []).includes("Сделай заголовок крупнее"))).toBe(true);
});
