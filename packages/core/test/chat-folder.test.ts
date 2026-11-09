import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, readEvents, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider, type FakeTurn } from "./fake-provider";
import { git, makeRepo } from "./git-repo";
import { FOLDER_STEPS } from "../src/chats/folder";
import { filesOf } from "@drimvox/shared";

const KEY = "good-key";
let env: TestEnv;
let fake: FakeProvider | undefined;
let folder: string;

beforeEach(() => {
  env = createTestEnv();
  folder = makeRepo({ "app.js": "export const a = 1;\n" });
});

afterEach(async () => {
  env.close();
  await fake?.close();
  fake = undefined;
  rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const call = (name: string, args: Record<string, unknown>): FakeTurn => ({ toolCalls: [{ name, args }] });

async function chatWith(script: FakeTurn[], models: Record<string, unknown>[] = [{ id: "coder" }]) {
  fake = await startFakeProvider({ key: KEY, script, models });
  const provider = await (await env.call("POST", "/api/providers", { preset: "custom", name: "Fake", baseUrl: fake.baseUrl, apiKey: KEY })).json();
  return (await (await env.call("POST", "/api/chats", { providerId: provider.id, model: models[0]!.id })).json()) as { id: string };
}
const connect = (chatId: string, path: string | null) => env.call("PATCH", `/api/chats/${chatId}/folder`, { folder: path });
const send = (chatId: string, content: string) => env.call("POST", `/api/chats/${chatId}/messages`, { content });

describe("a chat with a folder", () => {
  it("works right in the folder, and one answer can be undone", async () => {
    const chat = await chatWith([
      call("read_file", { path: "app.js" }),
      call("write_file", { path: "hello.txt", content: "привет\n" }),
      call("edit_file", { path: "app.js", old: "a = 1", new: "a = 2" }),
      // Several files in one call: the chat's list of files has each of them.
      call("edit_file", { edits: [{ path: "app.js", old: "a = 2", new: "a = 3" }, { path: "hello.txt", old: "привет", new: "здравствуй" }] }),
      { text: "Создал hello.txt и поменял a." },
    ]);
    const res = await connect(chat.id, folder);
    expect(res.status).toBe(200);
    expect((await res.json()).folder).toBe(folder);

    const events = await readEvents(await send(chat.id, "Создай hello.txt и поменяй a на 2"));
    expect(events.filter((e: any) => e.type === "tool").map((e: any) => e.name)).toEqual(["read_file", "write_file", "edit_file", "edit_file"]);
    expect(readFileSync(join(folder, "hello.txt"), "utf8")).toBe("здравствуй\n");
    expect(readFileSync(join(folder, "app.js"), "utf8")).toBe("export const a = 3;\n");
    const answer = events.at(-1).message;
    expect(answer).toMatchObject({ content: "Создал hello.txt и поменял a.", canUndo: true });
    // What the model did stays with the answer: a chat opened later still shows it.
    const saved = (await (await env.call("GET", `/api/chats/${chat.id}`)).json()).messages.at(-1);
    expect(saved.activity.map(({ at: _at, ...e }: any) => e)).toEqual([
      { name: "read_file", input: "app.js" },
      { name: "write_file", input: "hello.txt" },
      { name: "edit_file", input: "app.js" },
      { name: "edit_file", input: "app.js\nhello.txt" },
    ]);
    // The files it made or used are attached to the answer, each once, with the most it did; they can be looked at.
    expect(filesOf(saved.activity)).toEqual([
      { path: "app.js", touch: "changed" },
      { path: "hello.txt", touch: "written" },
    ]);
    const shown = await env.call("GET", `/api/chats/${chat.id}/file?path=hello.txt`);
    expect(shown.status).toBe(200);
    expect(shown.headers.get("content-security-policy")).toBe("sandbox");
    expect(await shown.text()).toBe("здравствуй\n");
    expect((await env.call("GET", `/api/chats/${chat.id}/file?path=../outside.txt`)).status).toBe(400);
    expect((await env.call("GET", `/api/chats/${chat.id}/file?path=nothing.txt`)).status).toBe(404);
    // The model works in the user's files; git stays the user's.
    expect(git(folder, "log", "--oneline").split("\n")).toHaveLength(1);

    expect((await env.call("POST", `/api/chats/${chat.id}/messages/${answer.id}/undo`)).status).toBe(200);
    expect(existsSync(join(folder, "hello.txt"))).toBe(false);
    expect(readFileSync(join(folder, "app.js"), "utf8")).toBe("export const a = 1;\n");
    const after = (await (await env.call("GET", `/api/chats/${chat.id}`)).json()).messages.at(-1);
    expect(after.canUndo).toBe(false);
  });

  // Seen live: a task took all 40 steps on tools, the last one too, and the answer came empty, called "thought a lot and
  // did not answer" though the files were made. The last step is for the summary: no tools, a word on what is done.
  // Seen live: the context bar showed the sum over an answer's 43 steps, 1.6 million tokens, far past the model's window;
  // and a model, its old answers kept as text only, wrote "I checked…" with no tool called.
  it("keeps the last step's context, and tells the next answer which tools the earlier one called", async () => {
    const chat = await chatWith([
      { toolCalls: [{ name: "read_file", args: { path: "app.js" } }], usage: { prompt_tokens: 5_000, completion_tokens: 100 } },
      { text: "В app.js a = 1.", usage: { prompt_tokens: 6_000, completion_tokens: 50 } },
      { text: "Да." },
    ]);
    await connect(chat.id, folder);
    const answer = (await readEvents(await send(chat.id, "Что в app.js?"))).at(-1).message;
    expect(answer).toMatchObject({ inputTokens: 11_000, contextTokens: 6_050 });
    await readEvents(await send(chat.id, "Точно?"));
    const second = JSON.stringify(fake!.requests.filter((r) => r.path === "/v1/chat/completions").at(-1)!.body.messages);
    expect(second).toContain("[Drimvox: tools called in this answer: read_file.");
    expect(second).toContain("Never say you checked");
  });

  it("ends with a summary when the steps run out, not with an empty answer", async () => {
    const chat = await chatWith([...Array.from({ length: FOLDER_STEPS - 1 }, () => call("list_files", { path: "." })), { text: "Сделал шаблон; осталось проверить сноски." }]);
    await connect(chat.id, folder);
    const events = await readEvents(await send(chat.id, "Сделай шаблон"));
    const answer = events.at(-1).message;
    expect(answer).toMatchObject({ status: "done", content: "Сделал шаблон; осталось проверить сноски.", error: { code: "step_limit" } });
    const last = fake!.requests.filter((r) => r.path === "/v1/chat/completions").at(-1)!.body;
    expect(last.tool_choice).toBe("none");
    expect(JSON.stringify(last.messages)).toMatch(/last step/i);
  });

  // Seen live: "…the project folder.The folder is empty…": what the model said between tool calls ran together.
  it("keeps what the model says before and after its tool calls apart", async () => {
    const chat = await chatWith([{ text: "Смотрю папку.", toolCalls: [{ name: "list_files", args: { path: "." } }] }, { text: "Готово." }]);
    await connect(chat.id, folder);
    const events = await readEvents(await send(chat.id, "Что в папке?"));
    expect(events.at(-1).message.content).toBe("Смотрю папку.\n\nГотово.");
  });

  it("offers no undo for an answer that changed nothing, and stays inside the folder", async () => {
    writeFileSync(join(folder, "..", "outside-secret.txt"), "secret\n");
    const chat = await chatWith([call("read_file", { path: "../outside-secret.txt" }), { text: "Не могу прочитать." }]);
    await connect(chat.id, folder);
    const events = await readEvents(await send(chat.id, "Прочитай ../outside-secret.txt"));
    expect(events.at(-1).message.canUndo).toBe(false);
    const toolResult = JSON.stringify(fake!.requests.filter((r) => r.path === "/v1/chat/completions").at(-1)!.body.messages);
    expect(toolResult).not.toContain("secret\\n");
    rmSync(join(folder, "..", "outside-secret.txt"), { force: true });
  });

  // Asked for: a switch that lets the folder's commands run without a card to click each time.
  it("runs a command that would ask without asking when the switch is on", async () => {
    await env.call("PATCH", "/api/settings", { folderAutoApprove: true });
    const chat = await chatWith([call("run_command", { command: "git push", purpose: "Отправить" }), { text: "Готово." }]);
    await connect(chat.id, folder);
    const events = await readEvents(await send(chat.id, "Отправь"));
    expect(events.some((e: any) => e.type === "approval")).toBe(false);
    expect(events.at(-1).message.content).toBe("Готово.");
    const asked = JSON.stringify(fake!.requests.filter((r) => r.path === "/v1/chat/completions").at(-1)!.body.messages);
    expect(asked).not.toContain("denied");
  });

  // Seen in the user's chats: one answer with 22 pages took 1.2 million input tokens, every step resending all of them.
  // Asked for: as OpenCode, the agent keeps what it read; shortened at every step, it read the same files again and again.
  it("sends a long answer's history whole while it is far from the model's limit", async () => {
    writeFileSync(join(folder, "big.txt"), "строка данных\n".repeat(1000));
    const listing = Array.from({ length: 17 }, () => call("list_files", { path: "." }));
    const chat = await chatWith([call("read_file", { path: "big.txt" }), ...listing, call("read_file", { path: "big.txt" }), { text: "Прочитал." }]);
    await connect(chat.id, folder);
    await readEvents(await send(chat.id, "Прочитай big.txt"));
    const last = fake!.requests.filter((r) => r.path === "/v1/chat/completions").at(-1)!.body.messages as { role: string; content: unknown }[];
    const outputs = last.filter((m) => m.role === "tool").map((m) => String(m.content));
    expect(outputs[0]).not.toContain("trimmed by Drimvox");
    expect(outputs[0]!.length).toBeGreaterThan(10_000);
  });

  it("sends older outputs shortened and the newest ones whole once the history is half way to the limit", async () => {
    writeFileSync(join(folder, "big.txt"), "строка данных\n".repeat(1000));
    // Enough steps for the line between shortened and whole, which moves by a stride, to pass the first read.
    const listing = Array.from({ length: 17 }, () => call("list_files", { path: "." }));
    const chat = await chatWith(
      [call("read_file", { path: "big.txt" }), ...listing, call("read_file", { path: "big.txt" }), { text: "Прочитал." }],
      // A window of 12 thousand tokens: half way to its limit is about 17 thousand characters.
      [{ id: "coder", context_length: 12_000 }],
    );
    await connect(chat.id, folder);
    await readEvents(await send(chat.id, "Прочитай big.txt"));
    const last = fake!.requests.filter((r) => r.path === "/v1/chat/completions" && !JSON.stringify(r.body.messages?.[0] ?? "").includes("working memory")).at(-1)!.body.messages as { role: string; content: unknown }[];
    const outputs = last.filter((m) => m.role === "tool").map((m) => String(m.content));
    expect(outputs.some((o) => o.includes("trimmed by Drimvox"))).toBe(true);
    expect(outputs.at(-1)!.length).toBeGreaterThan(10_000);
  });

  // Asked for: many actions in one step (as OpenCode's Code Mode): two files read with one call of the model.
  it("reads several files in one step through the execute tool, each read in the feed", async () => {
    writeFileSync(join(folder, "a.txt"), "первый файл");
    writeFileSync(join(folder, "b.txt"), "второй файл");
    const code = 'const out = []; for (const p of ["a.txt", "b.txt"]) out.push(await tools.read_file({ path: p })); return out.join(" | ");';
    const chat = await chatWith([call("execute", { code }), { text: "Прочитал оба." }]);
    await connect(chat.id, folder);
    await readEvents(await send(chat.id, "Прочитай a.txt и b.txt"));
    const asks = fake!.requests.filter((r) => r.path === "/v1/chat/completions");
    expect(asks).toHaveLength(2);
    const result = JSON.stringify(asks[1]!.body.messages);
    expect(result).toContain("первый файл");
    expect(result).toContain("второй файл");
    const saved = await (await env.call("GET", `/api/chats/${chat.id}`)).json();
    const names = saved.messages.at(-1).activity.map((a: any) => a.name);
    expect(names.filter((n: string) => n === "read_file")).toHaveLength(2);
  });

  it("has no file tools without a folder", async () => {
    const chat = await chatWith([{ text: "Привет" }]);
    await readEvents(await send(chat.id, "Привет"));
    const tools = (fake!.requests.find((r) => r.path === "/v1/chat/completions")!.body.tools ?? []).map((t: any) => t.function.name);
    expect(tools).not.toContain("write_file");
  });

  it("refuses a folder that is not there, and a model that cannot use tools", async () => {
    const chat = await chatWith([], [{ id: "plain", supported_parameters: ["temperature"] }]);
    expect((await connect(chat.id, join(folder, "missing"))).status).toBe(400);
    const res = await connect(chat.id, folder);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "no_tools" } });
    expect((await connect(chat.id, null)).status).toBe(200);
  });

  // Seen live: DeepSeek V4.1 Flash, which sees pictures, said in a chat with a folder that it could not see the pictures
  // in it and measured their pixels with scripts instead.
  it("lets the model look at a picture in the folder through a model that sees pictures", async () => {
    writeFileSync(join(folder, "ref.png"), Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
    const chatTurns: FakeTurn[] = [call("look_at_image", { path: "ref.png", question: "Что на картинке?" }), { text: "На референсе оранжевый круг." }];
    fake = await startFakeProvider({
      key: KEY,
      models: [{ id: "eyes", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } }],
      respond: (body) => (JSON.stringify(body.messages).includes("data:image/png") ? { text: "Оранжевый круг на белом фоне." } : (chatTurns.shift() ?? { text: "Готово." })),
    });
    const provider = await (await env.call("POST", "/api/providers", { preset: "custom", name: "Fake", baseUrl: fake.baseUrl, apiKey: KEY })).json();
    const chat = (await (await env.call("POST", "/api/chats", { providerId: provider.id, model: "eyes" })).json()) as { id: string };
    await connect(chat.id, folder);
    const events = await readEvents(await send(chat.id, "Посмотри референс ref.png"));
    expect(events.filter((e: any) => e.type === "tool").map((e: any) => e.name)).toContain("look_at_image");
    const last = fake.requests.filter((r) => r.path === "/v1/chat/completions" && !JSON.stringify(r.body.messages).includes("data:image")).at(-1)!;
    expect(JSON.stringify(last.body.messages)).toContain("Оранжевый круг на белом фоне.");
    expect(events.at(-1).message).toMatchObject({ content: "На референсе оранжевый круг." });
  });
});

