import { createServer, type IncomingMessage, type Server } from "node:http";

/** OpenAI-style usage; `prompt_tokens_details.cached_tokens` are the ones served from the provider's cache. */
export interface FakeUsage {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
  /** What the request cost, in the account's currency, as OpenRouter and RouterAI report it. */
  cost?: number;
}

export interface FakeChunk {
  reasoning?: string;
  text?: string;
}

/** One model reply in a scripted conversation: some text and/or tool calls. */
export interface FakeTurn {
  text?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  usage?: FakeUsage;
  /** Wait before answering, ms. */
  delayMs?: number;
  /** Answer with this status and an OpenAI-style error body instead. */
  fail?: { status: number; message: string };
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
  usage?: FakeUsage;
  /** Delay between streamed chunks, ms. */
  delayMs?: number;
  /** Why the streamed answer ends; "stop" by default, "length" when the model ran out of room. */
  finishReason?: string;
  /** Answer chat requests with this status and an OpenAI-style error body. */
  failWith?: { status: number; message: string };
  routes?: Record<string, unknown>;
  /** Decides whether a request carries the right key; Bearer <key> when absent. */
  authorized?: (headers: IncomingMessage["headers"], url: URL) => boolean;
  /** Answers any authorized request before the built-in endpoints; undefined falls through to them. */
  handle?: (method: string, path: string, body: any) => FakeReply | undefined;
}

export interface FakeReply {
  status?: number;
  json?: unknown;
  bytes?: Buffer;
  contentType?: string;
}

export interface FakeProvider {
  baseUrl: string;
  origin: string;
  requests: { path: string; auth: string | undefined; body: any; headers: IncomingMessage["headers"]; query: string }[];
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
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    requests.push({ path, auth: req.headers.authorization, body: body ? JSON.parse(body) : null, headers: req.headers, query: url.search });

    const json = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };

    if (o.routes && path in o.routes) return json(200, o.routes[path]);
    const ok = o.authorized ? o.authorized(req.headers, url) : req.headers.authorization === `Bearer ${key}`;
    if (!ok) return json(401, { error: { message: "Invalid API key" } });

    const handled = o.handle?.(req.method ?? "GET", path, body ? JSON.parse(body) : null);
    if (handled) {
      if (handled.bytes) {
        res.writeHead(handled.status ?? 200, { "content-type": handled.contentType ?? "application/octet-stream" });
        res.end(handled.bytes);
        return;
      }
      return json(handled.status ?? 200, handled.json ?? {});
    }

    if (path === "/v1/models") {
      return json(200, { object: "list", data: o.models ?? [{ id: "fake-small" }, { id: "fake-large" }] });
    }
    if (path === "/v1/chat/completions") {
      if (o.failWith) return json(o.failWith.status, { error: { message: o.failWith.message } });
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
        if (turn.fail) {
          res.writeHead(turn.fail.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: turn.fail.message } }));
          return;
        }
        // A request without streaming (a summary, say) gets the whole answer at once.
        if (!parsed.stream) {
          const usage = turn.usage ?? { prompt_tokens: 100, completion_tokens: 20 };
          const toolCalls = (turn.toolCalls ?? []).map((call, index) => ({
            id: `call_${scriptIndex}_${index}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          }));
          return json(200, {
            id: "c",
            object: "chat.completion",
            created: 1,
            model: "m",
            choices: [{ index: 0, message: { role: "assistant", content: turn.text ?? null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
            usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
          });
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
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
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const c of o.chunks ?? [{ text: "Hello" }]) {
        if (res.destroyed) return;
        res.write(chunk(c.reasoning ? { reasoning_content: c.reasoning } : { content: c.text }));
        if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      }
      if (res.destroyed) return;
      const usage = o.usage ?? { prompt_tokens: 12, completion_tokens: 3 };
      res.write(chunk({}, { usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } }, o.finishReason ?? "stop"));
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
