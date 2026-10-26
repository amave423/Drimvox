import { startTask } from "./start-task";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeProvider, type FakeProvider, type FakeTurn } from "../../../packages/core/test/fake-provider";
import { makeRepo } from "../../../packages/core/test/git-repo";
import { openSection, paramsButton } from "./sections";

const mainJs = fileURLToPath(new URL("../dist/main.cjs", import.meta.url));
const KEY = "good-key";

let userData: string;
let repo: string;
let app: ElectronApplication | undefined;
let fake: FakeProvider | undefined;
let site: Server | undefined;

test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), "drimvox-e2e-"));
  repo = makeRepo({ "index.html": "<h1>Меню</h1>\n" });
});

test.afterEach(async () => {
  await app?.close();
  await fake?.close();
  await new Promise((r) => (site ? site.close(r) : r(null)));
  app = undefined;
  fake = undefined;
  site = undefined;
  rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** The page the agent "built", and the site the user likes: both served on this computer. */
async function serveSite(): Promise<string> {
  site = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end('<body style="margin:0;background:#1f2a24"><h1 style="color:#f4efe6;font:64px cursive;padding:40px">Меню на доске</h1></body>');
  });
  await new Promise<void>((r) => site!.listen(0, "127.0.0.1", r));
  const address = site.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return `http://localhost:${address.port}/`;
}

const call = (name: string, args: Record<string, unknown>): FakeTurn => ({ toolCalls: [{ name, args }] });
const look = (palette: string[], heading: string, kind: string) => ({ palette, heading: { name: heading, kind }, body: { name: "PT Sans", kind: "sans" } });

