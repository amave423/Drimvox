import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, readEvents, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider, type FakeTurn } from "./fake-provider";
import { git, makeRepo } from "./git-repo";

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
      { text: "Создал hello.txt и поменял a." },
    ]);
    const res = await connect(chat.id, folder);
    expect(res.status).toBe(200);
    expect((await res.json()).folder).toBe(folder);

    const events = await readEvents(await send(chat.id, "Создай hello.txt и поменяй a на 2"));
    expect(events.filter((e: any) => e.type === "tool").map((e: any) => e.name)).toEqual(["read_file", "write_file", "edit_file"]);
    expect(readFileSync(join(folder, "hello.txt"), "utf8")).toBe("привет\n");
    expect(readFileSync(join(folder, "app.js"), "utf8")).toBe("export const a = 2;\n");
    const answer = events.at(-1).message;
    expect(answer).toMatchObject({ content: "Создал hello.txt и поменял a.", canUndo: true });
    // The model works in the user's files; git stays the user's.
    expect(git(folder, "log", "--oneline").split("\n")).toHaveLength(1);

    expect((await env.call("POST", `/api/chats/${chat.id}/messages/${answer.id}/undo`)).status).toBe(200);
    expect(existsSync(join(folder, "hello.txt"))).toBe(false);
    expect(readFileSync(join(folder, "app.js"), "utf8")).toBe("export const a = 1;\n");
    const after = (await (await env.call("GET", `/api/chats/${chat.id}`)).json()).messages.at(-1);
    expect(after.canUndo).toBe(false);
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
});
