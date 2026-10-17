import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider, type FakeTurn } from "./fake-provider";
import { makeRepo } from "./git-repo";

const KEY = "good-key";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
let env: TestEnv;
let fake: FakeProvider | undefined;
let repo: string;
const shots: { url: string; width: number }[] = [];

beforeEach(() => {
  env = createTestEnv();
  shots.length = 0;
  env.setScreenshot(async (url, size) => {
    shots.push({ url, width: size.width });
    return PNG;
  });
  repo = makeRepo({ "package.json": '{ "type": "module" }\n', "index.html": "<h1>Меню</h1>\n" });
});

afterEach(async () => {
  await env.closeAsync();
  await fake?.close();
  fake = undefined;
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const call = (name: string, args: Record<string, unknown>): FakeTurn => ({ toolCalls: [{ name, args }] });
const finish = call("finish", { summary: "Готово", commit_message: "Add the menu page" });
const write = (path: string, content: string) => call("write_file", { path, content });

const BRIEF = {
  direction: "Меловая доска",
  concept: "Меню как на доске мелом в маленькой кофейне",
  palette: [
    { role: "фон", hex: "#1F2A24" },
    { role: "текст", hex: "#F4EFE6" },
    { role: "акцент", hex: "#E0A458" },
  ],
  fonts: { heading: { name: "Amatic SC", kind: "handwritten" }, body: { name: "PT Sans", kind: "sans-serif" } },
  rules: ["Скругления 4 px", "Без теней"],
};
const STORED_BRIEF = { ...BRIEF, fonts: { heading: { name: "Amatic SC", kind: "hand" }, body: { name: "PT Sans", kind: "sans" } } };
const page = write("index.html", "<h1>Меню</h1>\n<p>Капучино</p>\n");
const PAGE = { url: "http://localhost:5173/", expect: "Видно меню" };
const R1 = { id: "R1", text: "Есть страница с меню", verify: "visual", how: "открыть главную" };
const POLISH = "POLISH\n- Заголовок меню мелкий: сделать 48 px\n- На телефоне кнопки налезают друг на друга: перенести в столбик";

interface Script {
  coder?: FakeTurn[];
  lead?: FakeTurn[];
  subs?: Record<string, FakeTurn[]>;
  acceptor?: FakeTurn[];
  /** The vision model's answers to the design review, in order. */
  design?: string[];
  /** Its description of a style sample. */
  style?: string;
}

const textOf = (body: any) => JSON.stringify(body.messages ?? []);
const isAcceptor = (body: any) => /acceptance agent/i.test(JSON.stringify(body.messages?.[0]?.content ?? ""));
const isDesignReview = (body: any) => body.model === "eyes" && /design review/i.test(textOf(body));
const isStyleLook = (body: any) => body.model === "eyes" && /visual style/i.test(textOf(body));

async function start(s: Script, o: { stages?: Record<string, boolean>; vision?: boolean; team?: boolean } = {}) {
  const q = { coder: [...(s.coder ?? [])], lead: [...(s.lead ?? [])], acceptor: [...(s.acceptor ?? [])], design: [...(s.design ?? [])] };
  const subs = Object.fromEntries(Object.entries(s.subs ?? {}).map(([k, v]) => [k, [...v]]));
  fake = await startFakeProvider({
    key: KEY,
    models: [
      { id: "coder", architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
      { id: "lead", architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
      { id: "judge", architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
      { id: "eyes", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
    ],
    respond: (body) => {
      if (isAcceptor(body)) return q.acceptor.shift() ?? { text: "Done." };
      if (isDesignReview(body)) return { text: q.design.shift() ?? "GOOD" };
      if (isStyleLook(body)) return { text: s.style ?? "—" };
      if (body.model === "eyes") return { text: "PASS: всё видно" };
      if (body.model === "lead") return q.lead.shift() ?? { text: "Done." };
      const sub = textOf(body).match(/Subtask id: ([\w-]+)/)?.[1];
      if (sub) return subs[sub]?.shift() ?? { text: "Done." };
      return q.coder.shift() ?? { text: "Done." };
    },
  });
  const provider = await (await env.call("POST", "/api/providers", { preset: "custom", baseUrl: fake.baseUrl, apiKey: KEY })).json();
  await env.call("PATCH", "/api/settings", { acceptanceModel: { providerId: provider.id, model: "judge" } });
  if (o.vision !== false) await env.call("PATCH", "/api/settings", { visionModel: { providerId: provider.id, model: "eyes" } });
  const project = await (await env.call("POST", "/api/projects", { path: repo })).json();
  const res = await env.call("POST", `/api/projects/${project.id}/tasks`, {
    task: "Сделай страницу меню для кофейни",
    providerId: provider.id,
    model: o.team ? "lead" : "coder",
    ...(o.team ? { team: { providerId: provider.id, model: "coder" } } : {}),
    stages: { interview: false, spec: true, approveSpec: false, testsFirst: false, ...o.stages },
  });
  expect(res.status).toBe(201);
  return (await res.json()).id as string;
}

async function waitFor(id: string, check: (task: any) => boolean, timeoutMs = 20_000): Promise<any> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const task = await (await env.call("GET", `/api/tasks/${id}`)).json();
    if (check(task)) return task;
    if (Date.now() > until) throw new Error(`stuck: ${task.status}/${task.statusReason}/${task.phase}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}
const settled = (t: any) => t.status !== "running" && t.status !== "queued";
const events = async (id: string) => (await (await env.call("GET", `/api/tasks/${id}/events`)).json()) as any[];
const chats = () => fake!.requests.filter((r) => r.path === "/v1/chat/completions");
const coderChats = () => chats().filter((r) => r.body.model === "coder" && !isAcceptor(r.body));
const systemOf = (r: { body: any }) => JSON.stringify(r.body.messages.filter((m: any) => m.role === "system"));

const LOOK_QUESTION = {
  id: "look",
  question: "Как должна выглядеть страница?",
  options: [
    {
      label: "Меловая доска",
      description: "Тёмный фон, рукописные заголовки",
      look: { palette: ["#1F2A24", "#F4EFE6", "not-a-colour"], heading: { name: "Amatic SC", kind: "handwritten" }, body: { name: "PT Sans", kind: "sans-serif" } },
    },
    { label: "Журнал", description: "Крупные фото", look: { palette: ["#FFFFFF"], heading: { name: "Playfair Display", kind: "serif" }, body: { name: "Inter", kind: "sans" } } },
  ],
  recommended: 0,
};
const askLook = call("ask_questions", { questions: [LOOK_QUESTION], understood: "Нужна страница меню", unknown: ["Внешний вид"] });
const interview = { interview: true };

describe("the look in the interview", () => {
  it("offers directions with samples of their colours and fonts", async () => {
    const id = await start({ coder: [askLook] }, { stages: interview });
    const task = await waitFor(id, (t) => t.status === "waiting" && t.statusReason === "questions");
    expect(task.questions[0].options[0].look).toEqual({
      palette: ["#1F2A24", "#F4EFE6"],
      heading: { name: "Amatic SC", kind: "hand" },
      body: { name: "PT Sans", kind: "sans" },
    });
    // One colour is no palette: the option stays, its samples do not.
    expect(task.questions[0].options[1].look).toBeUndefined();
    expect(systemOf(coderChats()[0]!)).toMatch(/2-3 directions/);
  });

  it("describes a site the user gave as a sample and passes the description on", async () => {
    const id = await start({ coder: [askLook], style: "Тёмная палитра #111111, шрифт с засечками, много воздуха" }, { stages: interview });
    await waitFor(id, (t) => t.status === "waiting" && t.statusReason === "questions");
    const res = await env.call("POST", `/api/tasks/${id}/answers`, {
      answers: [{ id: "look", answer: "Меловая доска" }],
      reference: { url: "https://example.com/" },
    });
    expect(res.status).toBe(200);
    await waitFor(id, settled);
    expect(shots.map((s) => s.url)).toContain("https://example.com/");
    const told = JSON.stringify(coderChats()[1]!.body.messages);
    expect(told).toContain("Тёмная палитра #111111");
    expect(told).toContain("https://example.com/");
    const ref = (await events(id)).find((e) => e.kind === "reference");
    expect(ref.data).toMatchObject({ url: "https://example.com/", description: "Тёмная палитра #111111, шрифт с засечками, много воздуха" });
    expect(ref.data.shot).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("shows a picture the user gave to the model that sees pictures", async () => {
    const id = await start({ coder: [askLook], style: "Пастель, скруглённые формы" }, { stages: interview });
    await waitFor(id, (t) => t.status === "waiting" && t.statusReason === "questions");
    const image = `data:image/jpeg;base64,${Buffer.from("fake jpeg").toString("base64")}`;
    await env.call("POST", `/api/tasks/${id}/answers`, { answers: [{ id: "look", answer: "Меловая доска" }], reference: { image } });
    await waitFor(id, settled);
    const looked = chats().find((r) => isStyleLook(r.body))!;
    expect(textOf(looked.body)).toContain("data:image/jpeg;base64,");
    expect(JSON.stringify(coderChats()[1]!.body.messages)).toContain("Пастель, скруглённые формы");
    const ref = (await events(id)).find((e) => e.kind === "reference");
    expect(ref.data.shot).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("passes a site on as it is when no model can look at it", async () => {
    const id = await start({ coder: [askLook] }, { stages: interview, vision: false });
    await waitFor(id, (t) => t.status === "waiting" && t.statusReason === "questions");
    await env.call("POST", `/api/tasks/${id}/answers`, { answers: [{ id: "look", answer: "Свой" }], reference: { url: "https://example.com/" } });
    await waitFor(id, settled);
    expect(shots).toEqual([]);
    const told = JSON.stringify(coderChats()[1]!.body.messages);
    expect(told).toContain("https://example.com/");
    expect(told).toMatch(/could not look/);
  });

  it("refuses a sample that is neither a link nor a picture", async () => {
    const id = await start({ coder: [askLook] }, { stages: interview });
    await waitFor(id, (t) => t.status === "waiting" && t.statusReason === "questions");
    const res = await env.call("POST", `/api/tasks/${id}/answers`, { answers: [], reference: { image: "data:text/html;base64,PGgxPg==" } });
    expect(res.status).toBe(400);
  });
});

const specWith = (extra: Record<string, unknown>) =>
  call("propose_spec", { spec: "# Меню\n\nСтраница меню.", checks: [], plan: ["Страница"], requirements: [R1], ...extra });

describe("the design brief", () => {
  it("keeps the brief from the spec and gives it to the coder on every step", async () => {
    const id = await start({ coder: [specWith({ design: BRIEF }), write("index.html", "<h1>Меню</h1>"), finish], acceptor: [judge("Принято")] }, { vision: false });
    const task = await waitFor(id, settled);
    expect(task.design).toEqual(STORED_BRIEF);
    // The spec step is asked for a brief; the code step works to it and is warned off the usual habits.
    expect(systemOf(coderChats()[0]!)).toMatch(/design brief/i);
    const code = systemOf(coderChats()[1]!);
    expect(code).toContain("Меловая доска");
    expect(code).toContain("#E0A458");
    expect(code).toContain("Amatic SC");
    expect(code).toContain("DESIGN.md");
    expect(code).toMatch(/violet-to-blue gradient/);
  });

  // Seen live: a good brief with twelve colours was thrown away whole, and the task went on without a look.
  it("trims a brief that says more than it keeps instead of dropping it", async () => {
    const generous = {
      ...BRIEF,
      direction: "Ночная обсерватория: строгий картографический прибор ".repeat(4),
      concept: "Небо — главный экспонат. ".repeat(60),
      palette: Array.from({ length: 12 }, (_, i) => ({ role: `цвет ${i + 1}`, hex: `#0B12${String(10 + i).padStart(2, "0")}` })),
      rules: Array.from({ length: 15 }, (_, i) => `Правило ${i + 1}`),
    };
    const id = await start({ coder: [specWith({ design: generous }), finish], acceptor: [judge("Принято")] }, { vision: false });
    const task = await waitFor(id, settled);
    expect(task.design).not.toBeNull();
    expect(task.design.palette).toHaveLength(10);
    expect(task.design.rules).toHaveLength(12);
    expect(task.design.direction.length).toBeLessThanOrEqual(120);
    expect(task.design.concept.length).toBeLessThanOrEqual(600);
  });

  it("drops a brief it cannot use instead of failing the spec", async () => {
    const id = await start({ coder: [specWith({ design: { ...BRIEF, palette: [{ role: "фон", hex: "blue" }] } }), finish], acceptor: [judge("Принято")] }, { vision: false });
    const task = await waitFor(id, settled);
    expect(task.design).toBeNull();
    expect(task.requirements).toEqual([R1]);
  });
});

const judge = (summary: string): FakeTurn => call("report_acceptance", { results: [{ id: "R1", status: "done", evidence: "скриншот", problem: "" }], summary });

describe("the design review", () => {
  it("photographs the pages on a desktop and a phone and gives the coder one round of polish", async () => {
    const id = await start({
      coder: [specWith({ design: BRIEF, visual_checks: [PAGE] }), page, finish, write("index.html", "<h1 class=big>Меню</h1>"), finish],
      acceptor: [judge("Принято"), judge("Принято снова")],
      design: [POLISH, "GOOD"],
    });
    const task = await waitFor(id, settled);
    expect(task).toMatchObject({ status: "review", statusReason: null });
    expect(task.designReview).toMatchObject({
      verdict: "polish",
      issues: ["Заголовок меню мелкий: сделать 48 px", "На телефоне кнопки налезают друг на друга: перенести в столбик"],
      model: "eyes",
    });
    expect(task.designReview.shots).toHaveLength(2);
    expect(shots.filter((s) => s.url === PAGE.url).map((s) => s.width)).toEqual(expect.arrayContaining([1280, 390]));

    // The review sees the brief; the coder gets its notes once, and the work is accepted again after the polish.
    const review = chats().find((r) => isDesignReview(r.body))!;
    expect(textOf(review.body)).toContain("Меловая доска");
    expect(JSON.stringify(coderChats().at(-1)!.body.messages)).toContain("Заголовок меню мелкий");
    expect(task.acceptance.round).toBe(2);
    expect(chats().filter((r) => isDesignReview(r.body))).toHaveLength(1);
    expect((await events(id)).filter((e) => e.kind === "design_review")).toHaveLength(1);
  });

  // Seen live: accepted on round 2, then polished, the work went to its last round; one note there would have ended a
  // task with three stages still to do.
  it("does not count the accepted round before a polish against the rework rounds", async () => {
    const partial = call("report_acceptance", { results: [{ id: "R1", status: "partial", evidence: "скриншот", problem: "мелко" }], summary: "Почти" });
    const id = await start({
      coder: [specWith({ design: BRIEF, visual_checks: [PAGE] }), page, finish, finish, finish, finish],
      acceptor: [partial, judge("Принято"), partial, judge("Принято снова")],
      design: [POLISH],
    });
    const task = await waitFor(id, settled);
    expect(task).toMatchObject({ status: "review", statusReason: null });
    expect(task.acceptance.summary).toBe("Принято снова");
  });

  it("sends the work on when the review finds it good", async () => {
    const id = await start({
      coder: [specWith({ design: BRIEF, visual_checks: [PAGE] }), page, finish],
      acceptor: [judge("Принято")],
      design: ["GOOD\nВсё по брифу."],
    });
    const task = await waitFor(id, settled);
    expect(task).toMatchObject({ status: "review", designReview: { verdict: "good", issues: [] } });
    expect(coderChats()).toHaveLength(3);
  });

  it("has nothing to review without a brief", async () => {
    const id = await start({ coder: [specWith({ visual_checks: [PAGE] }), page, finish], acceptor: [judge("Принято")], design: [POLISH] });
    const task = await waitFor(id, settled);
    expect(task).toMatchObject({ status: "review", design: null, designReview: null });
    expect(chats().filter((r) => isDesignReview(r.body))).toHaveLength(0);
  });

  it("says so when there is no model to look at the screens", async () => {
    const id = await start({ coder: [specWith({ design: BRIEF, visual_checks: [PAGE] }), page, finish], acceptor: [judge("Принято")] }, { vision: false });
    const task = await waitFor(id, settled);
    expect(task).toMatchObject({ status: "review", designReview: null });
    expect((await events(id)).some((e) => e.kind === "text" && /design review/i.test(e.data.text))).toBe(true);
  });
});

describe("the design in a team", () => {
  const goalPlan = call("propose_plan", {
    spec: "# Меню\n\nСтраница меню.",
    checks: [],
    requirements: [R1],
    design: BRIEF,
    visual_checks: [PAGE],
    commit_message: "Add the menu page",
    subtasks: [{ id: "ui", title: "Страница", description: "Сверстай меню", dependsOn: [], checks: [] }],
  });

  it("gives every subtask the brief and adds a polish subtask after the review", async () => {
    const id = await start(
      {
        lead: [goalPlan],
        subs: { ui: [write("index.html", "<h1>Меню</h1>"), finish], "fix-1": [write("menu.css", "h1 { font-size: 48px }"), finish] },
        acceptor: [judge("Принято"), judge("Принято снова")],
        design: [POLISH],
      },
      { team: true },
    );
    const task = await waitFor(id, settled, 30_000);
    expect(task).toMatchObject({ status: "review", design: STORED_BRIEF, designReview: { verdict: "polish" } });
    expect(task.visualChecks).toEqual([PAGE]);
    const polish = task.subtasks.find((s: any) => s.id === "fix-1");
    expect(polish).toMatchObject({ title: "Polish the design after the review", status: "merged" });

    const worker = chats().find((r) => /Subtask id: ui/.test(textOf(r.body)))!;
    expect(systemOf(worker)).toContain("Меловая доска");
    const fixer = chats().find((r) => /Subtask id: fix-1/.test(textOf(r.body)))!;
    expect(textOf(fixer.body)).toContain("Заголовок меню мелкий");
    // The lead is told how a team builds a look: the foundation first.
    expect(systemOf(chats().find((r) => r.body.model === "lead")!)).toMatch(/design-system/);
  });
});
