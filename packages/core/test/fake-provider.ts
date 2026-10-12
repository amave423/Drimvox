import { createServer, type IncomingMessage, type Server } from "node:http";

export interface FakeChunk {
  reasoning?: string;
  text?: string;
}

/** One model reply in a scripted conversation: some text and/or tool calls. */
export interface FakeTurn {
  text?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
  /** Wait before answering, ms. */
  delayMs?: number;
}

export interface FakeProviderOptions {
  /** Picks the reply from the request itself; for parallel agents whose request order is not fixed. */
  respond?: (body: any) => FakeTurn;
  /**
   * Replies for successive chat requests. When the script runs out, the model answers "Done."
   * Takes precedence over `chunks`.
   */
  script?: FakeTurn[];
  key?: string;
  /** Items of GET /models; OpenRouter-style fields are optional. */
  models?: Record<string, unknown>[];
  chunks?: FakeChunk[];
  usage?: { prompt_tokens: number; completion_tokens: number };
  /** Delay between streamed chunks, ms. */
  delayMs?: number;
  /** Answer chat requests with this status and an OpenAI-style error body. */
  failWith?: { status: number; message: string };
  routes?: Record<string, unknown>;
}

export interface FakeProvider {
  baseUrl: string;
  origin: string;
  requests: { path: string; auth: string | undefined; body: any }[];
  /** Resolves when a streaming response was cut off by the client. */
  aborted: Promise<void>;
  close(): Promise<void>;
}

/** A minimal OpenAI-compatible server: GET /v1/models and streaming POST /v1/chat/completions. */
export async function startFakeProvider(o: FakeProviderOptions = {}): Promise<FakeProvider> {
  const key = o.key ?? "good-key";
  const requests: FakeProvider["requests"] = [];
  let scriptIndex = 0;
  let markAborted!: () => void;
  const aborted = new Promise<void>((r) => (markAborted = r));

  const server: Server = createServer(async (req, res) => {
    const body = await readBody(req);
    const path = new URL(req.url ?? "/", "http://x").pathname;
    requests.push({ path, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });

    const json = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };

    if (o.routes && path in o.routes) return json(200, o.routes[path]);
    if (req.headers.authorization !== `Bearer ${key}`) return json(401, { error: { message: "Invalid API key" } });

    if (path === "/v1/models") {
      return json(200, { object: "list", data: o.models ?? [{ id: "fake-small" }, { id: "fake-large" }] });
    }
    if (path === "/v1/chat/completions") {
      if (o.failWith) return json(o.failWith.status, { error: { message: o.failWith.message } });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.on("close", () => {
        if (!res.writableEnded) markAborted();
      });
      const chunk = (delta: object, extra: object = {}, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
      if (o.script || o.respond) {
        const parsed = body ? JSON.parse(body) : {};
        const turn = o.respond ? o.respond(parsed) : (o.script![scriptIndex] ?? { text: "Done." });
        scriptIndex++;
        if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs));
        if (res.destroyed) return;
        if (turn.text) res.write(chunk({ role: "assistant", content: turn.text }));
        (turn.toolCalls ?? []).forEach((call, index) => {
          const id = `call_${scriptIndex}_${index}`;
          res.write(chunk({ tool_calls: [{ index, id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] }));
        });
        const usage = turn.usage ?? { prompt_tokens: 100, completion_tokens: 20 };
        const finish = turn.toolCalls?.length ? "tool_calls" : "stop";
        res.write(chunk({}, { usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } }, finish));
        res.end("data: [DONE]\n\n");
        return;
      }
      for (const c of o.chunks ?? [{ text: "Hello" }]) {
        if (res.destroyed) return;
        res.write(chunk(c.reasoning ? { reasoning_content: c.reasoning } : { content: c.text }));
        if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      }
      if (res.destroyed) return;
      const usage = o.usage ?? { prompt_tokens: 12, completion_tokens: 3 };
      res.write(chunk({}, { usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } }, "stop"));
      res.end("data: [DONE]\n\n");
      return;
    }
    json(404, { error: { message: "Not found" } });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl: `${origin}/v1`,
    origin,
    requests,
    aborted,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}
