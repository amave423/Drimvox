// The README's screenshots (`npm run screenshots`): the real app on a fake provider, a dental clinic as the example.
// Run it after the interface changes; the pictures land in docs/screenshots.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeProvider, type FakeProvider, type FakeTurn } from "../../../packages/core/test/fake-provider";
import { newChat, openSection, paramsButton } from "../e2e/sections";
import { addProject } from "../e2e/start-task";
import { readFileSync } from "node:fs";

const mainJs = fileURLToPath(new URL("../dist/main.cjs", import.meta.url));
const out = fileURLToPath(new URL("../../../docs/screenshots/", import.meta.url));
const KEY = "shots-key";

const MODELS = [
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", context_length: 1048576, pricing: { prompt: "0.0000003", completion: "0.0000012" }, supported_parameters: ["tools"] },
  { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", context_length: 1000000, pricing: { prompt: "0.000003", completion: "0.000015" }, supported_parameters: ["tools"], architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
  { id: "google/gemini-3.5-flash", name: "Gemini 3.5 Flash", context_length: 1048576, pricing: { prompt: "0.0000003", completion: "0.0000025" }, supported_parameters: ["tools"], architecture: { input_modalities: ["text", "image", "audio"], output_modalities: ["text"] } },
  { id: "qwen/qwen3.8-coder:free", name: "Qwen3.8 Coder (free)", context_length: 262144, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] },
  { id: "openai/gpt-oss-120b:free", name: "gpt-oss-120b (free)", context_length: 131072, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] },
];

const PAGE = `<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><title>Улыбка — стоматология</title></head>
<body>
  <h1>Стоматология «Улыбка»</h1>
  <form id="booking">
    <label>Имя <input name="name"></label>
    <label>Телефон <input name="phone"></label>
    <button>Записаться</button>
  </form>
</body>
</html>
`;

const DIAGRAM = [
  "Вот путь пациента от заявки до приёма. Две развилки: свободно ли время у врача и подтвердил ли пациент запись.",
  "",
  "```mermaid",
  "flowchart LR",
  "  A[Заявка с сайта] --> B{Время свободно?}",
  "  B -- Да --> C[SMS с кодом]",
  "  B -- Нет --> D[Три ближайших окна]",
  "  D --> B",
  "  C --> E{Код подтверждён?}",
  "  E -- Да --> F[Запись в расписании]",
  "  E -- Нет --> G[Звонок администратора]",
  "```",
  "",
  "Форму записи я поменял под эту схему: после выбора времени приходит SMS с кодом, без кода запись не создаётся.",
].join("\n");

const call = (name: string, args: Record<string, unknown>): FakeTurn => ({ toolCalls: [{ name, args }] });

const LOGO = readFileSync(fileURLToPath(new URL("../../web/src/assets/logo.svg", import.meta.url)), "utf8").replace(/<!--[\s\S]*?-->/g, "");

/**
 * The README's banner in the app's own look ("Корректура", docs/DESIGN.md): a sheet on the desk, the mark and the name
 * in the serif, a note in the margin. Drawn inside the app's window, where its fonts are loaded.
 */
