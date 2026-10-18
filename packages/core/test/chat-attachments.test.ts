import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, readEvents, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider, type FakeTurn } from "./fake-provider";
import { makeRepo } from "./git-repo";

const KEY = "good-key";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
let env: TestEnv;
let fake: FakeProvider | undefined;

beforeEach(() => {
  env = createTestEnv();
});
afterEach(async () => {
  env.close();
  await fake?.close();
  fake = undefined;
});

const seeing = { id: "eyes", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } };
const blind = { id: "blind", architecture: { input_modalities: ["text"], output_modalities: ["text"] } };

async function chatWith(model: Record<string, unknown>, script: FakeTurn[] = [{ text: "Понял." }, { text: "Ещё раз понял." }]) {
  fake = await startFakeProvider({ key: KEY, models: [model], script });
  const provider = await (await env.call("POST", "/api/providers", { preset: "custom", name: "Fake", baseUrl: fake.baseUrl, apiKey: KEY })).json();
  return (await (await env.call("POST", "/api/chats", { providerId: provider.id, model: model.id })).json()) as { id: string };
}
const upload = async (chatId: string, name: string, type: string, data: Buffer) =>
  env.call("POST", `/api/chats/${chatId}/attachments`, { name, type, data: data.toString("base64") });
const send = (chatId: string, content: string, attachments: string[] = []) => env.call("POST", `/api/chats/${chatId}/messages`, { content, attachments });
const lastAsk = () => JSON.stringify(fake!.requests.filter((r) => r.path === "/v1/chat/completions").at(-1)!.body.messages);

describe("attachments", () => {
  it("gives the model a text file's content, and keeps it for the next question", async () => {
    const chat = await chatWith(blind);
    const file = await (await upload(chat.id, "notes.md", "text/markdown", Buffer.from("# План\nкупить молоко\n"))).json();
    expect(file).toMatchObject({ name: "notes.md", kind: "text" });
    const events = await readEvents(await send(chat.id, "Что в заметках?", [file.id]));
    expect(lastAsk()).toContain("купить молоко");
    expect(events[0].userMessage.attachments).toEqual([expect.objectContaining({ name: "notes.md", kind: "text" })]);

    await readEvents(await send(chat.id, "А что первым пунктом?"));
    expect(lastAsk()).toContain("купить молоко");
  });

  it("shows a picture to a model that sees pictures", async () => {
    const chat = await chatWith(seeing);
    const pic = await (await upload(chat.id, "shot.png", "image/png", PNG)).json();
    await readEvents(await send(chat.id, "Что на картинке?", [pic.id]));
    expect(lastAsk()).toContain("image_url");
    expect(lastAsk()).toContain(PNG.toString("base64"));
  });

  it("refuses a picture for a model that cannot see one", async () => {
    const chat = await chatWith(blind);
    const pic = await (await upload(chat.id, "shot.png", "image/png", PNG)).json();
    const res = await send(chat.id, "Что на картинке?", [pic.id]);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "no_vision" } });
  });

  it("serves the file back for the chat to show", async () => {
    const chat = await chatWith(seeing);
    const pic = await (await upload(chat.id, "shot.png", "image/png", PNG)).json();
    const res = await env.call("GET", `/api/chats/${chat.id}/attachments/${pic.id}`);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("lets a model working in a folder put an attachment into it", async () => {
    const folder = makeRepo({ "index.html": "<h1>Сайт</h1>\n" });
    try {
      const chat = await chatWith(seeing, [{ toolCalls: [{ name: "save_attachment", args: { name: "logo.png", path: "img/logo.png" } }] }, { text: "Положил." }]);
      await env.call("PATCH", `/api/chats/${chat.id}/folder`, { folder });
      const pic = await (await upload(chat.id, "logo.png", "image/png", PNG)).json();
      await readEvents(await send(chat.id, "Поставь логотип на сайт", [pic.id]));
      expect(readFileSync(join(folder, "img", "logo.png")).equals(PNG)).toBe(true);
    } finally {
      rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