// Seen live: a long chat with a folder kept its first question as "the task", summarized the newest one away, and
// answered an old request ("the graphics settings") instead of what the user had just asked.
describe("memory of a long chat with a folder", () => {
  it("keeps the newest question as it is and does not hold the first one up as the task", async () => {
    const turns: FakeTurn[] = [
      { text: `Про игру: ${"длинный ответ ".repeat(500)}` },
      { text: `Про графику: ${"ещё ответ ".repeat(500)}` },
      { toolCalls: [{ name: "list_files", args: { path: "." } }] },
      { text: "В папке запрета всё на месте." },
    ];
    fake = await startFakeProvider({
      key: KEY,
      models: [{ id: "coder", context_length: 4000 }],
      respond: (body) => (JSON.stringify(body.messages?.[0] ?? "").includes("working memory") ? { text: "SUMMARY: спрашивал про игру и графику." } : (turns.shift() ?? { text: "Готово." })),
    });
    const provider = await (await env.call("POST", "/api/providers", { preset: "custom", name: "Fake", baseUrl: fake.baseUrl, apiKey: KEY })).json();
    const chat = (await (await env.call("POST", "/api/chats", { providerId: provider.id, model: "coder" })).json()) as { id: string };
    await connect(chat.id, folder);
    for (const content of ["Варзон закрывается после обновления", "Посоветуй настройки графики", "Посмотри папку запрета"]) {
      await readEvents(await env.call("POST", `/api/chats/${chat.id}/messages`, { content }));
    }
    const asks = fake.requests.filter((r) => r.path === "/v1/chat/completions" && !JSON.stringify(r.body.messages?.[0] ?? "").includes("working memory"));
    const summarizer = fake.requests.find((r) => r.path === "/v1/chat/completions" && JSON.stringify(r.body.messages?.[0] ?? "").includes("working memory"));
    expect(summarizer).toBeDefined();
    expect(JSON.stringify(summarizer!.body.messages)).toContain("newest question");
    const last = asks.at(-1)!.body.messages.filter((m: any) => m.role === "user");
    // The summary first, the newest question whole; the first question is not held up as the task.
    expect(JSON.stringify(last)).toContain("Посмотри папку запрета");
    expect(JSON.stringify(last)).not.toContain("Варзон закрывается после обновления");
    const saved = await (await env.call("GET", `/api/chats/${chat.id}`)).json();
    expect(saved.messages.at(-1).content).toContain("В папке запрета всё на месте.");
  });
});

