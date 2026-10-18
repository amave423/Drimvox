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
  userData = mkdtempSync(join(tmpdir(), "artel-e2e-"));
  repo = mkdtempSync(join(tmpdir(), "artel-repo-"));
  writeFileSync(join(repo, "README.md"), "# Timer\n");
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
const isAcceptor = (body: any) => /acceptance agent/i.test(JSON.stringify(body.messages?.[0]?.content ?? ""));

async function launch(coder: FakeTurn[], reviewer: FakeTurn[]): Promise<Page> {
  const coderQueue = [...coder];
  const reviewerQueue = [...reviewer];
  fake = await startFakeProvider({
    key: KEY,
    models: [{ id: "coder", name: "Coder", supported_parameters: ["tools"] }],
    respond: (body) => (isAcceptor(body) ? reviewerQueue.shift() : coderQueue.shift()) ?? { text: "Done." },
  });
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

// docs/specs/backlog-loop.md: the interview ends in a task list; the user picks at most three points, each task is
// reviewed and accepted, and the next one starts on the user's word.
test("a project: the interview, the task list, a batch of three points, review, then Next", async () => {
  const list = call("propose_tasks", {
    context: "Сайт-таймер помодоро для себя.",
    tasks: [
      { title: "MVP: таймер 25 минут", done: ["Кнопка «Старт» запускает отсчёт"], size: "M" },
      { title: "Пауза и сброс", done: ["Пауза и сброс работают"], size: "S" },
      { title: "Статистика", done: ["График по дням"], size: "L" },
    ],
  });
  const mvp: FakeTurn = {
    toolCalls: [
      { name: "write_file", args: { path: "index.html", content: "<button>Старт</button>\n" } },
      { name: "finish", args: { summary: "Сделал таймер", commit_message: "Add the timer" } },
    ],
  };
  const verdict = call("report_acceptance", { results: [{ id: "R1", status: "done", evidence: "кнопка есть", problem: "" }], summary: "Принято" });
  const page = await launch([call("ask_questions", { questions: [] }), list, mvp], [verdict]);

  await page.getByRole("button", { name: "+ Проект" }).click();
  await page.getByLabel("Опиши проект").fill("Помодоро-таймер");
  await page.getByRole("button", { name: "Выбери модель" }).click();
  await page.getByRole("option", { name: /Coder/ }).click();
  await page.getByRole("button", { name: "Начать опрос" }).click();

  await expect(page.getByText("Список задач готов")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "К списку задач" }).click();
  await expect(page.getByRole("heading", { name: "Список задач" })).toBeVisible();

  const box = (title: string) => page.locator(".backlog-item", { hasText: title }).getByRole("checkbox");
  await box("MVP: таймер 25 минут").check();
  await box("Пауза и сброс").check();
  await expect(page.getByText(/Выбрано: 3 из 3 очков/)).toBeVisible();
  // A day's task does not fit next to them.
  await expect(box("Статистика")).toBeDisabled();

  await page.getByRole("button", { name: "Начать" }).click();
  await expect(page.getByText("Агент закончил. Посмотри правки")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Принять" }).click();
  await expect(page.getByText(/Принято: коммит/)).toBeVisible();
  expect(readFileSync(join(repo, "index.html"), "utf8")).toContain("Старт");

  await page.getByRole("button", { name: "К списку задач" }).click();
  await expect(page.getByText("Следующая: «Пауза и сброс».")).toBeVisible();
  await expect(page.getByRole("button", { name: "Дальше" })).toBeVisible();
  await expect(page.locator(".backlog-item", { hasText: "MVP" })).toContainText("готово");
});
