// Live check against real providers: connects each provider whose key is in .env through the real core API,
// lists models, reads the balance, streams one short answer and gives an agent a tiny real coding task.
// Costs a fraction of a cent. `npm run live-check -- --no-agent` skips the agent part;
// `--team` gives the task to a team of agents instead of one. `--media` draws one cheap picture through
// OpenRouter or RouterAI (about a cent); `--video` also makes the cheapest clip. `--web` asks a question that
// needs the internet. `--tools` gives an agent a skill, an MCP tool and a page to look at. `--only=routerai`
// checks one provider. `--cli` checks Claude Code, Codex and Gemini CLI instead of the keys. `--project` runs the
// project's work instead of a task: interview, plan, "Go" and one long run with its checklist.
import { startServer } from "@drimvox/core";
import type { ChatView, MessageView, ModelInfo, PresetId, ProviderView, StreamEvent } from "@drimvox/shared";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAgent } from "./live-agent";
import { checkProject } from "./live-project";
import { checkClis } from "./live-cli";
import { checkMedia } from "./live-media";
import { checkTeam } from "./live-team";
import { checkTools, weatherCard } from "./live-tools";

interface Target {
  preset: PresetId;
  envKey: string;
  /** Preferred cheap chat models, first match wins. */
  models: string[];
  reasoningModel?: string;
  /** Model for the agent check; needs tool calling. */
  agentModel: string;
}

const targets: Target[] = [
  {
    preset: "openrouter",
    envKey: "OPENROUTER_API_KEY",
    models: ["deepseek/deepseek-chat-v3.1", "deepseek/deepseek-chat", "openai/gpt-4o-mini", "google/gemini-2.5-flash"],
    agentModel: "deepseek/deepseek-chat-v3.1",
  },
  {
    // Rubles; cheap DeepSeek V4.1 Flash, about 4 ₽ in and 16 ₽ out per 1M tokens (2026-10-12).
    preset: "routerai",
    envKey: "ROUTERAI_API_KEY",
    models: ["deepseek/deepseek-v4.1-flash", "mistralai/mistral-nemo"],
    agentModel: "deepseek/deepseek-v4.1-flash",
  },
  { preset: "deepseek", envKey: "DEEPSEEK_API_KEY", models: ["deepseek-flash", "deepseek-chat"], reasoningModel: "deepseek-v4-pro", agentModel: "deepseek-flash" },
  {
    preset: "nvidia",
    envKey: "NVIDIA_API_KEY",
    models: ["openai/gpt-oss-20b", "z-ai/glm-5.3-flash", "moonshotai/kimi-k3", "nvidia/nemotron-3-super-120b-a12b"],
    agentModel: "z-ai/glm-5.3-flash",
  },
];

const MIN_USD_FOR_AGENT = 0.1;
const MIN_RUB = 10;

const env = { ...readDotEnv(join(process.cwd(), ".env")), ...process.env };
const secrets = targets.map((t) => env[t.envKey]).filter((v): v is string => !!v);
const redact = (text: string) => secrets.reduce((s, key) => s.split(key).join("***"), text);
const log = (...parts: unknown[]) => console.log(redact(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")));

const dataDir = mkdtempSync(join(tmpdir(), "drimvox-live-"));
const token = randomBytes(16).toString("hex");
const server = await startServer({ token, secretKey: randomBytes(32), dataDir, version: "live-check", screenshot: () => weatherCard() });
const base = `http://127.0.0.1:${server.port}/api`;
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any, res };
};