// Seen live: in a long chat every new message waited while the whole history was told again before the model answered.
describe("summary of a long chat between messages", () => {
  it("is made once and used again by the next message while the history stays the same", async () => {
    let summaries = 0;
    let answers = 0;
    fake = await startFakeProvider({
      key: KEY,
      models: [{ id: "coder", context_length: 4000 }],
      respond: (body) => {
        if (JSON.stringify(body.messages?.[0] ?? "").includes("working memory")) {
          summaries++;
          return { text: "SUMMARY: говорили про игру." };
        }
        return answers++ < 2 ? { text: `Ответ: ${"слово ".repeat(1300)}` } : { text: "Коротко." };
      },
    });
    const provider = await (await env.call("POST", "/api/providers", { preset: "custom", name: "Fake", baseUrl: fake.baseUrl, apiKey: KEY })).json();
    const chat = (await (await env.call("POST", "/api/chats", { providerId: provider.id, model: "coder" })).json()) as { id: string };
    await connect(chat.id, folder);
    for (const content of ["Первый вопрос", "Второй вопрос", "Третий вопрос"]) await readEvents(await env.call("POST", `/api/chats/${chat.id}/messages`, { content }));
    const made = summaries;
    expect(made).toBeGreaterThan(0);
    await readEvents(await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "Короткий вопрос" }));
    // The fourth message goes on from the kept summary.
    expect(summaries).toBe(made);
  });
});