async function banner(page: Page, name: string, dark: boolean) {
  const t = dark
    ? { desk: "#1b1b19", sheet: "#2a2a27", fg: "#e9e8e2", muted: "#a3a196", line: "#3d3d38", ink: "#8fb3ec", ok: "#7cc193", pencil: "#f07468" }
    : { desk: "#e4e5e0", sheet: "#fcfcfa", fg: "#22211e", muted: "#6b6a63", line: "#cfd0c8", ink: "#2b4c7e", ok: "#2f6b45", pencil: "#b3261e" };
  await page.evaluate(
    ({ t, logo }) => {
      document.getElementById("readme-banner")?.remove();
      const el = document.createElement("div");
      el.id = "readme-banner";
      el.style.cssText = `position:fixed;inset:0;z-index:99999;display:grid;place-items:center;background:${t.desk}`;
      el.innerHTML = `
        <div id="readme-banner-card" style="width:1200px;height:360px;box-sizing:border-box;padding:28px;background:${t.desk}">
          <div style="height:100%;box-sizing:border-box;display:flex;gap:40px;padding:44px 52px;background:${t.sheet};box-shadow:0 22px 44px -28px rgba(0,0,0,.55)">
            <div style="flex:1;display:flex;flex-direction:column;justify-content:center;gap:18px">
              <div style="display:flex;align-items:center;gap:18px">
                <div style="width:76px;height:76px">${logo.replace("<svg ", '<svg width="76" height="76" ')}</div>
                <div style="font-family:'Source Serif 4',serif;font-weight:600;font-size:64px;line-height:1;color:${t.fg};letter-spacing:-0.5px">Drimvox</div>
              </div>
              <div style="font-family:Onest,sans-serif;font-size:24px;line-height:1.4;color:${t.fg};max-width:600px">Нейросети и ИИ-агент в одном приложении: чат с любой моделью или целый проект, который агент делает сам.</div>
              <div style="font-family:'IBM Plex Mono',monospace;font-size:15px;color:${t.muted}">Windows · Linux · свои ключи, подписки или локальные модели</div>
            </div>
            <div style="width:270px;display:flex;flex-direction:column;justify-content:center;gap:16px;font-family:Onest,sans-serif;font-size:16px;line-height:1.45">
              <div style="border-left:2px solid ${t.ink};padding-left:14px;color:${t.ink}">Опрос → план → работа<br>с проверками на телефоне</div>
              <div style="border-left:2px solid ${t.ok};padding-left:14px;color:${t.ok}">60+ провайдеров,<br>бесплатные модели отмечены</div>
              <div style="border-left:2px solid ${t.pencil};padding-left:14px;color:${t.pencil};font-family:'Source Serif 4',serif;font-style:italic;font-size:18px">«Сделай сайт клиники с записью»</div>
            </div>
          </div>
        </div>`;
      document.body.append(el);
    },
    { t, logo: LOGO },
  );
  await page.waitForTimeout(400);
  await page.locator("#readme-banner-card").screenshot({ path: join(out, `${name}.png`) });
  await page.evaluate(() => document.getElementById("readme-banner")?.remove());
}

let app: ElectronApplication | undefined;
let fake: FakeProvider | undefined;
const dirs: string[] = [];

test.afterAll(async () => {
  await app?.close();
  await fake?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A screenshot of the window as it is, after the motion settles. */
async function shot(page: Page, name: string) {
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(out, `${name}.png`) });
}

