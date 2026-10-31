import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeProvider, type FakeProvider, type FakeTurn } from "../../../packages/core/test/fake-provider";
import { openSection, paramsButton } from "./sections";
import { addProject } from "./start-task";

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

async function launch(script: FakeTurn[], sees = false): Promise<Page> {
  const queue = [...script];
  fake = await startFakeProvider({
    key: KEY,
    models: [
      { id: "coder", name: "Coder", supported_parameters: ["tools"], ...(sees ? { architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } } : {}) },
      { id: "planner", name: "Planner", supported_parameters: ["tools"] },
    ],
    // A model that sees answers the look at a screenshot itself; the rest follows the script.
    respond: (body) => (sees && JSON.stringify(body.messages).includes("data:image/png;base64,") && !body.tools ? { text: "Да, видно." } : (queue.shift() ?? { text: "Готово." })),
  });
  app = await electron.launch({ args: [mainJs], env: { ...process.env, DRIMVOX_USER_DATA: userData, DRIMVOX_TEST_PICK_FOLDER: repo } });
  const page = await app.firstWindow();
  await expect(paramsButton(page)).toBeVisible();
  await openSection(page, "Ключи и модели");
  await page.getByRole("radio", { name: /OpenAI-совместимый/ }).click();
  await page.getByLabel("Адрес API").fill(fake.baseUrl);
  await page.getByLabel("Ключ API, если нужен").fill(KEY);
  await page.getByRole("button", { name: "Подключить", exact: true }).click();
  await expect(page.getByText("Моделей: 2")).toBeVisible();
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

  await addProject(page);
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
  // Told apart, each stage keeps its own pick (seen: the first pick overwrote the other two).
  await models.getByRole("button", { name: /Coder/ }).first().click();
  await page.getByRole("option", { name: /Planner/ }).click();
  await expect(models.getByRole("button", { name: /Planner/ })).toHaveCount(1);
  await expect(models.getByRole("button", { name: /Coder/ })).toHaveCount(2);
  // What was typed and picked stays through a visit to the parameters (seen: it was gone).
  await page.locator(".side-nav").getByRole("button", { name: "Параметры", exact: true }).click();
  await page.getByRole("button", { name: "Назад" }).click();
  await expect(page.getByLabel("Что сделать?")).toHaveValue("Сайт лесопилки");
  await expect(models.getByRole("button", { name: /Planner/ })).toHaveCount(1);
  await expect(models.getByRole("button", { name: /Coder/ })).toHaveCount(2);
  // Asked for: a small task in an existing project skips the interview; switched back, the interview it is.
  const quick = page.getByRole("switch", { name: "Небольшая задача в готовом проекте" });
  await quick.check({ force: true });
  await expect(page.getByRole("button", { name: "Составить план" })).toBeVisible();
  await quick.uncheck({ force: true });
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
  // The project comes first in the panel (asked for), what came of the work last.
  await expect(result.getByRole("tab").first()).toHaveText("Проект");
  await result.getByRole("tab", { name: "Результат" }).click();
  await expect(result.locator(".work-report")).toContainText("Каталог готов");
  await result.getByRole("tab", { name: "Изменения" }).click();
  await expect(result.locator(".diff")).toContainText("index.html");
  // The handle is taken anywhere along its strip, and the grip comes to where it was taken (asked for).
  const strip = page.locator(".workshop-body > .workshop-split");
  const box = (await strip.boundingBox())!;
  const before = (await page.locator("#workshop-result").boundingBox())!.width;
  await page.mouse.move(box.x + box.width / 2, box.y + 120);
  await page.mouse.down();
  await page.mouse.move(box.x - 120, box.y + 120, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await page.locator("#workshop-result").boundingBox())!.width).toBeGreaterThan(before + 60);
  const grip = page.getByRole("button", { name: "Скрыть панель результата" });
  expect(Math.abs((await grip.boundingBox())!.y + 22 - (box.y + 120))).toBeLessThan(10);
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
  // An answer closes the question's note over the box (seen: it stayed after the reply).
  await page.locator(".side-project").first().click();
  await expect(page.locator(".work-questions-note")).toContainText("Нужна доставка?");
  await page.getByPlaceholder("Напиши агенту — он учтёт на ходу").fill("Доставка нужна");
  await page.getByPlaceholder("Напиши агенту — он учтёт на ходу").press("Enter");
  await expect(page.locator(".work-questions-note")).toHaveCount(0);
});