// Asked for: sub-agents as in Claude Code. The research goes to an agent with a fresh context; only its report comes back.
describe("sub-agents", () => {
  it("reads in a context of its own and gives the main agent only its report", async () => {
    const isSub = (body: any) => JSON.stringify(body.messages?.[0] ?? "").includes("You are a sub-agent");
    const main: FakeTurn[] = [
      { toolCalls: [{ name: "delegate", args: { description: "Найти константу a", prompt: "Где задана константа a и чему она равна?" } }] },
      { text: "Константа a = 1, в app.js." },
    ];
    const sub: FakeTurn[] = [{ toolCalls: [{ name: "read_file", args: { path: "app.js" } }] }, { toolCalls: [{ name: "report", args: { report: "a = 1, задана в app.js:1" } }] }];
    fake = await startFakeProvider({ key: KEY, models: [{ id: "coder" }], respond: (body) => (isSub(body) ? (sub.shift() ?? { text: "—" }) : (main.shift() ?? { text: "Готово." })) });
    const provider = await (await env.call("POST", "/api/providers", { preset: "custom", name: "Fake", baseUrl: fake.baseUrl, apiKey: KEY })).json();
    const chat = (await (await env.call("POST", "/api/chats", { providerId: provider.id, model: "coder" })).json()) as { id: string };
    await connect(chat.id, folder);
    await readEvents(await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "Чему равна константа a?" }));
    const asks = fake.requests.filter((r) => r.path === "/v1/chat/completions");
    const subAsks = asks.filter((r) => isSub(r.body));
    const mainAsks = asks.filter((r) => !isSub(r.body));
    // The sub-agent read the file; the main agent got the report, never the file itself.
    expect(JSON.stringify(subAsks.at(-1)!.body.messages)).toContain("export const a = 1");
    const after = JSON.stringify(mainAsks.at(-1)!.body.messages);
    expect(after).toContain("a = 1, задана в app.js:1");
    expect(after).not.toContain("export const a = 1");
    const saved = await (await env.call("GET", `/api/chats/${chat.id}`)).json();
    expect(saved.messages.at(-1).activity).toContainEqual(expect.objectContaining({ name: "delegate", input: "Найти константу a" }));
    expect(saved.messages.at(-1).content).toContain("Константа a = 1");
  });

  // Seen live: chats saved no cached tokens, and with the provider's own bill the sub-agents' cost was left out.
  it("counts the provider's bill of the answer and of its sub-agent, and what came from the cache", async () => {
    const isSub = (body: any) => JSON.stringify(body.messages?.[0] ?? "").includes("You are a sub-agent");
    const usage = (cost: number) => ({ prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 800 }, cost });
    const main: FakeTurn[] = [
      { toolCalls: [{ name: "delegate", args: { description: "Найти a", prompt: "Где задана a?" } }], usage: usage(0.01) },
      { text: "a = 1.", usage: usage(0.01) },
    ];
    const sub: FakeTurn[] = [{ toolCalls: [{ name: "report", args: { report: "a = 1" } }], usage: usage(0.002) }];
    fake = await startFakeProvider({ key: KEY, models: [{ id: "coder" }], respond: (body) => (isSub(body) ? (sub.shift() ?? { text: "—" }) : (main.shift() ?? { text: "Готово." })) });
    const provider = await (await env.call("POST", "/api/providers", { preset: "custom", name: "Fake", baseUrl: fake.baseUrl, apiKey: KEY })).json();
    const chat = (await (await env.call("POST", "/api/chats", { providerId: provider.id, model: "coder" })).json()) as { id: string };
    await connect(chat.id, folder);
    await readEvents(await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "Где a?" }));
    const row = env.db.sql.prepare("select cost_usd, cached_tokens from messages where chat_id = ? and role = 'assistant'").get(chat.id) as { cost_usd: number; cached_tokens: number };
    expect(row.cost_usd).toBeCloseTo(0.022, 5);
    expect(row.cached_tokens).toBe(1600);
  });
});
