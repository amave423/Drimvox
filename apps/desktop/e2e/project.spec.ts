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
async function pickCoder(page: Page, opener = page.locator(".composer").getByRole("button", { name: "Выбери модель" })): Promise<void> {
  await opener.click();
  const tabs = page.getByRole("navigation", { name: "Провайдеры" });
  if (await tabs.count()) await tabs.getByRole("button", { name: new URL(fake!.baseUrl).host }).click();
  await page.getByRole("option", { name: /Coder/ }).click();
}

// docs/specs/project-work.md: one conversation per project, no interview and plan switches (asked for); the agent asks
// what only the user can decide with a card of answers to pick, as OpenCode does, and goes on with the answer.
test("a project: the agent's question as a card, the picked answer, the same conversation goes on, a message on the way", async () => {
  const page = await launch([
    call("question", { questions: [{ question: "Запись по телефону или онлайн?", header: "Запись", options: [{ label: "Онлайн", description: "форма на сайте" }, { label: "По телефону" }] }] }),
    { ...call("write_file", { path: "index.html", content: "<h1>Запись</h1>\n" }), delayMs: 1500 },
    { text: "Каталог готов: откройте index.html." },
  ]);

  await page.getByRole("button", { name: "Проекты", exact: true }).click();

  await addProject(page);
  // No kind to choose: the project's conversation at once, its box with the model and the options.
  await expect(page.getByRole("heading", { name: "Что сделать в проекте?" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.locator(".composer").getByRole("button", { name: "Выбери модель" }).click();
  // The list opens whole inside the window, not cut by the workshop's column (seen).
  const list = await page.locator(".model-panel").boundingBox();
  const view = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  expect(list!.x).toBeGreaterThanOrEqual(0);
  expect(list!.x + list!.width).toBeLessThanOrEqual(view.width);
  expect(await page.locator(".workshop-main").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await pickCoder(page);
  // They are in the parameters on the right (asked for: not a pop-up under the box).
  await expect(page.locator(".composer").getByRole("button", { name: /^Параметры/ })).toHaveCount(0);
  const options = page.getByRole("region", { name: "Параметры" });
  await expect(options).toContainText("Сильная модель");
  await expect(options).toContainText("Мышление");
  // No interview and plan switches (asked for): the agent asks when it must.
  await expect(options).not.toContainText("Опрос");
  await expect(options).not.toContainText("План на утверждение");
  // The strong model is a switch with its hint, its model chosen once it is on.
  await expect(options.getByRole("switch", { name: /Если рабочая модель застрянет/ })).not.toBeChecked();
  await options.getByText(/^Если рабочая модель застрянет/).click();
  await expect(options.getByRole("switch", { name: /Если рабочая модель застрянет/ })).toBeChecked();
  await expect(options.getByRole("button", { name: "Выбери модель" })).toHaveCount(1);
  await options.getByText(/^Если рабочая модель застрянет/).click();
  // The model for screenshots and the service model are the project's too, switches with their hints.
  await expect(options).toContainText("Модель для зрения");
  await expect(options.getByRole("switch", { name: /Подагенты, сводки длинной истории/ })).not.toBeChecked();
  await page.getByPlaceholder("Вопрос или задача по проекту").fill("Сайт клиники");
  await page.getByPlaceholder("Вопрос или задача по проекту").press("Enter");

  // The question is a card with answers to pick and a field for one's own; the run waits on it.
  const card = page.getByRole("region", { name: "Агент спрашивает" });
  await expect(card).toContainText("Запись по телефону или онлайн?", { timeout: 30_000 });
  await expect(card.getByPlaceholder("Свой ответ")).toBeVisible();
  await expect(card.getByRole("button", { name: "Ответить" })).toBeDisabled();
  await card.getByRole("button", { name: /Онлайн/ }).click();
  await card.getByRole("button", { name: "Ответить" }).click();
  await expect(card).toHaveCount(0);

  // The state is on the project in the sidebar only.
  await expect(page.locator(".timeline .msg-user").first()).toContainText("Сайт клиники");
  await expect(page.locator(".topbar").getByRole("status")).toHaveCount(0);
  const state = page.locator(".side-project.is-on").getByRole("status");
  await expect(state).toContainText("работает");
  // A message while it works goes in at once and the agent takes it on the way.
  await page.getByPlaceholder("Напиши агенту — он учтёт на ходу").fill("Сделай заголовок крупнее");
  await page.getByPlaceholder("Напиши агенту — он учтёт на ходу").press("Enter");
  await expect(page.locator(".msg-user", { hasText: "Сделай заголовок крупнее" })).toBeVisible();

  await expect(state).toContainText("готово", { timeout: 30_000 });
  // No checklist any more (asked for).
  await expect(page.getByRole("list", { name: "Чек-лист" })).toHaveCount(0);
  // The file written stands where it was written, with its lines (asked for), and opens to look at.
  const chip = page.locator(".timeline .file-chips.is-inline .file-chip", { hasText: "index.html" });
  await expect(chip).toContainText("+1");
  await chip.click();
  await expect(page.getByRole("dialog", { name: "index.html" })).toContainText("Запись");
  await page.keyboard.press("Escape");
  // No tabs anywhere: the report is the agent's own last message and stays there (asked for: a card at the end vanished
  // with the next message), the right side holds the context and the parameters.
  await expect(page.getByRole("tab", { name: "Ход работы" })).toHaveCount(0);
  await expect(page.locator(".timeline").getByRole("region", { name: "Результат" })).toHaveCount(0);
  await expect(page.locator(".timeline")).toContainText("Каталог готов");
  // The run's time and money are in the context window (asked for: not in the top bar).
  await expect(page.getByRole("region", { name: "Контекст и токены" })).toContainText("Время работы");
  const result = page.getByRole("complementary", { name: "Контекст и параметры" });
  await expect(result.getByRole("tab")).toHaveCount(0);
  await expect(result.getByRole("region", { name: "Параметры" })).toBeVisible();
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
  await expect(strip).toHaveAttribute("aria-label", "Скрыть панель контекста и параметров");
  await strip.dblclick();
  await expect(result).toBeHidden();
  await expect(strip).toHaveAttribute("aria-label", "Показать панель контекста и параметров");
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
  // The work is committed in the branch the project is on, in the user's name: no branch of the agent's own (asked for).
  expect(execFileSync("git", ["branch", "--show-current"], { cwd: repo, encoding: "utf8" }).trim()).toBe("main");
  expect(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim()).toBe("");
  expect(fake!.requests.some((r) => JSON.stringify(r.body?.messages ?? []).includes("Сделай заголовок крупнее"))).toBe(true);
});

// Asked for: a project is talked to like a chat (no plan to approve unless asked); removing it is in the sidebar's "⋯".
test("a project without a plan: talked to as in a chat, removed from the sidebar", async () => {
  const page = await launch([{ text: "Это сайт клиники." }]);
  await page.getByRole("button", { name: "Проекты", exact: true }).click();
  await addProject(page);
  await expect(page.getByRole("heading", { name: "Что сделать в проекте?" })).toBeVisible();
  await expect(page.getByLabel("Что сделать?")).toHaveCount(0);
  await pickCoder(page);
  await page.getByPlaceholder("Вопрос или задача по проекту").fill("Что это за проект?");
  await page.getByPlaceholder("Вопрос или задача по проекту").press("Enter");

  await expect(page.locator(".timeline .msg-user")).toContainText("Что это за проект?");
  await expect(page.locator(".timeline")).toContainText("Это сайт клиники.", { timeout: 30_000 });
  // No plan or questions tabs: the conversation is the whole middle.
  await expect(page.getByRole("tab", { name: "Ход работы" })).toHaveCount(0);
  const result = page.getByRole("complementary", { name: "Контекст и параметры" });
  // No kind any more, said or switched (asked for).
  await expect(result.locator(".project-kind-switch, .project-kind-fixed")).toHaveCount(0);
  // Removing is in the sidebar's "⋯" only (asked for: the frame in the project tab went).
  await expect(result.getByRole("button", { name: "Убрать из Drimvox…" })).toHaveCount(0);
  // No branches nor commits by hand (asked for): the agent commits in the project's own branch; only publishing stays.
  await expect(result.getByLabel("Ветка агента")).toHaveCount(0);
  await expect(result.getByText("Git: как работает агент")).toHaveCount(0);
  await expect(result.getByRole("region", { name: "Публикация" })).toBeVisible();
  // The context folds to a button and opens again for good (seen: in a new project it closed right after the click).
  const edge = result.getByRole("separator", { name: "Высота контекста" });
  await edge.focus();
  for (let i = 0; i < 30 && (await edge.count()); i++) await page.keyboard.press("ArrowUp");
  await expect(result.getByRole("region", { name: "Контекст", exact: true })).toHaveCount(0);
  await result.getByRole("button", { name: "Показать контекст" }).click();
  await expect(result.getByRole("region", { name: "Контекст", exact: true })).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(result.getByRole("region", { name: "Контекст", exact: true })).toBeVisible();
  // Not kept as folded: the next time the panel is drawn it stays open.
  expect(await page.evaluate(() => localStorage.getItem("drimvox.contextHeight"))).toBeNull();
  // The time and the budget are set in the parameters too (asked for: not a pop-up from the header's numbers).
  await expect(result.getByRole("region", { name: "Время и бюджет" }).getByLabel("Время, часов")).toBeVisible();
  await expect(page.locator(".workshop-bar-top").getByRole("button", { name: /из/ })).toHaveCount(0);
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
        call("write_file", { path: "index.html", content: "<h1>Первая</h1>\n" }),
        call("look_at_page", { url: `http://localhost:${port}/a`, question: "Видна первая?" }),
        call("look_at_page", { url: `http://localhost:${port}/b`, question: "Видна вторая?" }),
        { text: "Готово." },
      ],
      true,
    );
    await page.getByRole("button", { name: "Проекты", exact: true }).click();
    await addProject(page);
    await pickCoder(page);
    await page.getByPlaceholder("Вопрос или задача по проекту").fill("Две страницы");
    await page.getByPlaceholder("Вопрос или задача по проекту").press("Enter");
    await expect(page.locator(".side-project.is-on").getByRole("status")).toContainText("готово", { timeout: 30_000 });

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

    // The report is the agent's last message; the screenshots stay where they were taken.
    await expect(page.locator(".timeline")).toContainText("Готово.");
  } finally {
    // The window keeps its connections to the page open: they are cut, or closing waits for them.
    site.closeAllConnections();
    await new Promise((done) => site.close(done));
  }
});