let failures = 0;
let checked = 0;
try {
  const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
  if (process.argv.includes("--cli")) [checked, failures] = await checkClis(api, ask, log, only);
  for (const target of targets.filter((t) => !process.argv.includes("--cli") && (!only || t.preset === only))) {
    const key = env[target.envKey];
    log(`\n=== ${target.preset} ===`);
    if (!key) {
      log(`skipped: ${target.envKey} is not set`);
      continue;
    }
    checked++;
    const created = await api("POST", "/providers", { preset: target.preset, apiKey: key });
    if (created.status !== 201) {
      failures++;
      log("connect FAILED", created.status, created.body);
      continue;
    }
    const provider = created.body as ProviderView;

    const models = await api("GET", `/providers/${provider.id}/models`);
    if (models.status !== 200) {
      failures++;
      log("models FAILED", models.body);
      continue;
    }
    const list = models.body as ModelInfo[];
    const priced = list.filter((m) => m.priceIn !== null).length;
    log(`models: ${list.length} (with prices: ${priced}, with tool support flag: ${list.filter((m) => m.tools).length})`);

    const balance = await api("GET", `/providers/${provider.id}/balance`);
    log("balance:", balance.status, balance.body);
    if (balance.status !== 200) failures++;

    const chatModel = target.models.find((id) => list.some((m) => m.id === id)) ?? list[0]?.id;
    if (!chatModel) {
      failures++;
      log("no model to chat with");
      continue;
    }
    for (const model of [chatModel, target.reasoningModel].filter((m): m is string => !!m)) {
      const answer = await ask(provider.id, model, "Столица Франции? Ответь одним словом.");
      if (answer.status !== "done") failures++;
      log(`chat ${model}:`, {
        status: answer.status,
        text: answer.content.slice(0, 80),
        reasoning: answer.reasoning ? `${answer.reasoning.length} chars` : null,
        tokens: `${answer.inputTokens} → ${answer.outputTokens}`,
        costUsd: answer.costUsd,
        error: answer.error,
      });
    }

    if (process.argv.includes("--web")) {
      const events = await sendEvents(
        (await api("POST", "/chats", { providerId: provider.id, model: chatModel })).body.id,
        { content: "Какая сейчас погода в Москве? Ответь в двух предложениях и назови источник.", web: "free" },
      );
      const done = events.find((e): e is Extract<StreamEvent, { type: "done" }> => e.type === "done")?.message;
      const tools = events.filter((e): e is Extract<StreamEvent, { type: "tool" }> => e.type === "tool").map((e) => `${e.name} ${e.input}`);
      log(`web ${chatModel}:`, { status: done?.status, tools, text: done?.content.slice(0, 300), costUsd: done?.costUsd, error: done?.error });
      if (done?.status !== "done" || tools.length === 0) failures++;
    }

    // An agent task costs a few cents; never let the check push an account below zero.
    const funds = balance.body?.balance as { amount: number; currency: string } | null | undefined;
    const lowFunds = funds && ((funds.currency === "USD" && funds.amount < MIN_USD_FOR_AGENT) || (funds.currency === "RUB" && funds.amount < MIN_RUB));
    if (!process.argv.includes("--no-agent") && lowFunds) {
      log(`agent: skipped, balance ${funds.amount.toFixed(4)} ${funds.currency} is too low — top up to run it`);
    } else if (!process.argv.includes("--no-agent")) {
      if (!list.some((m) => m.id === target.agentModel)) {
        failures++;
        log(`agent: model ${target.agentModel} is not in the list`);
      } else if (!(await (process.argv.includes("--project") ? checkProject : process.argv.includes("--team") ? checkTeam : checkAgent)(api, provider.id, target.agentModel, log))) {
        failures++;
      }
    }

    if (process.argv.includes("--tools") && !lowFunds && list.some((m) => m.id === target.agentModel)) {
      if (!(await checkTools(api, provider.id, target.agentModel, log))) failures++;
    }

    const wantsMedia = process.argv.includes("--media") || process.argv.includes("--video");
    if (wantsMedia && (target.preset === "openrouter" || target.preset === "routerai")) {
      if (lowFunds) log(`media: skipped, balance ${funds.amount.toFixed(4)} ${funds.currency} is too low — top up to run it`);
      else if (!(await checkMedia(api, sendEvents, provider.id, process.argv.includes("--video"), log))) failures++;
    }
  }
} finally {
  await server.close();
  rmSync(dataDir, { recursive: true, force: true });
}
if (checked === 0) failures++;
const summary = checked === 0 ? "No keys in .env, nothing was checked" : failures === 0 ? "ALL OK" : `${failures} problem(s)`;
log(`\n${summary}`);
process.exit(failures === 0 ? 0 : 1);

async function sendEvents(chatId: string, body: unknown): Promise<StreamEvent[]> {
  const res = await fetch(`${base}/chats/${chatId}/messages`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${redact(text).slice(0, 300)}`);
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as StreamEvent);
}

async function ask(providerId: string, model: string, content: string): Promise<MessageView> {
  const chat = (await api("POST", "/chats", { providerId, model })).body as ChatView;
  const res = await fetch(`${base}/chats/${chat.id}/messages`, { method: "POST", headers, body: JSON.stringify({ content }) });
  const text = await res.text();
  const events = text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as StreamEvent);
  const done = events.find((e): e is Extract<StreamEvent, { type: "done" }> => e.type === "done");
  if (!done) throw new Error(`no done event (HTTP ${res.status}): ${text.slice(0, 200)}`);
  return done.message;
}

function readDotEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2]) out[m[1]!] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