// Asked for: a ready project works like the chat (no interview, no plan to approve) with the agent's plan on the left;
// the project comes first on the right, and removing it is at hand in the sidebar's "⋯".
test("a ready project: asked on adding, talked to as in a chat, its plan on the left, removed from the sidebar", async () => {
  const page = await launch([
    call("update_checklist", { items: [{ text: "Прочитать README", done: true }, { text: "Ответить", done: false }] }),
    { text: "Это сайт лесопилки." },
  ]);
  await page.getByRole("button", { name: "Проекты", exact: true }).click();
  await page.getByRole("button", { name: "+ Проект" }).click();
  const dialog = page.getByRole("dialog", { name: "Какой это проект?" });
  // The folder has a README: Drimvox guesses a ready project and picks it.
  await expect(dialog).toContainText("похоже на готовый проект");
  await expect(dialog.getByRole("radio", { name: /^Готовый проект/ })).toHaveAttribute("aria-checked", "true");
  await dialog.getByRole("button", { name: "Продолжить" }).click();

  await expect(page.getByRole("heading", { name: "Что сделать в проекте?" })).toBeVisible();
  await expect(page.getByLabel("Что сделать?")).toHaveCount(0);
  await page.getByRole("button", { name: "Выбери модель" }).click();
  await page.getByRole("option", { name: /Coder/ }).click();
  await page.getByPlaceholder("Вопрос или задача по проекту").fill("Что это за проект?");
  await page.getByPlaceholder("Вопрос или задача по проекту").press("Enter");

  await expect(page.locator(".timeline .msg-user")).toContainText("Что это за проект?");
  await expect(page.locator(".timeline")).toContainText("Это сайт лесопилки.", { timeout: 30_000 });
  await expect(page.getByRole("list", { name: "План агента" })).toContainText("Прочитать README");
  // No plan or questions tabs: the conversation is the whole middle.
  await expect(page.getByRole("tab", { name: "Ход работы" })).toHaveCount(0);
  const result = page.getByRole("complementary", { name: "Результат" });
  await expect(result.getByRole("tab").first()).toHaveText("Проект");
  await expect(result.getByRole("button", { name: "Готовый проект" })).toHaveAttribute("aria-pressed", "true");
  await expect(result.getByRole("button", { name: "Убрать из Drimvox…" })).toBeVisible();
  // The next message goes on in the same conversation, still with a model to pick under the box.
  await expect(page.locator(".workshop-feed .composer-bar").getByRole("button", { name: /coder/i })).toBeVisible();

  // The open project shows its "⋯" without hovering.
  const menu = page.getByRole("button", { name: /Действия с проектом/ });
  await expect(menu).toBeVisible();
  await menu.click();
  await page.getByRole("menuitem", { name: "Убрать из Drimvox…" }).click();
  await page.locator(".side-projects .danger-zone").getByRole("button", { name: "Убрать проект из Drimvox" }).click();
  await expect(page.getByRole("heading", { name: "Над чем поработаем?" })).toBeVisible();
  await expect(page.locator(".side-project")).toHaveCount(0);
  expect(readFileSync(join(repo, "README.md"), "utf8")).toContain("Лесопилка");
});

// Asked for: many screenshots are gone through with a switch, not opened and closed one by one; the result panel has none
// (they read as the result); the folder's changes are listed folded, each file opened on its own.
test("a run's screenshots: a switch in the timeline, none in the result panel; changes folded by file", async () => {
  // Two real looks at a page, each loading it afresh.
  test.setTimeout(90_000);
  const site = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<body style="margin:0"><h1>${req.url === "/b" ? "Вторая" : "Первая"}</h1><div style="height:2400px"></div></body>`);
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const port = (site.address() as AddressInfo).port;
  try {
    const page = await launch(
      [
        call("ask_questions", { questions: [], understood: "Сайт", unknown: [] }),
        call("write_plan", { summary: "Две страницы.", steps: ["Страницы"], checks: [], pages: [] }),
        call("write_file", { path: "index.html", content: "<h1>Первая</h1>\n" }),
        call("look_at_page", { url: `http://localhost:${port}/a`, question: "Видна первая?" }),
        call("look_at_page", { url: `http://localhost:${port}/b`, question: "Видна вторая?" }),
        call("update_checklist", { items: [{ text: "Страницы", done: true }] }),
        call("finish_work", { report: "Готово." }),
        { text: "Готово." },
      ],
      true,
    );
    await page.getByRole("button", { name: "Проекты", exact: true }).click();
    await addProject(page);
    await page.getByLabel("Что сделать?").fill("Две страницы");
    await page.getByRole("group", { name: "Модели" }).getByRole("button", { name: "Выбери модель" }).first().click();
    await page.getByRole("option", { name: /Coder/ }).click();
    await page.getByRole("button", { name: "Начать опрос" }).click();
    await page.getByRole("region", { name: "Итоговый план" }).getByRole("button", { name: "Начать работу" }).click({ timeout: 30_000 });
    await expect(page.locator(".topbar").getByRole("status")).toContainText("Готово", { timeout: 30_000 });

    // The timeline: a screenshot opens over the window, the arrows go to the next one.
    await page.locator(".timeline .msg-shot").first().click();
    const gallery = page.getByRole("dialog", { name: "Скриншоты" });
    await expect(gallery).toContainText("1 из 2");
    await expect(gallery).toContainText(`localhost:${port}/a`);
    await page.keyboard.press("ArrowRight");
    await expect(gallery).toContainText("2 из 2");
    await expect(gallery).toContainText(`localhost:${port}/b`);
    await gallery.getByRole("tab", { name: "1 из 2" }).click();
    await expect(gallery).toContainText("1 из 2");
    await page.keyboard.press("Escape");
    await expect(gallery).toHaveCount(0);

    // The result panel shows what came of the work, not the screenshots: they stay in the timeline.
    const result = page.getByRole("complementary", { name: "Результат" });
    await result.getByRole("tab", { name: "Результат" }).click();
    await expect(result.locator(".work-report")).toContainText("Готово.");
    await expect(result.locator("img")).toHaveCount(0);

    // The changes: each file folded until opened.
    await result.getByRole("tab", { name: "Изменения" }).click();
    const file = result.getByRole("button", { name: "Показать изменения в index.html" });
    await expect(file).toHaveAttribute("aria-expanded", "false");
    await expect(result.locator(".diff-hunk")).toHaveCount(0);
    await file.click();
    await expect(result.locator(".diff-hunk")).toContainText("Первая");
  } finally {
    // The window keeps its connections to the page open: they are cut, or closing waits for them.
    site.closeAllConnections();
    await new Promise((done) => site.close(done));
  }
});
