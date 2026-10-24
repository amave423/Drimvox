import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error A plain module shared with the core's tests.
import { startFakeGithub } from "../../../packages/core/test/fake-github.mjs";

const mainJs = fileURLToPath(new URL("../dist/main.cjs", import.meta.url));

let userData: string;
let repo: string;
let app: ElectronApplication | undefined;
let hub: any;

test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), "drimvox-e2e-"));
  repo = mkdtempSync(join(tmpdir(), "drimvox-repo-"));
  writeFileSync(join(repo, "index.html"), "<h1>Hi</h1>\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("add", "-A");
  git("commit", "-q", "-m", "Start");
});

test.afterEach(async () => {
  await app?.close();
  await hub?.close();
  app = undefined;
  hub = undefined;
  rmSync(userData, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// docs/specs/github-publish.md: sign in with a code, then the repository is created and pushed only after a yes.
test("publishes a project on GitHub: the code to enter, the name, private by default, a confirmation", async () => {
  hub = await startFakeGithub({ pending: 2 });
  app = await electron.launch({
    args: [mainJs],
    env: {
      ...process.env,
      DRIMVOX_USER_DATA: userData,
      DRIMVOX_TEST_PICK_FOLDER: repo,
      DRIMVOX_TEST_GITHUB: JSON.stringify({ webUrl: hub.origin, apiUrl: hub.origin, pollMs: 50 }),
    },
  });
  const page = await app.firstWindow();
  await expect(page.getByRole("button", { name: "Ключи и модели" }).first()).toBeVisible();
  await page.getByRole("button", { name: "+ Проект" }).click();

  const github = page.getByRole("region", { name: "GitHub" });
  await github.getByRole("button", { name: "Подключить GitHub" }).click();
  await expect(github.getByLabel("Код для GitHub")).toHaveText("ABCD-1234");
  await expect(github.getByRole("link", { name: "Открыть GitHub" })).toHaveAttribute("href", `${hub.origin}/login/device`);
  await expect(github.getByText("GitHub: octo.")).toBeVisible({ timeout: 15_000 });

  const name = basename(repo);
  await expect(github.getByLabel("Название репозитория")).toHaveValue(name);
  await github.getByRole("button", { name: "Опубликовать на GitHub" }).click();
  // Nothing is created before the yes.
  await expect(github.getByText(`Создать приватный репозиторий octo/${name} и отправить туда код?`)).toBeVisible();
  expect(hub.repos.size).toBe(0);
  await github.getByRole("button", { name: "Да, опубликовать" }).click();

  await expect(github.getByText("Проект на GitHub:")).toBeVisible({ timeout: 15_000 });
  const made = hub.repos.get(name);
  expect(made.private).toBe(true);
  const head = (cwd: string, ref: string) => execFileSync("git", ["rev-parse", ref], { cwd, encoding: "utf8" }).trim();
  expect(head(made.bare, "main")).toBe(head(repo, "HEAD"));
  await expect(github.getByRole("button", { name: "Отправить изменения на GitHub" })).toBeVisible();
});
