import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, readEvents, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider } from "./fake-provider";

const KEY = "good-key";
let env: TestEnv;
let fake: FakeProvider;

beforeEach(() => {
  env = createTestEnv();
});

afterEach(async () => {
  env.close();
  await fake?.close();
});

async function setup(script: { text: string }[]) {
  fake = await startFakeProvider({ key: KEY, models: [{ id: "fake-model" }], script });
  const provider = await (await env.call("POST", "/api/providers", { preset: "custom", name: "Fake", baseUrl: fake.baseUrl, apiKey: KEY })).json();
  return (await (await env.call("POST", "/api/chats", { providerId: provider.id, model: "fake-model" })).json()) as { id: string };
}

const send = async (chatId: string, content: string, editOf?: string) =>
  readEvents(await env.call("POST", `/api/chats/${chatId}/messages`, { content, ...(editOf ? { editOf } : {}) }));
const shown = async (chatId: string) => {
  const chat = await (await env.call("GET", `/api/chats/${chatId}`)).json();
  return chat.messages.map((m: { content: string; versions: { index: number; count: number } | null }) => (m.versions ? `${m.content} (${m.versions.index + 1}/${m.versions.count})` : m.content));
};
const asked = () => fake.requests.filter((r) => r.path === "/v1/chat/completions").map((r) => r.body.messages.filter((m: { role: string }) => m.role !== "system").map((m: { content: string }) => m.content));

// Asked for: edit your own message and get a new answer, and switch between the versions like in other chats.
describe("editing a message", () => {
  it("answers the edited message on a branch of its own and keeps the old one to switch back to", async () => {
    const chat = await setup([{ text: "Ответ на привет" }, { text: "Ответ на здравствуй" }, { text: "Ответ на ещё" }]);
    await send(chat.id, "Привет");
    const first = (await (await env.call("GET", `/api/chats/${chat.id}`)).json()).messages[0].id as string;

    await send(chat.id, "Здравствуй", first);
    expect(await shown(chat.id)).toEqual(["Здравствуй (2/2)", "Ответ на здравствуй"]);
    // The model saw the edited message only, not the branch it replaced.
    expect(asked()[1]).toEqual(["Здравствуй"]);

    // Back to the first version: its answer, and the conversation goes on from there.
    expect((await env.call("POST", `/api/chats/${chat.id}/branch`, { messageId: first })).status).toBe(200);
    expect(await shown(chat.id)).toEqual(["Привет (1/2)", "Ответ на привет"]);
    await send(chat.id, "Ещё");
    expect(asked()[2]).toEqual(["Привет", "Ответ на привет", "Ещё"]);
    expect(await shown(chat.id)).toEqual(["Привет (1/2)", "Ответ на привет", "Ещё", "Ответ на ещё"]);

    // The second version keeps its own continuation.
    const second = (await (await env.call("GET", `/api/chats/${chat.id}`)).json()).messages[0].versions.ids[1] as string;
    await env.call("POST", `/api/chats/${chat.id}/branch`, { messageId: second });
    expect(await shown(chat.id)).toEqual(["Здравствуй (2/2)", "Ответ на здравствуй"]);
  });

  it("refuses to edit an answer or a message of another chat", async () => {
    const chat = await setup([{ text: "Ответ" }]);
    await send(chat.id, "Привет");
    const answer = (await (await env.call("GET", `/api/chats/${chat.id}`)).json()).messages[1].id as string;
    expect((await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "x", editOf: answer })).status).toBe(400);
    expect((await env.call("POST", `/api/chats/${chat.id}/branch`, { messageId: "nope" })).status).toBe(404);
  });
});
