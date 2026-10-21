import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyTree, removeTree } from "../src/fsx";
import { parseSkill } from "../src/skills/skills";
import { createTestEnv, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider, type FakeTurn } from "./fake-provider";
import { git, makeRepo } from "./git-repo";

const KEY = "good-key";
let env: TestEnv;
let fake: FakeProvider | undefined;
let repo: string;

beforeEach(() => {
  env = createTestEnv();
  repo = makeRepo({
    "index.html": "<h1>Hi</h1>\n",
    ".claude/skills/house-style/SKILL.md": "---\nname: house-style\ndescription: Как у нас пишут CSS\n---\nТолько токены из tokens.css.\n",
  });
});

afterEach(async () => {
  await env.closeAsync();
  await fake?.close();
  fake = undefined;
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("SKILL.md", () => {
  it("reads the name, the description and the instructions", () => {
    expect(parseSkill('---\nname: pdf-tools\ndescription: "Работа с PDF: склейка, текст"\n---\n\n# PDF\nДелай так.\n', "fallback")).toEqual({
      name: "pdf-tools",
      description: "Работа с PDF: склейка, текст",
      body: "# PDF\nДелай так.",
    });
  });

  it("falls back to the folder name and the first line", () => {
    expect(parseSkill("Просто инструкция без заголовка.\nВторая строка.", "notes")).toEqual({
      name: "notes",
      description: "Просто инструкция без заголовка.",
      body: "Просто инструкция без заголовка.\nВторая строка.",
    });
  });
});

describe("files", () => {
  it("copies and removes folders, Cyrillic paths included", () => {
    const base = mkdtempSync(join(tmpdir(), "artel-фс-"));
    const from = join(base, "исходник");
    mkdirSync(join(from, "вложенная"), { recursive: true });
    writeFileSync(join(from, "вложенная", "файл.txt"), "привет");
    copyTree(from, join(base, "копия"));
    expect(readFileSync(join(base, "копия", "вложенная", "файл.txt"), "utf8")).toBe("привет");
    removeTree(join(base, "копия"));
    expect(existsSync(join(base, "копия"))).toBe(false);
    removeTree(base);
    expect(existsSync(base)).toBe(false);
  });
});

describe("skills in Drimvox", () => {
  it("creates, lists and deletes a shared skill", async () => {
    const created = await env.call("POST", "/api/skills", { name: "Отчёты", description: "Как оформлять отчёты", instructions: "Сначала вывод, потом детали." });
    expect(created.status).toBe(201);
    const list = await (await env.call("GET", "/api/skills")).json();
    expect(list).toEqual([{ name: "otchety", description: "Как оформлять отчёты", scope: "shared", path: expect.stringContaining("otchety") }]);
    expect(readFileSync(join(list[0].path, "SKILL.md"), "utf8")).toContain("Сначала вывод");
    expect((await env.call("POST", "/api/skills", { name: "otchety", description: "x", instructions: "y" })).status).toBe(409);
    expect((await env.call("DELETE", "/api/skills/otchety")).status).toBe(204);
    expect(await (await env.call("GET", "/api/skills")).json()).toEqual([]);
  });

  it("imports a skill folder with its files", async () => {
    const folder = mkdtempSync(join(tmpdir(), "artel-skill-"));
    writeFileSync(join(folder, "SKILL.md"), "---\nname: brand\ndescription: Фирменный стиль\n---\nСмотри palette.md.\n");
    writeFileSync(join(folder, "palette.md"), "синий #2b4c7e\n");
    const res = await env.call("POST", "/api/skills/import", { path: folder });
    expect(res.status).toBe(201);
    const [skill] = await (await env.call("GET", "/api/skills")).json();
    expect(skill.name).toBe("brand");
    expect(readFileSync(join(skill.path, "palette.md"), "utf8")).toContain("синий");
    rmSync(folder, { recursive: true, force: true });
  });

  it("lists a project's own skills", async () => {
    const project = await (await env.call("POST", "/api/projects", { path: repo })).json();
    const skills = await (await env.call("GET", `/api/projects/${project.id}/skills`)).json();
    expect(skills).toEqual([{ name: "house-style", description: "Как у нас пишут CSS", scope: "project", path: ".claude/skills/house-style" }]);
  });
});

describe("skills for agents", () => {
  async function run(script: FakeTurn[]) {
    await env.call("POST", "/api/skills/import", { path: makeSharedSkill() });
    fake = await startFakeProvider({ key: KEY, script, models: [{ id: "coder" }] });
    const provider = await (await env.call("POST", "/api/providers", { preset: "custom", baseUrl: fake.baseUrl, apiKey: KEY })).json();
    const project = await (await env.call("POST", "/api/projects", { path: repo })).json();
    const stages = { interview: false, spec: false, approveSpec: false, testsFirst: false };
    const task = await (await env.call("POST", `/api/projects/${project.id}/tasks`, { task: "Сделай отчёт", providerId: provider.id, model: "coder", stages })).json();
    for (let i = 0; i < 300; i++) {
      const t = await (await env.call("GET", `/api/tasks/${task.id}`)).json();
      if (t.status !== "running") return task.id as string;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("task stuck");
  }

  function makeSharedSkill(): string {
    const folder = mkdtempSync(join(tmpdir(), "artel-skill-"));
    writeFileSync(join(folder, "SKILL.md"), "---\nname: reports\ndescription: Как оформлять отчёты\n---\nПиши вывод первой строкой. Шаблон: template.md\n");
    writeFileSync(join(folder, "template.md"), "# Вывод\n");
    return folder;
  }

  it("sees the list, opens a skill and reads its file", async () => {
    const id = await run([
      { toolCalls: [{ name: "use_skill", args: { name: "reports" } }] },
      { toolCalls: [{ name: "read_skill_file", args: { name: "reports", path: "template.md" } }] },
      { toolCalls: [{ name: "use_skill", args: { name: "house-style" } }] },
      { toolCalls: [{ name: "finish", args: { summary: "Готово", commit_message: "Done" } }] },
    ]);
    const first = fake!.requests.find((r) => r.path === "/v1/chat/completions")!.body;
    const system = first.messages[0].content as string;
    expect(system).toContain("reports: Как оформлять отчёты");
    expect(system).toContain("house-style: Как у нас пишут CSS");
    expect(first.tools.map((t: any) => t.function.name)).toEqual(expect.arrayContaining(["use_skill", "read_skill_file"]));

    const results = (await (await env.call("GET", `/api/tasks/${id}/events`)).json()).filter((e: any) => e.kind === "tool_result");
    expect(results[0].data.output).toContain("Пиши вывод первой строкой");
    expect(results[0].data.output).toContain("template.md");
    expect(results[1].data.output).toContain("# Вывод");
    expect(results[2].data.output).toContain("Только токены из tokens.css");
    expect(git(repo, "status", "--porcelain")).toBe("");
  });
});