test("README screenshots", async () => {
  test.setTimeout(240_000);
  mkdirSync(out, { recursive: true });
  const userData = mkdtempSync(join(tmpdir(), "drimvox-shots-"));
  // Plain folder names and paths, so nothing of the machine shows on the pictures.
  const root = existsSync("C:\\") ? "C:\\Projects" : join(tmpdir(), "Projects");
  const site = join(root, "ulybka-site");
  const project = join(root, "ulybka");
  // A folder this script makes goes again at the end; one that was there keeps all but the examples.
  const made = !existsSync(root);
  for (const dir of [site, project]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
  dirs.push(userData, ...(made ? [root] : [site, project]));
  writeFileSync(join(site, "index.html"), PAGE);
  for (const dir of [site, project]) {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Drimvox");
    git("config", "user.email", "shots@example.com");
    writeFileSync(join(dir, "README.md"), "# Стоматология «Улыбка»\n");
    git("add", "-A");
    git("commit", "-q", "-m", "Start");
  }

  // Each scene takes its turns from its own queue, in order.
  const queue: FakeTurn[] = [];
  fake = await startFakeProvider({
    key: KEY,
    models: MODELS,
    title: (model) => (model ? "Схема записи пациента" : null),
    respond: () => queue.shift() ?? { text: "Готово." },
  });
  let folder = site;
  app = await electron.launch({ args: [mainJs], env: { ...process.env, DRIMVOX_USER_DATA: userData, DRIMVOX_TEST_PICK_FOLDER: site, DRIMVOX_TEST_USD_RUB: "80" } });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    win.unmaximize();
    win.setSize(1440, 900);
    win.center();
  });
  await expect(paramsButton(page)).toBeVisible();
  await page.waitForTimeout(3500);

  // Keys and models: the providers grouped by what is free.
  await openSection(page, "Ключи и модели");
  await page.getByRole("radio", { name: /OpenAI-совместимый/ }).click();
  await page.getByLabel("Название").fill("OpenRouter");
  await page.getByLabel("Адрес API").fill(fake.baseUrl);
  await page.getByLabel("Ключ API, если нужен").fill(KEY);
  await page.getByRole("button", { name: "Подключить", exact: true }).click();
  await expect(page.getByText("Моделей: 5")).toBeVisible();
  await page.getByRole("heading", { name: "Подключить провайдера" }).scrollIntoViewIfNeeded();
  await shot(page, "providers");

  // A new chat.
  await page.getByRole("button", { name: "Назад" }).click();
  await newChat(page);

  // The model picker.
  await page.getByRole("button", { name: "Выбери модель" }).click();
  await shot(page, "models");
  await page.getByRole("option", { name: /DeepSeek V4 Flash/ }).click();

  // A chat with the clinic's folder: a diagram, the files it touched, the margin.
  await page.locator(".composer").getByRole("button", { name: "Параметры", exact: true }).click();
  await page.getByRole("button", { name: "Папка" }).click();
  await page.keyboard.press("Escape");
  queue.push(
    call("read_file", { path: "index.html" }),
    call("edit_file", { path: "index.html", old: "<button>Записаться</button>", new: '<label>Код из SMS <input name="code"></label>\n    <button>Подтвердить запись</button>' }),
    { text: DIAGRAM },
  );
  const box = page.getByRole("textbox", { name: /Сообщение/ });
  await box.fill("Нарисуй, как пациент записывается на приём, и поправь форму записи под эту схему");
  await box.press("Enter");
  await expect(page.locator(".diagram svg")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".file-chip")).toHaveCount(1);
  await shot(page, "chat");

  // The diagram over the window.
  await page.getByRole("button", { name: "Открыть диаграмму" }).click();
  await shot(page, "diagram");
  await page.keyboard.press("Escape");

  // The skills' catalog.
  await openSection(page, "Настройки");
  await page.getByRole("tab", { name: "Скиллы" }).click();
  await shot(page, "skills");
  await page.getByRole("button", { name: "Назад" }).click();

  // A project from scratch: the interview with choices, the plan, the work.
  folder = project;
  await app.evaluate((_e, dir) => (process.env.DRIMVOX_TEST_PICK_FOLDER = dir), folder);
  queue.push(
    call("ask_questions", {
      understood: "Нужен сайт стоматологической клиники «Улыбка» с онлайн-записью к врачу. Пациенты чаще заходят с телефона.",
      unknown: ["Нужна ли оплата на сайте", "Сколько врачей и услуг"],
      questions: [
        {
          id: "booking",
          question: "Как пациент записывается?",
          options: [
            { label: "Выбор врача и времени", description: "Свободные окна из расписания, подтверждение по SMS" },
            { label: "Заявка с обратным звонком", description: "Администратор перезванивает и записывает сам" },
          ],
          recommended: 0,
        },
        {
          id: "style",
          question: "Какой стиль сайта?",
          options: [
            { label: "Светлый и спокойный", description: "Много воздуха, мягкие цвета, фото врачей" },
            { label: "Строгий медицинский", description: "Белый, синий, акцент на лицензиях" },
            { label: "Тёплый семейный", description: "Детский уголок, тёплые цвета" },
          ],
          recommended: 0,
        },
      ],
    }),
    call("ask_questions", { questions: [], understood: "Сайт клиники с записью к врачу и подтверждением по SMS, светлый стиль.", unknown: [] }),
    call("write_plan", {
      summary: "Сайт стоматологии «Улыбка»: услуги и цены, врачи, отзывы и онлайн-запись с выбором врача и времени. Запись подтверждается кодом из SMS; администратор видит записи в простой панели.",
      steps: ["Каркас сайта и общий стиль", "Главная: услуги, врачи, отзывы", "Онлайн-запись: врач, день, время", "Подтверждение по SMS", "Панель администратора", "Проверить на телефоне и компьютере"],
      checks: ["npm run build", "npm test"],
      screens: [
        { name: "Главная", contents: "Первый экран с кнопкой «Записаться», услуги с ценами, врачи, отзывы, адрес и карта" },
        { name: "Запись", contents: "Выбор врача, дня и времени из свободных окон; имя и телефон; код из SMS" },
        { name: "Панель администратора", contents: "Записи на сегодня и неделю, отмена и перенос" },
      ],
      decisions: [
        { what: "Next.js и SQLite", why: "Один небольшой сервер без отдельной базы данных: дёшево держать и просто переносить" },
        { what: "SMS через SMS.ru", why: "Российский сервис с понятными ценами; ключ хранится в .env" },
      ],
    }),
    { ...call("write_file", { path: "index.html", content: PAGE }), delayMs: 600 },
    call("update_checklist", {
      items: [
        { text: "Каркас сайта и общий стиль", done: true },
        { text: "Главная: услуги, врачи, отзывы", done: true },
        { text: "Онлайн-запись: врач, день, время", done: true },
        { text: "Подтверждение по SMS", done: true },
        { text: "Панель администратора", done: true },
        { text: "Проверить на телефоне и компьютере", done: true },
      ],
    }),
    call("finish_work", { report: "Сайт готов: запись к врачу с подтверждением по SMS, панель администратора. Запуск: npm run dev, адрес http://localhost:3000." }),
    { text: "Сайт готов: запись к врачу с подтверждением по SMS, панель администратора. Запуск: npm run dev." },
  );
  await page.getByRole("button", { name: "Проекты", exact: true }).click();
  await addProject(page);
  await page.getByLabel("Что сделать?").fill("Сайт стоматологической клиники «Улыбка» с онлайн-записью к врачу");
  // The last model of the chat is picked already; the project gets a stronger one.
  await page.getByRole("group", { name: "Модели" }).getByRole("button", { name: /DeepSeek V4 Flash/ }).first().click();
  await page.getByRole("option", { name: /Claude Sonnet 5.5/ }).click();
  await page.getByRole("button", { name: "Начать опрос" }).click();
  await expect(page.getByText("Как пациент записывается?")).toBeVisible({ timeout: 30_000 });
  await shot(page, "project-interview");
  for (const option of ["Выбор врача и времени", "Светлый и спокойный"]) await page.getByText(option, { exact: true }).click();
  await page.getByRole("button", { name: "Ответить" }).click();
  const plan = page.getByRole("region", { name: "Итоговый план" });
  await expect(plan).toContainText("стоматологии «Улыбка»", { timeout: 30_000 });
  await shot(page, "project-plan");
  await plan.getByRole("button", { name: "Начать работу" }).click();
  await expect(page.locator(".topbar").getByRole("status")).toContainText("Готово", { timeout: 60_000 });
  await shot(page, "project-work");

  // The same in the dark theme.
  await openSection(page, "Настройки");
  await page.getByRole("tab", { name: "Общие" }).click();
  await page.getByRole("radio", { name: "Тёмное" }).click();
  await page.getByRole("button", { name: "Назад" }).click();
  await shot(page, "project-work-dark");

  await banner(page, "banner", false);
  await banner(page, "banner-dark", true);
});
