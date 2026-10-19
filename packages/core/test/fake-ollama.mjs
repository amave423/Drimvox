// A stand-in for `ollama serve`: listens on OLLAMA_HOST and answers the parts of Ollama's API Artel uses.
// FAKE_OLLAMA_MODELS: JSON list of installed names. FAKE_OLLAMA_PULL_MS: delay between progress lines.
// FAKE_OLLAMA_KEEP_MS: how long a model stays loaded after a chat (what /api/ps shows).
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const [host, port] = (process.env.OLLAMA_HOST ?? "127.0.0.1:11434").replace(/^https?:\/\//, "").split(":");
const pullMs = Number(process.env.FAKE_OLLAMA_PULL_MS ?? 20);
const keepMs = Number(process.env.FAKE_OLLAMA_KEEP_MS ?? 100);
const models = new Map((JSON.parse(process.env.FAKE_OLLAMA_MODELS ?? "[]")).map((name) => [name, 1000]));
const chats = [];
const blobs = new Set();
let loadedUntil = 0;
let loadedModel = "";

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const read = (req) =>
  new Promise((resolve) => {
    let s = "";
    req.on("data", (d) => (s += d)).on("end", () => resolve(s ? JSON.parse(s) : {}));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/version") return json(res, 200, { version: "0.31.1-fake" });
  if (url.pathname === "/fake/env") return json(res, 200, { contextLength: process.env.OLLAMA_CONTEXT_LENGTH ?? null, pid: process.pid });
  if (url.pathname === "/api/tags") {
    return json(res, 200, { models: [...models].map(([name, size]) => ({ name, model: name, size, modified_at: "2026-10-13T10:00:00Z" })) });
  }
  if (url.pathname === "/api/ps") {
    return json(res, 200, { models: Date.now() < loadedUntil ? [{ name: loadedModel, model: loadedModel, size: 1000 }] : [] });
  }
  if (url.pathname === "/fake/requests") return json(res, 200, chats);
  // Importing a GGUF Artel downloaded itself: the file as a blob, then a model made from it.
  if (url.pathname.startsWith("/api/blobs/")) {
    const digest = decodeURIComponent(url.pathname.slice("/api/blobs/".length));
    if (req.method === "HEAD") {
      res.writeHead(blobs.has(digest) ? 200 : 404);
      return res.end();
    }
    const hash = createHash("sha256");
    for await (const chunk of req) hash.update(chunk);
    const got = `sha256:${hash.digest("hex")}`;
    if (got !== digest) return json(res, 400, { error: "digest mismatch" });
    blobs.add(digest);
    res.writeHead(201);
    return res.end();
  }
  if (url.pathname === "/fake/blobs") return json(res, 200, [...blobs]);
  if (url.pathname === "/api/create" && req.method === "POST") {
    const { model, files } = await read(req);
    const missing = Object.values(files ?? {}).find((d) => !blobs.has(d));
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    if (missing) {
      res.write(`${JSON.stringify({ error: `blob ${missing} not found` })}\n`);
      return res.end();
    }
    res.write(`${JSON.stringify({ status: "parsing GGUF" })}\n`);
    models.set(model, 1000);
    res.write(`${JSON.stringify({ status: "success" })}\n`);
    return res.end();
  }
  // What a model can do: llama3.2 and 1.7b models are small, gemma sees pictures.
  if (url.pathname === "/api/show" && req.method === "POST") {
    const { model } = await read(req);
    if (!models.has(model)) return json(res, 404, { error: `model '${model}' not found` });
    const small = /llama3\.2|1\.7b/.test(model);
    return json(res, 200, {
      capabilities: ["completion", "tools", ...(/gemma/.test(model) ? ["vision"] : [])],
      model_info: { "general.architecture": "llama", "general.parameter_count": small ? 3_200_000_000 : 8_000_000_000, "llama.context_length": 131072 },
    });
  }
  if (url.pathname === "/api/delete" && req.method === "DELETE") {
    const { model } = await read(req);
    if (!models.delete(model)) return json(res, 404, { error: `model '${model}' not found` });
    return json(res, 200, {});
  }
  if (url.pathname === "/api/pull" && req.method === "POST") {
    const { model } = await read(req);
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    const line = (o) => res.write(`${JSON.stringify(o)}\n`);
    line({ status: "pulling manifest" });
    if (model.includes("missing")) {
      line({ error: "pull model manifest: file does not exist" });
      return res.end();
    }
    let closed = false;
    res.on("close", () => (closed = true));
    for (let done = 0; done <= 1000; done += 100) {
      if (closed) return;
      line({ status: `pulling ${"a".repeat(12)}`, digest: "sha256:aaaa", total: 1000, completed: done });
      await sleep(pullMs);
    }
    if (closed) return;
    line({ status: "verifying sha256 digest" });
    line({ status: "writing manifest" });
    models.set(model, 1000);
    line({ status: "success" });
    return res.end();
  }
  if (url.pathname === "/v1/models") return json(res, 200, { object: "list", data: [...models.keys()].map((id) => ({ id, object: "model", owned_by: "library" })) });
  if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
    const body = await read(req);
    chats.push(body);
    loadedModel = body.model;
    loadedUntil = Date.now() + keepMs;
    const text = "Привет из Ollama";
    if (!body.stream) {
      return json(res, 200, {
        id: "c1",
        object: "chat.completion",
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish = null, usage) =>
      res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`);
    chunk({ role: "assistant", content: "" });
    chunk({ content: text });
    chunk({}, "stop", { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
    res.write("data: [DONE]\n\n");
    return res.end();
  }
  json(res, 404, { error: "not found" });
}).listen(Number(port), host);
