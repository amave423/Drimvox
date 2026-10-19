import { startTask } from "./start-task";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeProvider, type FakeProvider, type FakeTurn } from "../../../packages/core/test/fake-provider";
import { git, makeRepo } from "../../../packages/core/test/git-repo";

const mainJs = fileURLToPath(new URL("../dist/main.cjs", import.meta.url));
const KEY = "good-key";
const models = [
  { id: "lead", name: "Lead", supported_parameters: ["tools"] },
  { id: "coder", name: "Coder", supported_parameters: ["tools"] },
];

let userData: string;
let repo: string;
let app: ElectronApplication | undefined;
let fake: FakeProvider | undefined;

test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), "artel-e2e-"));
  repo = makeRepo({ "package.json": '{ "type": "module" }\n', "README.md": "# Demo\n" });
});

test.afterEach(async () => {
  await app?.close();
  await fake?.close();
  app = undefined;
  fake = undefined;
  rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const call = (name: string, args: Record<string, unknown>): FakeTurn => ({ toolCalls: [{ name, args }] });
const addModule = (name: string): FakeTurn[] => [
  call("write_file", { path: `${name}.js`, content: `export const ${name} = true;\n` }),
  call("write_file", {
    path: `${name}.test.js`,
    content: `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { ${name} } from "./${name}.js";\ntest("${name}", () => assert.ok(${name}));\n`,
  }),
  call("finish", { summary: `${name} готов`, commit_message: name }),
];

/** The lead plans; each worker answers from the script under the subtask id in its brief. */
function team(): (body: any) => FakeTurn {
  const lead: FakeTurn[] = [
    call("propose_plan", {
      spec: "# Модули\n\nДобавить **sub** и **mul**.",
      checks: ["node --test"],
      subtasks: [
        { id: "sub", title: "Модуль sub", description: "Сделай sub.js и тест", dependsOn: [] },
        { id: "mul", title: "Модуль mul", description: "Сделай mul.js и тест", dependsOn: ["sub"] },
        { id: "div", title: "Модуль div", description: "Сделай div.js и тест", dependsOn: [] },
      ],
    }),
  ];
  const workers: Record<string, FakeTurn[]> = { sub: addModule("sub"), mul: addModule("mul") };
  return (body) => {
    if (body.model === "lead") return lead.shift() ?? { text: "Done." };
    const id = JSON.stringify(body.messages).match(/Subtask id: ([\w-]+)/)?.[1] ?? "";
    return workers[id]?.shift() ?? { text: "Done." };
  };
}

async function launch(): Promise<Page> {
  fake = await startFakeProvider({ key: KEY, models, respond: team() });
  app = await electron.launch({ args: [mainJs], env: { ...process.env, ARTEL_USER_DATA: userData, ARTEL_TEST_PICK_FOLDER: repo } });
  const page = await app.firstWindow();
  await expect(page.getByRole("button", { name: "Ключи и модели" }).first()).toBeVisible();

  await page.getByRole("button", { name: "Ключи и модели" }).click();
  await page.getByRole("radio", { name: /OpenAI-совместимый/ }).click();
  await page.getByLabel("Адрес API").fill(fake.baseUrl);
  await page.getByLabel("Ключ API, если нужен").fill(KEY);
  await page.getByRole("button", { name: "Подключить", exact: true }).click();
  await expect(page.getByText("Моделей: 2")).toBeVisible();
  return page;
}

test("a team: plan review with a removed subtask, the board, a subtask sheet, one review", async () => {
  const page = await launch();
  await page.getByRole("button", { name: "+ Проект" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/artel-repo-/);
  await startTask(page, {
    task: "Добавь модули sub и mul",
    model: "lead",
    stages: { interview: false, spec: true, approveSpec: true, testsFirst: false },
    team: { model: "coder" },
  });

  await expect(page.getByRole("heading", { name: "План команды" })).toBeVisible();
  await expect(page.getByText("после: Модуль sub")).toBeVisible();
  const div = page.locator(".plan-card", { hasText: "Модуль div" });
  await div.getByRole("button", { name: "Убрать" }).click();
  await expect(page.getByText("Подзадачи: 2")).toBeVisible();
  await page.getByRole("button", { name: "Запустить команду" }).click();

  await expect(page.getByText("Команда закончила. Посмотри общие правки")).toBeVisible({ timeout: 30_000 });
  const board = page.locator(".subtask-board");
  await expect(board.getByRole("button")).toHaveCount(2);
  await expect(board.getByText("Влито")).toHaveCount(2);

  await board.getByRole("button", { name: /Модуль mul/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Модуль mul");
  await expect(page.getByText("Подзадача влита в цель.")).toBeVisible();
  await page.getByRole("button", { name: /Цель «Добавь модули sub и mul»/ }).click();

  await page.getByRole("button", { name: "Принять", exact: true }).click();
  await expect(page.getByText(/Принято: коммит/)).toBeVisible();
  expect(readFileSync(join(repo, "mul.js"), "utf8")).toBe("export const mul = true;\n");
  expect(git(repo, "branch", "--list", "artel/*")).toBe("");
});
