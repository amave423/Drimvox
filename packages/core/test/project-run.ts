import { expect } from "vitest";
import type { TestEnv } from "./env";
import type { FakeProvider } from "./fake-provider";

/**
 * A message to a project's agent and its run, for suites about one tool or another: the provider and the project
 * are added, the message sent with the fake's model, and the run followed through GET /work and its chat.
 */
export async function projectRun(env: TestEnv, fake: FakeProvider, folder: string, content = "Сделай", model = "coder") {
  const provider = await (await env.call("POST", "/api/providers", { preset: "custom", name: "Fake", baseUrl: fake.baseUrl, apiKey: "good-key" })).json();
  const project = await (await env.call("POST", "/api/projects", { path: folder })).json();
  await env.call("PATCH", `/api/projects/${project.id}`, { kind: "existing" });
  const res = await env.call("POST", `/api/projects/${project.id}/work/chat`, { content, model: { providerId: provider.id, model } });
  expect(res.status).toBe(200);
  const { chatId } = (await res.json()) as { chatId: string };
  return { providerId: provider.id as string, projectId: project.id as string, chatId };
}

export async function waitWork(env: TestEnv, projectId: string, done: (w: any) => boolean = (w) => w.status !== "running") {
  for (let i = 0; i < 600; i++) {
    const w = await (await env.call("GET", `/api/projects/${projectId}/work`)).json();
    if (done(w)) return w;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`stuck: ${JSON.stringify(await (await env.call("GET", `/api/projects/${projectId}/work`)).json())}`);
}

/** The command or tool the run waits on, once it asks. */
export async function waitApproval(env: TestEnv, chatId: string) {
  for (let i = 0; i < 600; i++) {
    const chat = await (await env.call("GET", `/api/chats/${chatId}`)).json();
    if (chat.approvals?.length) return chat.approvals[0];
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("nothing asked");
}

export const answerApproval = (env: TestEnv, chatId: string, id: string, allow: boolean, always = false) =>
  env.call("POST", `/api/chats/${chatId}/approvals/${id}`, { allow, always });

/** What the tools gave back, in order, as the model got it in its last request. */
export function toolOutputs(fake: FakeProvider): string[] {
  const last = fake.requests.filter((r) => r.path === "/v1/chat/completions").at(-1)!;
  return (last.body.messages as { role: string; content: unknown }[]).filter((m) => m.role === "tool").map((m) => String(m.content));
}