test("the look: samples in the interview, the user's own sample, the brief, a design review with one round of polish", async () => {
  test.setTimeout(150_000);
  const url = await serveSite();
  const coder: FakeTurn[] = [
    call("ask_questions", {
      understood: "Нужна страница меню кофейни.",
      unknown: ["Внешний вид"],
      questions: [
        {
          id: "look",
          question: "Как должна выглядеть страница?",
          options: [
            { label: "Меловая доска", description: "Тёмный фон и рукописные заголовки", look: look(["#1F2A24", "#F4EFE6", "#E0A458"], "Amatic SC", "hand") },
            { label: "Журнал", description: "Крупные фото и засечки", look: look(["#FFFDF8", "#1A1A1A", "#B4442C"], "Playfair Display", "serif") },
          ],
          recommended: 0,
        },
      ],
    }),
    call("ask_questions", { questions: [], understood: "Меню в стиле меловой доски, как на сайте-образце.", unknown: [] }),
    call("propose_spec", {
      spec: "# Меню\n\nСтраница меню кофейни.",
      checks: [],
      plan: ["Страница"],
      requirements: [{ id: "R1", text: "Есть страница с меню", verify: "visual", how: "открыть главную" }],
      visual_checks: [{ url, expect: "Заголовок меню" }],
      design: {
        direction: "Меловая доска",
        concept: "Меню как на доске мелом",
        palette: [
          { role: "фон", hex: "#1F2A24" },
          { role: "текст", hex: "#F4EFE6" },
          { role: "акцент", hex: "#E0A458" },
        ],
        fonts: { heading: { name: "Amatic SC", kind: "hand" }, body: { name: "PT Sans", kind: "sans" } },
        rules: ["Без теней"],
      },
    }),
    call("write_file", { path: "index.html", content: "<h1>Меню</h1>\n<p>Капучино</p>\n" }),
    call("finish", { summary: "Сверстал меню.", commit_message: "Add the menu page" }),
    call("write_file", { path: "index.html", content: "<h1 class=big>Меню</h1>\n<p>Капучино</p>\n" }),
    call("finish", { summary: "Отшлифовал по ревью.", commit_message: "Add the menu page" }),
  ];
  const verdict = call("report_acceptance", { results: [{ id: "R1", status: "done", evidence: "скриншот", problem: "" }], summary: "Принято" });
  const reviews = ["POLISH\n- Заголовок мелкий: сделать 64 px\n- На телефоне строки меню переносятся неровно", "GOOD"];
  fake = await startFakeProvider({
    key: KEY,
    models: [{ id: "coder", name: "Coder", supported_parameters: ["tools"], architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } }],
    respond: (body) => {
      const text = JSON.stringify(body.messages);
      if (/acceptance agent/i.test(JSON.stringify(body.messages?.[0]?.content ?? ""))) return verdict;
      // The vision model's questions come without tools; the coder's instructions mention the design review too.
      if (!body.tools && /design review/i.test(text)) return { text: reviews.shift() ?? "GOOD" };
      if (!body.tools && /visual style/i.test(text)) return { text: "Тёмно-зелёный фон, кремовый текст, рукописные заголовки" };
      if (!body.tools && text.includes("data:image/png;base64,")) return { text: "PASS: заголовок виден" };
      return coder.shift() ?? { text: "Done." };
    },
  });
  app = await electron.launch({ args: [mainJs], env: { ...process.env, DRIMVOX_USER_DATA: userData, DRIMVOX_TEST_PICK_FOLDER: repo } });
  const page: Page = await app.firstWindow();
  await expect(paramsButton(page)).toBeVisible();

  await openSection(page, "Ключи и модели");
  await page.getByRole("radio", { name: /OpenAI-совместимый/ }).click();
  await page.getByLabel("Адрес API").fill(fake.baseUrl);
  await page.getByLabel("Ключ API, если нужен").fill(KEY);
  await page.getByRole("button", { name: "Подключить", exact: true }).click();
  await expect(page.getByText("Моделей: 1")).toBeVisible();

  await page.getByRole("button", { name: "Проекты", exact: true }).click();

  await page.getByRole("button", { name: "+ Проект" }).click();
  await startTask(page, {
    task: "Сделай страницу меню для кофейни",
    model: "coder",
    stages: { interview: true, spec: true, approveSpec: true, testsFirst: true },
  });

  // The directions come as cards with their colours and fonts, and the user may give a sample of their own.
  await expect(page.getByText("Как должна выглядеть страница?")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("img", { name: "#1F2A24, #F4EFE6, #E0A458" })).toBeVisible();
  await expect(page.getByText("Аа Playfair Display")).toBeVisible();
  await page.getByLabel("Ссылка на сайт-образец").fill("не ссылка");
  await expect(page.getByText("Нужна ссылка, начинающаяся с http:// или https://")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ответить" })).toBeDisabled();
  await page.getByLabel("Ссылка на сайт-образец").fill(url);
  await page.getByRole("button", { name: "Ответить" }).click();

  // The spec comes with the brief; the task keeps its style in the margin.
  await expect(page.getByRole("heading", { name: "Спека и план" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Дизайн" })).toBeVisible();
  await expect(page.getByText("Меню как на доске мелом")).toBeVisible();
  await expect(page.getByText("Заголовки: Amatic SC")).toBeVisible();
  await page.getByRole("button", { name: "Начать работу" }).click();

  // After acceptance, the design review sends one round of polish; its notes and screenshots are in the review.
  await expect(page.getByRole("heading", { name: "Дизайн-ревью" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Заголовок мелкий: сделать 64 px", { exact: true })).toBeVisible();
  await expect(page.getByText(/Замечаний: 2, агент их доработал/)).toBeVisible();
  const shots = page.getByRole("img", { name: "Снимок экрана для дизайн-ревью" });
  await expect(shots).toHaveCount(2);
  await expect(page.locator(".design-note")).toContainText("Меловая доска");

  await page.getByText("Как агент работал").click();
  await expect(page.getByText(`Образец стиля: ${url}`)).toBeVisible();
  await expect(page.getByText("Тёмно-зелёный фон, кремовый текст, рукописные заголовки", { exact: true })).toBeVisible();
  await expect(page.getByText("Дизайн-ревью: замечаний 2, один круг шлифовки")).toBeVisible();

  // The phone screenshot is narrow: the review really looked at a phone.
  const widths = await shots.evaluateAll((imgs) => imgs.map((img) => (img as HTMLImageElement).naturalWidth));
  expect(Math.min(...widths)).toBeLessThan(500);
  expect(Math.max(...widths)).toBeGreaterThan(1000);
});
