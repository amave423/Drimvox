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
/** Addresses the served page was asked for: what a scenario's clicks did. */
const hits: string[] = [];

test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), "drimvox-e2e-"));
  repo = makeRepo({ "index.html": "<h1>Привет</h1>\n" });
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

/** The app the agent "built": a page on this computer. */
/** A long page: what is below the first screen must be in the picture too. */
const LONG_PAGE =
  '<body style="margin:0;background:#c0392b"><h1 style="color:white;font:64px sans-serif;padding:40px">Привет, Drimvox</h1>' +
  '<div style="height:2200px"></div><footer style="color:white;font:32px sans-serif">Контакты внизу</footer></body>';

async function serveSite(html = LONG_PAGE): Promise<string> {
  hits.length = 0;
  site = createServer((req, res) => {
    hits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((r) => site!.listen(0, "127.0.0.1", r));
  const address = site.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return `http://localhost:${address.port}/`;
}

/** An agent looks at the page; returns the screenshot the model got. */
async function lookAt(html?: string, steps?: unknown[]): Promise<Buffer> {
  const url = await serveSite(html);
  // The coder sees pictures itself, so it also checks its own screenshots.
  const coder: FakeTurn[] = [
    { toolCalls: [{ name: "look_at_page", args: { url, question: "Виден заголовок «Привет, Drimvox»?", ...(steps ? { steps } : {}) } }] },
    { toolCalls: [{ name: "finish", args: { summary: "Проверил страницу.", commit_message: "Check" } }] },
  ];
  fake = await startFakeProvider({
    key: KEY,
    models: [{ id: "coder", name: "Coder", supported_parameters: ["tools"], architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } }],
    respond: (body) =>
      JSON.stringify(body.messages).includes("data:image/png;base64,") && !body.tools
        ? { text: "Да: белый заголовок «Привет, Drimvox» на красном фоне." }
        : (coder.shift() ?? { text: "Done." }),
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
  await startTask(page, { task: "Проверь, как выглядит страница", model: "coder" });

  await expect(page.getByText("Проверил страницу.")).toBeVisible({ timeout: 30_000 });
  await page.getByText("Как агент работал").click();
  const shot = page.getByRole("img", { name: `Скриншот ${url}` });
  await expect(shot).toBeVisible();
  expect(await shot.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(600);

  const sent = fake.requests.find((r) => JSON.stringify(r.body?.messages ?? "").includes("data:image/png;base64,"))!;
  const dataUrl = JSON.stringify(sent.body.messages).match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/)![1]!;
  return Buffer.from(dataUrl, "base64");
}

test("an agent looks at its page: a real screenshot goes to the model and into the feed", async () => {
  const png = await lookAt();
  // The model got a real PNG of the page, not an empty picture.
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  expect(png.length).toBeGreaterThan(5000);
  // The whole page, not only its first screen (PNG height sits at byte 20).
  expect(png.readUInt32BE(20)).toBeGreaterThan(2000);
});

// Seen live: a site scrolled inside a full-screen container; the screenshot showed its first screen only.
test("a page that scrolls inside its own container is photographed whole", async () => {
  const png = await lookAt(
    '<body style="margin:0;overflow:hidden"><main style="height:100vh;overflow-y:auto;background:#1f2a24">' +
      '<h1 style="color:white;font:64px sans-serif;padding:40px">Привет, Drimvox</h1><div style="height:2200px"></div>' +
      '<footer style="color:white;font:32px sans-serif">Подвал</footer></main></body>',
  );
  expect(png.readUInt32BE(20)).toBeGreaterThan(2000);
});

// docs/specs/project-work.md: the agent goes through a scenario as a person would, in the same hidden window.
test("an agent goes through a scenario on its page: types into a field by its label, clicks a button by its text", async () => {
  await lookAt(
    '<h1>Привет, Drimvox</h1><label>Длина, м <input id="len"></label>' +
      "<button onclick=\"fetch('/clicked?len=' + document.getElementById('len').value)\">В корзину</button>",
    [
      { action: "type", target: "Длина, м", text: "6" },
      { action: "click", target: "В корзину" },
    ],
  );
  expect(hits).toContain("/clicked?len=6");
});
