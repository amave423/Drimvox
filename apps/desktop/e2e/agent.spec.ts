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
const MATH = "export function add(a, b) {\n  return a + b;\n}\n";
const TEST_ADD =
  'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./math.js";\n\ntest("add", () => assert.equal(add(2, 3), 5));\n';
const TEST_BOTH =
  TEST_ADD.replace('import { add } from "./math.js";', 'import { add, subtract } from "./math.js";') +
  'test("subtract", () => assert.equal(subtract(5, 3), 2));\n';
const MATH_BOTH = MATH + "export function subtract(a, b) {\n  return a - b;\n}\n";

let userData: string;
let repo: string;
let app: ElectronApplication | undefined;
let fake: FakeProvider | undefined;

test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), "artel-e2e-"));
  repo = makeRepo({
    "src/app.ts": "export const greeting = 'hi';\n",
    "package.json": '{ "type": "module" }\n',
    "math.js": MATH,
    "math.test.js": TEST_ADD,
  });
});

test.afterEach(async () => {
  await app?.close();
  await fake?.close();
  app = undefined;
  fake = undefined;
  rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function launch(script: FakeTurn[], env: Record<string, string> = {}): Promise<Page> {
  fake = await startFakeProvider({ key: KEY, models, script });
  app = await electron.launch({ args: [mainJs], env: { ...process.env, ARTEL_USER_DATA: userData, ARTEL_TEST_PICK_FOLDER: repo, ...env } });
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

/** Direct mode unless asked otherwise: these tests cover the agent, the pipeline has its own test. */
async function startTask(page: Page, task: string, pipeline = false) {
  await page.getByRole("button", { name: "+ Проект" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/artel-repo-/);
  await page.getByLabel("Новая задача").fill(task);
  await page.getByRole("button", { name: "Выбери модель" }).click();
  await page.getByRole("option", { name: /Coder/ }).click();
  if (!pipeline) {
    await page.getByLabel("Сначала задать мне вопросы").uncheck();
    await page.getByLabel("Написать спеку и план").uncheck();
  }
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

  // The question sits at the top, next to Stop, not at the bottom of the feed.
  const ask = page.locator(".task-notice").getByRole("alert");
  await expect(ask.getByText("Агент просит разрешения")).toBeVisible();
  await expect(ask.getByText("Отправка кода на сервер (git push)")).toBeVisible();
  await page.getByRole("button", { name: "Запретить" }).click();

  await expect(page.getByText("Агент закончил, но файлы не изменились.")).toBeVisible();
  await expect(page.getByText("Пуш не разрешили, ничего не менял.")).toBeVisible();
});

// Seen live: a subtask's feed grew 138 000 px wide from one inline script; text and the approval card ran off the screen.
test("long commands and messages stay inside the feed", async () => {
  const script = `node -e "${"const value = 'кусок длинного скрипта без пробелов'; ".repeat(60)}"`;
  const page = await launch([
    { text: `Проверю это: ${"ДлинноеСловоБезПробелов".repeat(40)}`, toolCalls: [{ name: "run_command", args: { command: script } }] },
    { toolCalls: [{ name: "run_command", args: { command: `${script}; git push origin main` } }] },
    { toolCalls: [{ name: "finish", args: { summary: "Готово", commit_message: "Nothing" } }] },
  ]);
  await startTask(page, "Проверь длинные команды");
  await expect(page.getByRole("alert").getByText("Агент просит разрешения")).toBeVisible();

  const overflow = await page.evaluate(() => {
    const feed = document.querySelector("ol.feed")!;
    const sheet = document.querySelector(".sheet-body")!;
    const right = sheet.getBoundingClientRect().right;
    const wide = [...feed.querySelectorAll("*")].filter((e) => e.getBoundingClientRect().right > right + 1).map((e) => e.className);
    return { scroll: feed.scrollWidth - feed.clientWidth, wide: wide.slice(0, 5) };
  });
  expect(overflow).toEqual({ scroll: 0, wide: [] });
  await page.getByRole("button", { name: "Запретить" }).click();
  // A refused command is marked as refused, not as one that ran out of time.
  await expect(page.locator(".action-bad", { hasText: "запрещено" })).toBeVisible();
  await expect(page.getByText("превышено время")).toHaveCount(0);
});

test("a question about the project gets an answer, not a spec", async () => {
  const page = await launch([
    { toolCalls: [{ name: "read_file", args: { path: "math.js" } }] },
    { toolCalls: [{ name: "answer", args: { answer: "Это маленький проект: **math.js** с функцией `add` и тест к ней." } }] },
    { toolCalls: [{ name: "answer", args: { answer: "Тест один: проверяет, что add(2, 3) = 5." } }] },
  ]);
  // With the interview and the spec on, as a new user has them.
  await startTask(page, "что это за проект?", true);

  await expect(page.getByRole("heading", { name: "Ответ" })).toBeVisible();
  await expect(page.getByText("Это маленький проект:")).toBeVisible();
  await expect(page.getByText("Спека и план")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Принять", exact: true })).toHaveCount(0);

  await page.getByLabel("Спросить ещё про проект…").fill("Сколько там тестов?");
  await page.getByRole("button", { name: "Спросить", exact: true }).click();
  await expect(page.getByText("Тест один: проверяет, что add(2, 3) = 5.")).toBeVisible();
  expect(git(repo, "branch", "--list", "artel/*")).not.toBe("");
});

test("a Windows notification says the task is ready, and a click opens it", async () => {
  const page = await launch(
    [
      { toolCalls: [{ name: "write_file", args: { path: "notes.txt", content: "x" } }] },
      { toolCalls: [{ name: "finish", args: { summary: "Добавил notes.txt.", commit_message: "Add notes" } }] },
    ],
    // The window counts as being in the background.
    { ARTEL_TEST_UNFOCUSED: "1" },
  );
  await startTask(page, "Добавь notes.txt");
  await expect(page.getByText("Добавил notes.txt.")).toBeVisible();

  const notices = async () =>
    app!.evaluate(() => ((globalThis as any).artelNotices ?? []).map((n: any) => ({ title: n.title, body: n.body })));
  await expect.poll(notices, { timeout: 10_000 }).toEqual([{ title: "Готово, можно смотреть правки", body: "Добавь notes.txt" }]);

  await page.getByRole("button", { name: "Настройки" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Настройки" })).toBeVisible();
  await app!.evaluate(() => (globalThis as any).artelNotices[0].click());
  await expect(page.getByRole("heading", { level: 1, name: "Добавь notes.txt" })).toBeVisible();
});

// Seen live: a task that failed after writing 38 files showed none of them, only "Continue".
test("a stopped task still shows what is done and lets it be accepted", async () => {
  const page = await launch([
    { toolCalls: [{ name: "write_file", args: { path: "sky.js", content: "export const stars = 16;\n" } }] },
    { text: "Думаю дальше…", delayMs: 30_000 },
  ]);
  await startTask(page, "Нарисуй небо");
  await expect(page.getByText("Пишет sky.js")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Стоп" }).click();
  await expect(page.getByText("Остановлен").first()).toBeVisible();

  await page.getByText("Что уже сделано").click();
  await expect(page.getByText("export const stars = 16;")).toBeVisible();
  await page.getByRole("button", { name: "Принять" }).click();
  await expect(page.getByText(/Принято/).first()).toBeVisible();
  expect(readFileSync(join(repo, "sky.js"), "utf8")).toBe("export const stars = 16;\n");
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

test("requirements in the spec, an acceptance round that sends work back, and the report in review", async () => {
  const verdict = (readme: "done" | "missing") => ({
    toolCalls: [
      {
        name: "report_acceptance",
        args: {
          results: [
            { id: "R1", status: "done", evidence: "node --test: 2 passed", problem: "" },
            { id: "R2", status: readme, evidence: "README.md", problem: readme === "done" ? "" : "В README нет ни слова о subtract" },
          ],
          summary: readme === "done" ? "Все требования выполнены" : "Не хватает описания в README",
        },
      },
    ],
  });
  const page = await launch([
    { toolCalls: [{ name: "ask_questions", args: { questions: [] } }] },
    {
      toolCalls: [
        {
          name: "propose_spec",
          args: {
            spec: "# Вычитание",
            checks: ["node --test"],
            plan: ["Тест", "Функция", "README"],
            requirements: [
              { id: "R1", text: "subtract(a, b) возвращает разность", verify: "check", how: "node --test" },
              { id: "R2", text: "README описывает subtract", verify: "review", how: "прочитать README.md" },
            ],
            decisions: ["Без зависимостей из npm"],
          },
        },
      ],
    },
    { toolCalls: [{ name: "write_file", args: { path: "math.test.js", content: TEST_BOTH } }, { name: "finish", args: { summary: "Тест", commit_message: "Test" } }] },
    { toolCalls: [{ name: "write_file", args: { path: "math.js", content: MATH_BOTH } }, { name: "finish", args: { summary: "Код", commit_message: "Add subtract" } }] },
    verdict("missing"),
    { toolCalls: [{ name: "write_file", args: { path: "README.md", content: "# Math\n\nsubtract(a, b)\n" } }, { name: "finish", args: { summary: "subtract и README", commit_message: "Add subtract" } }] },
    verdict("done"),
  ]);
  await startTask(page, "Добавь subtract(a, b) и опиши в README", true);

  await expect(page.getByRole("heading", { name: "Спека и план" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Требования" })).toBeVisible();
  await expect(page.getByText("README описывает subtract")).toBeVisible();
  await expect(page.getByText("Без зависимостей из npm")).toBeVisible();
  await page.getByRole("button", { name: "Начать работу" }).click();

  await expect(page.getByText("Агент закончил. Посмотри правки")).toBeVisible();
  const report = page.locator(".acceptance");
  await expect(report.getByRole("heading", { name: /Приёмка/ })).toBeVisible();
  await expect(report.getByText("Все требования выполнены")).toBeVisible();
  await expect(report.getByText("2 из 2 сделано · круг 2")).toBeVisible();
  await page.getByText("Как агент работал").click();
  await expect(page.getByText("Приёмщик проверяет работу по требованиям").first()).toBeVisible();
  await expect(page.getByText("Приёмка: сделано 1 из 2")).toBeVisible();
});

test("the interview goes in rounds with open questions until «Enough, start»", async () => {
  const page = await launch([
    {
      toolCalls: [
        {
          name: "ask_questions",
          args: {
            understood: "Нужна функция для вычитания чисел.",
            unknown: ["Где она будет использоваться"],
            questions: [{ id: "where", question: "Где будет использоваться функция?", options: [] }],
          },
        },
      ],
    },
    {
      toolCalls: [
        {
          name: "ask_questions",
          args: {
            understood: "Функция нужна для калькулятора.",
            unknown: ["Нужна ли проверка типов"],
            questions: [{ id: "types", question: "Проверять, что пришли числа?", options: [{ label: "Да" }, { label: "Нет" }], recommended: 0 }],
          },
        },
      ],
    },
    { toolCalls: [{ name: "propose_spec", args: { spec: "# Вычитание для калькулятора", checks: ["node --test"], plan: ["Функция"] } }] },
  ]);
  await startTask(page, "Добавь subtract", true);

  await expect(page.getByText("Круг 1 из 5", { exact: false })).toBeVisible();
  await expect(page.getByText("Нужна функция для вычитания чисел.")).toBeVisible();
  await expect(page.getByText("Где она будет использоваться")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ответить" })).toBeDisabled();
  await page.getByLabel("Где будет использоваться функция?").fill("В калькуляторе на сайте");
  await page.getByRole("button", { name: "Ответить" }).click();

  await expect(page.getByText("Круг 2 из 5", { exact: false })).toBeVisible();
  await expect(page.getByText("Функция нужна для калькулятора.")).toBeVisible();
  await page.getByRole("button", { name: "Хватит, начинай" }).click();
  await expect(page.getByRole("heading", { name: "Спека и план" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Вычитание для калькулятора" })).toBeVisible();
});

test("«On its own» goes from the spec to the work without waiting for an OK", async () => {
  const page = await launch([
    { toolCalls: [{ name: "propose_spec", args: { spec: "# Вычитание", checks: ["node --test"], plan: ["Функция"] } }] },
    { toolCalls: [{ name: "write_file", args: { path: "math.js", content: MATH_BOTH } }, { name: "finish", args: { summary: "Готово сама", commit_message: "Add subtract" } }] },
  ]);
  await page.getByRole("button", { name: "+ Проект" }).click();
  await page.getByLabel("Новая задача").fill("Добавь subtract");
  await page.getByRole("button", { name: "Выбери модель" }).click();
  await page.getByRole("option", { name: /Coder/ }).click();
  await page.getByLabel("Сначала задать мне вопросы").uncheck();
  await page.getByLabel("Сначала тесты, потом код").uncheck();
  await page.getByRole("radio", { name: "Самостоятельно" }).click();
  await expect(page.getByText(/После опроса агент всё делает сам/)).toBeVisible();
  await page.getByRole("button", { name: "Запустить агента" }).click();

  await expect(page.getByText("Агент закончил. Посмотри правки")).toBeVisible();
  await expect(page.getByText("Готово сама")).toBeVisible();
  await expect(page.getByRole("button", { name: "Начать работу" })).toHaveCount(0);
});

test("a big task goes in stages: the user sees each accepted stage and may stop with what is done", async () => {
  const page = await launch([
    {
      toolCalls: [
        {
          name: "propose_spec",
          args: {
            spec: "# Вычитание и документация",
            checks: ["node --test"],
            plan: ["Функция", "README"],
            stages: [{ title: "Функция subtract" }, { title: "Документация" }],
            requirements: [
              { id: "R1", text: "subtract(a, b) возвращает разность", verify: "check", how: "node --test", stage: 1 },
              { id: "R2", text: "README описывает subtract", verify: "review", how: "README.md", stage: 2 },
            ],
          },
        },
      ],
    },
    {
      toolCalls: [
        { name: "write_file", args: { path: "math.js", content: MATH_BOTH } },
        { name: "write_file", args: { path: "math.test.js", content: TEST_BOTH } },
        { name: "finish", args: { summary: "Функция готова", commit_message: "Add subtract" } },
      ],
    },
    { toolCalls: [{ name: "report_acceptance", args: { results: [{ id: "R1", status: "done", evidence: "2 pass", problem: "" }], summary: "Этап принят" } }] },
  ]);
  await page.getByRole("button", { name: "+ Проект" }).click();
  await page.getByLabel("Новая задача").fill("Добавь subtract и документацию");
  await page.getByRole("button", { name: "Выбери модель" }).click();
  await page.getByRole("option", { name: /Coder/ }).click();
  await page.getByLabel("Сначала задать мне вопросы").uncheck();
  await page.getByLabel("Сначала тесты, потом код").uncheck();
  await page.getByRole("button", { name: "Запустить агента" }).click();

  await expect(page.getByRole("heading", { name: "Этапы" })).toBeVisible();
  await expect(page.getByText("Документация").first()).toBeVisible();
  await page.getByRole("button", { name: "Начать работу" }).click();

  await expect(page.getByText("Этап 1 из 2 «Функция subtract» принят.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Дальше: этап 2" })).toBeVisible();
  await page.getByRole("button", { name: "Хватит — на ревью" }).click();
  await expect(page.getByText("Сделано этапов: 1 из 2.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Принять", exact: true }).click();
  await expect(page.getByText(/Принято: коммит/)).toBeVisible();
  expect(existsSync(join(repo, "README.md"))).toBe(false);
});

test("the pipeline: interview, spec with an edited check, red tests, green code, review", async () => {
  const page = await launch([
    {
      toolCalls: [
        {
          name: "ask_questions",
          args: {
            questions: [
              {
                id: "name",
                question: "Как назвать функцию?",
                options: [{ label: "subtract", description: "Как в задаче" }, { label: "minus" }],
                recommended: 0,
              },
            ],
          },
        },
      ],
    },
    { toolCalls: [{ name: "ask_questions", args: { questions: [], understood: "Нужна функция subtract", unknown: [] } }] },
    {
      toolCalls: [
        {
          name: "propose_spec",
          args: { spec: "# Вычитание\n\nДобавить **subtract(a, b)**.", checks: ["node --test math.test.js"], plan: ["Тест", "Функция"] },
        },
      ],
    },
    { toolCalls: [{ name: "write_file", args: { path: "math.test.js", content: TEST_BOTH } }] },
    { toolCalls: [{ name: "finish", args: { summary: "Тест написан", commit_message: "Test subtract" } }] },
    { toolCalls: [{ name: "write_file", args: { path: "math.js", content: MATH_BOTH } }] },
    { toolCalls: [{ name: "finish", args: { summary: "subtract готова, тесты зелёные", commit_message: "Add subtract" } }] },
  ]);
  await startTask(page, "Добавь subtract(a, b)", true);

  await expect(page.getByText("Пара вопросов перед работой")).toBeVisible();
  await expect(page.getByText("Рекомендую")).toBeVisible();
  await expect(page.getByRole("radio", { name: /subtract/ })).toBeChecked();
  await page.getByRole("button", { name: "Ответить" }).click();

  await expect(page.getByRole("heading", { name: "Спека и план" })).toBeVisible();
  await expect(page.getByText("subtract(a, b)").first()).toBeVisible();
  await page.getByLabel("Команда проверки 1").fill("node --test");
  await page.getByRole("button", { name: "Начать работу" }).click();

  await expect(page.getByText("Агент закончил. Посмотри правки")).toBeVisible();
  await expect(page.getByText("Artel сам запустил проверки — все прошли.")).toBeVisible();
  await page.getByText("Как агент работал").click();
  await expect(page.getByText("код 1")).toBeVisible();
  await expect(page.getByText("прошла")).toBeVisible();

  await page.getByRole("button", { name: "Принять", exact: true }).click();
  await expect(page.getByText(/Принято: коммит/)).toBeVisible();
  expect(git(repo, "log", "--format=%s", "-1")).toBe("Add subtract");
});
