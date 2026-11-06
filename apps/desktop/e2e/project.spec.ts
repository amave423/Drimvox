import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  writeFileSync(join(repo, "README.md"), "# Клиника\n");
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
  // A process the run started lets go of the folder a moment after it is stopped (Windows).
  rmSync(repo, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const call = (name: string, args: Record<string, unknown>): FakeTurn => ({ toolCalls: [{ name, args }] });

/** How many programs on this computer have this text in their command line (Windows and elsewhere). */
function runningCopies(text: string): number {
  const out =
    process.platform === "win32"
      ? execFileSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }"], { encoding: "utf8" })
      : execFileSync("ps", ["-eo", "args"], { encoding: "utf8" });
  return out.split(/\r?\n/).filter((line) => line.includes(text) && !line.includes("Get-CimInstance")).length;
}

async function launch(script: FakeTurn[], sees = false): Promise<Page> {
  const queue = [...script];
  fake = await startFakeProvider({
    key: KEY,
    models: [
      {
        id: "coder",
        name: "Coder",
        supported_parameters: ["tools"],
        ...(sees ? { architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } } : {}),
      },
      { id: "planner", name: "Planner", supported_parameters: ["tools"] },
    ],
    // A model that sees answers the look at a screenshot itself; the rest follows the script.
    respond: (body) =>
      sees && JSON.stringify(body.messages).includes("data:image/png;base64,") && !body.tools ? { text: "Да, видно." } : (queue.shift() ?? { text: "Готово." }),
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

/** Picks the fake provider's Coder in the open model list: a local Ollama on the computer may be listed first. */
async function pickCoder(page: Page, opener = page.getByRole("button", { name: "Выбери модель" })): Promise<void> {
  await opener.click();
  const tabs = page.getByRole("navigation", { name: "Провайдеры" });
  if (await tabs.count()) await tabs.getByRole("button", { name: new URL(fake!.baseUrl).host }).click();
  await page.getByRole("option", { name: /Coder/ }).click();
}

/** Turns the interview and/or the plan on in the box's options, as the user does before the first message. */
async function askFirst(page: Page, o: { interview?: boolean; plan?: boolean }): Promise<void> {
  await page
    .locator(".composer")
    .getByRole("button", { name: /^Параметры/ })
    .click();
  const options = page.getByRole("dialog", { name: "Параметры" });
  // The switch's own box is drawn over by its track: the label is what is clicked.
  if (o.interview) await options.getByText(/^Сначала пара вопросов/).click();
  if (o.plan) await options.getByText(/^План на утверждение/).click();
  if (o.interview) await expect(options.getByRole("switch", { name: /Сначала пара вопросов/ })).toBeChecked();
  if (o.plan) await expect(options.getByRole("switch", { name: /План на утверждение/ })).toBeChecked();
}

// docs/specs/project-work.md: one conversation per project; the interview and the plan with "Go" when the box asks for
// them, their own model, then one long run with its checklist in the sidebar.
test("a project: the interview, the plan with Go, the agent works alone with its checklist, a message on the way", async () => {
  const page = await launch([
    call("ask_questions", { questions: [], understood: "Сайт клиники", unknown: [] }),
    call("write_plan", { summary: "Сайт клиники с онлайн-записью.", steps: ["Онлайн-запись", "Проверить страницу"], checks: [], pages: [] }),
    { ...call("write_file", { path: "index.html", content: "<h1>Запись</h1>\n" }), delayMs: 1500 },
    call("ask_user", { question: "Нужна доставка?", assumption: "Пока без доставки" }),
    call("update_checklist", {
      items: [
        { text: "Онлайн-запись", done: true },
        { text: "Проверить страницу", done: true },
      ],
    }),
    call("finish_work", { report: "Каталог готов: откройте index.html." }),
    { text: "Каталог готов: откройте index.html." },
  ]);

  await page.getByRole("button", { name: "Проекты", exact: true }).click();

  await addProject(page);
  // No kind to choose: the project's conversation at once, its box with the model and the options.
  await expect(page.getByRole("heading", { name: "Что сделать в проекте?" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Выбери модель" }).click();
  // The list opens whole inside the window, not cut by the workshop's column (seen).
  const list = await page.locator(".model-panel").boundingBox();
  const view = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  expect(list!.x).toBeGreaterThanOrEqual(0);
  expect(list!.x + list!.width).toBeLessThanOrEqual(view.width);
  expect(await page.locator(".workshop-main").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await pickCoder(page);
  // The interview and the plan are asked for in the options; their model, the strong one and the thinking are there too.
  await askFirst(page, { interview: true, plan: true });
  const options = page.getByRole("dialog", { name: "Параметры" });
  await expect(options).toContainText("Сильная модель");
  await expect(options).toContainText("Мышление");
  // The interview and the plan each have a model of their own (asked for), the working one until picked.
  await expect(options).toContainText("Модель опроса");
  await expect(options).toContainText("Модель плана");
  await expect(options.getByRole("button", { name: /Coder/ })).toHaveCount(2);
  await options.getByRole("button", { name: /Coder/ }).first().click();
  await page.getByRole("option", { name: /Planner/ }).click();
  await expect(options.getByRole("button", { name: /Planner/ })).toHaveCount(1);
  await expect(options.getByRole("button", { name: "Как рабочая" })).toBeVisible();
  await page.keyboard.press("Escape");
  // What was picked shows on the options' button.
  await expect(page.locator(".composer").getByRole("button", { name: /^Параметры/ })).toHaveAccessibleName(/Опрос, План/);
  await page.getByPlaceholder("Вопрос или задача по проекту").fill("Сайт клиники");
  await page.getByPlaceholder("Вопрос или задача по проекту").press("Enter");

  // The plan comes right under the interview: read it, then "Go".
  const plan = page.getByRole("region", { name: "Итоговый план" });
  await expect(plan).toContainText("Сайт клиники с онлайн-записью.", { timeout: 30_000 });
  await expect(plan.getByRole("listitem")).toHaveText(["Онлайн-запись", "Проверить страницу"]);
  // In the conversation, as in the agreed design: the plan is a card on the timeline, the box below corrects it.
  await expect(page.locator(".timeline .planning-card.is-plan")).toBeVisible();
  await expect(page.getByPlaceholder("Что поправить в плане")).toBeVisible();
  await plan.getByRole("button", { name: "Начать работу" }).click();

  // The workshop: the run's timeline with the plan as its first message, the state in the top bar, the checklist in
  // the sidebar.
  await expect(page.locator(".timeline .msg-user").first()).toContainText("Онлайн-запись");
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
  // The interview was the planner's; the plan and the work are the working model's.
  const asked = fake!.requests.filter((r) => r.path.endsWith("/chat/completions")).map((r) => (r.body as { model?: string }).model);
  expect(asked[0]).toBe("planner");
  expect(asked.at(-1)).toBe("coder");
  // The file written stands where it was written, with its lines (asked for), and opens to look at.
  const chip = page.locator(".timeline .file-chips.is-inline .file-chip", { hasText: "index.html" });
  await expect(chip).toContainText("+1");
  await chip.click();
  await expect(page.getByRole("dialog", { name: "index.html" })).toContainText("Запись");
  await page.keyboard.press("Escape");
  // No tabs over the conversation, no changes tab on the right: the project first, then what came of the work.
  await expect(page.getByRole("tab", { name: "Ход работы" })).toHaveCount(0);
  const result = page.getByRole("complementary", { name: "Результат" });
  await expect(result.getByRole("tab")).toHaveText(["Проект", "Результат"]);
  await result.getByRole("tab", { name: "Результат" }).click();
  await expect(result.locator(".work-report")).toContainText("Каталог готов");
  // The edge beside the panel has no grip (asked for): dragged it sets the width, double-clicked it folds and opens.
  const strip = page.locator(".workshop-body > .workshop-split");
  await expect(strip.locator("button")).toHaveCount(0);
  expect(await strip.evaluate((el) => getComputedStyle(el).cursor)).toBe("w-resize");
  const box = (await strip.boundingBox())!;
  const before = (await page.locator("#workshop-result").boundingBox())!.width;
  await page.mouse.move(box.x + box.width / 2, box.y + 120);
  await page.mouse.down();
  await page.mouse.move(box.x - 120, box.y + 120, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await page.locator("#workshop-result").boundingBox())!.width).toBeGreaterThan(before + 60);
  await expect(strip).toHaveAttribute("aria-label", "Скрыть панель результата");
  await strip.dblclick();
  await expect(result).toBeHidden();
  await expect(strip).toHaveAttribute("aria-label", "Показать панель результата");
  await strip.dblclick();
  await expect(result).toBeVisible();
  // The double click selects nothing beside the edge (seen: the result panel's words lit up).
  expect(await page.evaluate(() => getSelection()?.toString() ?? "")).toBe("");
  // Done, the box asks for the next question or task; while the agent works it says the message is taken on the way.
  await expect(page.getByPlaceholder("Вопрос или задача по проекту")).toBeVisible();
  // Chats are the other mode: the workshop comes back with the project opened last.
  await page.getByRole("button", { name: "Чат", exact: true }).click();
  await expect(page.locator(".workshop")).toHaveCount(0);
  await page.getByRole("button", { name: "Проекты", exact: true }).click();
  await expect(page.locator(".topbar .crumb")).toHaveText(/drimvox-repo-/);
  // The mark leads to the projects' start, not to the chats.
  await page.locator(".topbar .logo").click();
  await expect(page.getByRole("heading", { name: "Над чем поработаем?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Проекты", exact: true })).toHaveAttribute("aria-pressed", "true");
  // The sidebar has an edge of its own: it folds away and comes back.
  await page.getByRole("separator", { name: "Скрыть боковую панель" }).dblclick();
  await expect(page.locator("#sidebar")).toBeHidden();
  await page.getByRole("separator", { name: "Показать боковую панель" }).dblclick();
  await expect(page.locator("#sidebar")).toBeVisible();
  expect(readFileSync(join(repo, "index.html"), "utf8")).toContain("Запись");
  // By the default git rules the work is in a branch of the agent's own; main stays as it was.
  expect(execFileSync("git", ["branch", "--show-current"], { cwd: repo, encoding: "utf8" }).trim()).toMatch(/^drimvox\/task-/);
  expect(execFileSync("git", ["log", "--oneline", "main"], { cwd: repo, encoding: "utf8" }).trim().split("\n")).toHaveLength(1);
  expect(fake!.requests.some((r) => JSON.stringify(r.body?.messages ?? []).includes("Сделай заголовок крупнее"))).toBe(true);
  // An answer closes the question's note over the box (seen: it stayed after the reply).
  await page.locator(".side-project").first().click();
  await expect(page.locator(".work-questions-note")).toContainText("Нужна доставка?");
  await page.getByPlaceholder("Вопрос или задача по проекту").fill("Доставка нужна");
  await page.getByPlaceholder("Вопрос или задача по проекту").press("Enter");
  await expect(page.locator(".work-questions-note")).toHaveCount(0);
});

// Asked for: a project is talked to like a chat (no interview, no plan to approve unless asked) with the agent's plan on
// The agreed design (variant A, asked for: the questions and the plan opened as pages of their own): the questions as a
// card of choices in the conversation, the answers as the user's message, the plan as a card below them.
test("the interview's questions and the plan are cards in the project's conversation", async () => {
  const page = await launch([
    call("ask_questions", {
      questions: [
        { id: "city", question: "Какой город показывать сразу?", options: [{ label: "Мой по геолокации" }, { label: "Москва" }], recommended: 0 },
        { id: "style", question: "Стиль", options: [{ label: "Тёмный, как приборы" }, { label: "Меняется с погодой" }], recommended: 1 },
      ],
      understood: "Сайт погоды",
      unknown: [],
    }),
    // The answers start the next round: nothing more to ask, then the plan.
    call("ask_questions", { questions: [], understood: "Сайт погоды", unknown: [] }),
    call("write_plan", { summary: "Сайт погоды с живыми данными.", steps: ["Каркас и данные", "Анимированные сцены"], checks: [], pages: [] }),
  ]);
  await page.getByRole("button", { name: "Проекты", exact: true }).click();
  await addProject(page);
  await pickCoder(page);
  await askFirst(page, { interview: true, plan: true });
  await page.keyboard.press("Escape");
  await page.getByPlaceholder("Вопрос или задача по проекту").fill("Сайт погоды");
  await page.getByPlaceholder("Вопрос или задача по проекту").press("Enter");
  const questions = page.locator(".timeline").getByRole("region", { name: "Вопросы" });
  await expect(questions).toContainText("Какой город показывать сразу?", { timeout: 30_000 });
  // The recommended answers are picked already; another is a click.
  await expect(questions.getByRole("radio", { name: "Меняется с погодой" })).toHaveAttribute("aria-checked", "true");
  await questions.getByRole("radio", { name: "Москва" }).click();
  await expect(page.locator(".timeline .msg-user").first()).toHaveText("Сайт погоды");
  await questions.getByRole("button", { name: "Ответить" }).click();
  await expect(page.locator(".timeline .msg-user", { hasText: "Москва · Меняется с погодой" })).toBeVisible({ timeout: 30_000 });
  const plan = page.locator(".timeline").getByRole("region", { name: "Итоговый план" });
  await expect(plan).toContainText("Сайт погоды с живыми данными.", { timeout: 30_000 });
  await expect(plan.getByRole("listitem")).toHaveText(["Каркас и данные", "Анимированные сцены"]);
  await expect(plan.getByRole("button", { name: "Начать работу" })).toBeVisible();
  // "Correct the plan" goes to the box below, which now corrects it.
  await plan.getByRole("button", { name: "Поправить план" }).click();
  await expect(page.getByPlaceholder("Что поправить в плане")).toBeFocused();
});

// the left; the project comes first on the right, and removing it is at hand in the sidebar's "⋯".
test("a project without the interview: talked to as in a chat, its plan on the left, removed from the sidebar", async () => {
  const page = await launch([
    call("update_checklist", {
      items: [
        { text: "Прочитать README", done: true },
        { text: "Ответить", done: false },
      ],
    }),
    { text: "Это сайт клиники." },
  ]);
  await page.getByRole("button", { name: "Проекты", exact: true }).click();
  await addProject(page);
  await expect(page.getByRole("heading", { name: "Что сделать в проекте?" })).toBeVisible();
  await expect(page.getByLabel("Что сделать?")).toHaveCount(0);
  await pickCoder(page);
  await page.getByPlaceholder("Вопрос или задача по проекту").fill("Что это за проект?");
  await page.getByPlaceholder("Вопрос или задача по проекту").press("Enter");

  await expect(page.locator(".timeline .msg-user")).toContainText("Что это за проект?");
  await expect(page.locator(".timeline")).toContainText("Это сайт клиники.", { timeout: 30_000 });
  await expect(page.getByRole("list", { name: "План агента" })).toContainText("Прочитать README");
  // No plan or questions tabs: the conversation is the whole middle.
  await expect(page.getByRole("tab", { name: "Ход работы" })).toHaveCount(0);
  const result = page.getByRole("complementary", { name: "Результат" });
  await expect(result.getByRole("tab").first()).toHaveText("Проект");
  // No kind any more, said or switched (asked for).
  await expect(result.locator(".project-kind-switch, .project-kind-fixed")).toHaveCount(0);
  // Removing is in the sidebar's "⋯" only (asked for: the frame in the project tab went).
  await expect(result.getByRole("button", { name: "Убрать из Drimvox…" })).toHaveCount(0);
  // Git by the project's rules: the agent's branch, accepted into main from the project's tab.
  const rules = result.getByRole("region", { name: "Git: как работает агент" });
  await expect(rules.getByRole("button", { name: "Куда пишет" })).toHaveText(/Своя ветка на задачу/);
  await expect(rules.getByRole("button", { name: "Когда коммитит" })).toHaveText(/После каждого пункта плана/);
  // The lists are Drimvox's own, not the browser's square ones (asked for).
  await rules.getByRole("button", { name: "Сообщения" }).click();
  await expect(rules.getByRole("listbox", { name: "Сообщения" }).getByRole("option")).toHaveCount(4);
  await rules.getByRole("option", { name: "Коротко, по-русски" }).click();
  await expect(rules.getByRole("button", { name: "Сообщения" })).toHaveText(/Коротко, по-русски/);
  const branch = result.getByRole("region", { name: "Ветка агента" });
  await expect(branch).toContainText("→ main");
  await branch.getByRole("button", { name: "Принять" }).click();
  await expect(branch).toHaveCount(0);
  expect(execFileSync("git", ["branch", "--show-current"], { cwd: repo, encoding: "utf8" }).trim()).toBe("main");
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
  expect(readFileSync(join(repo, "README.md"), "utf8")).toContain("Клиника");
});

// Seen live: after Continue the bar said the agent works, and the timeline stayed still until the user wrote again.
test("a stopped project goes on with Continue, and the timeline shows the answer without a message", async () => {
  const long = Array.from({ length: 60 }, (_, i) => `Строка отчёта ${i + 1}.`).join("\n\n");
  const page = await launch([{ text: "Начинаю долгую работу.", delayMs: 8000 }, { text: `Продолжаю с того места.\n\n${long}` }]);
  await page.getByRole("button", { name: "Проекты", exact: true }).click();
  await addProject(page);
  await pickCoder(page);
  await page.getByPlaceholder("Вопрос или задача по проекту").fill("Сделай сайт");
  await page.getByPlaceholder("Вопрос или задача по проекту").press("Enter");
  const bar = page.locator(".workshop-bar-top");
  // Stopped once the model is asked for real: the slow first answer is the one cut.
  await expect.poll(() => fake!.requests.filter((r) => r.path.endsWith("/chat/completions")).length).toBe(1);
  await bar.getByRole("button", { name: "Стоп" }).click();
  await bar.getByRole("button", { name: "Продолжить" }).click();
  await expect(page.locator(".timeline")).toContainText("Продолжаю с того места.", { timeout: 30_000 });
  await expect(page.locator(".timeline .msg-user")).toHaveCount(2);
  // What the tokens went to, beside the work (asked for: as a chat shows its context).
  const tokens = page.getByRole("region", { name: "Контекст и токены" });
  await expect(tokens).toContainText("Прочитано моделью");
  await expect(tokens).toContainText("Написано моделью");
  await expect(tokens).toContainText("из них из кэша");

  // Opened again, the project shows its latest messages, not its first (seen live: it opened at the very top).
  await page.getByRole("button", { name: "Чат", exact: true }).click();
  await page.getByRole("button", { name: "Проекты", exact: true }).click();
  await page.locator(".side-project").first().click();
  await expect(page.locator(".timeline")).toContainText("Строка отчёта 60.");
  const atBottom = () =>
    page.locator(".workshop-feed").evaluate((el) => el.scrollHeight > el.clientHeight + 200 && el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  await expect.poll(atBottom).toBe(true);

  // The next task in a new conversation (said in a video on agents: late requests in a long one cost several times more).
  await page.getByRole("region", { name: "Контекст и токены" }).getByRole("button", { name: "Начать с чистого контекста" }).click();
  await expect(page.getByRole("heading", { name: "Что сделать в проекте?" })).toBeVisible();
  await expect(page.locator(".timeline")).toHaveCount(0);
});

// Seen live: project folders renamed, and every project asked to turn git on again.
// Asked for: what runs in the background is seen and can be stopped (seen live: two servers on one port).
test("shows what runs in the background beside the browser, and stops it", async () => {
  const server = 'node -e "setInterval(() => {}, 1000)"';
  const page = await launch([call("start_background", { command: server }), { text: "Сервер запущен." }]);
  await page.getByRole("button", { name: "Проекты", exact: true }).click();
  await addProject(page);
  await pickCoder(page);
  await page.getByPlaceholder("Вопрос или задача по проекту").fill("Запусти сайт");
  await page.getByPlaceholder("Вопрос или задача по проекту").press("Enter");
  await expect(page.locator(".timeline")).toContainText("Сервер запущен.", { timeout: 30_000 });
  const button = page.getByRole("button", { name: "Процессы · 1" });
  await expect(button).toBeVisible({ timeout: 10_000 });
  await button.click();
  const panel = page.getByRole("dialog", { name: "Запущено в фоне" });
  await expect(panel).toContainText("агент проекта");
  await expect(panel.locator(".processes-command")).toHaveText(server);
  await panel.getByRole("button", { name: "Остановить" }).click();
  await expect(panel).toContainText("Ничего не запущено.", { timeout: 10_000 });
  // Stopped for real, the program it started too (seen: the shell went and its node stayed, holding the port).
  await expect.poll(() => runningCopies("setInterval(() => {}, 1000)"), { timeout: 10_000 }).toBe(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /^Процессы/ })).toHaveCount(0);
});

test("a project whose folder is gone asks where it is now, and goes on there", async () => {
  const page = await launch([]);
  await page.getByRole("button", { name: "Проекты", exact: true }).click();
  await addProject(page);
  await expect(page.getByRole("heading", { name: "Что сделать в проекте?" })).toBeVisible();
  const moved = `${repo}-moved`;
  // The project opens at once now: git may still hold the folder for a moment after adding it (Windows).
  await expect
    .poll(() => {
      try {
        renameSync(repo, moved);
        return true;
      } catch {
        return false;
      }
    })
    .toBe(true);
  try {
    await page.getByRole("button", { name: "Чат", exact: true }).click();
    await page.getByRole("button", { name: "Проекты", exact: true }).click();
    await page.locator(".side-project").first().click();
    await expect(page.getByRole("heading", { name: "Папка проекта не найдена" })).toBeVisible();
    await expect(page.locator(".workshop-pill")).toHaveText("Папка не найдена");
  } finally {
    // The folder picker of the tests answers with the first place.
    renameSync(moved, repo);
  }
  await page.getByRole("button", { name: "Указать папку…" }).click();
  await expect(page.getByRole("heading", { name: "Что сделать в проекте?" })).toBeVisible();
});

// Asked for: many screenshots are gone through with a switch, not opened and closed one by one; the result panel has none
// (they read as the result).
test("a run's screenshots: a switch in the timeline, none in the result panel", async () => {
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
    await pickCoder(page);
    await askFirst(page, { interview: true });
    await page.keyboard.press("Escape");
    await page.getByPlaceholder("Вопрос или задача по проекту").fill("Две страницы");
    await page.getByPlaceholder("Вопрос или задача по проекту").press("Enter");
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
  } finally {
    // The window keeps its connections to the page open: they are cut, or closing waits for them.
    site.closeAllConnections();
    await new Promise((done) => site.close(done));
  }
});
