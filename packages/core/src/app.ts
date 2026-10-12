import { zValidator } from "@hono/zod-validator";
import { settingsPatchSchema } from "@artel/shared";
import { Hono } from "hono";
import { ProjectRepo, TaskRepo } from "./agent/repo";
import { AgentRunner } from "./agent/runner";
import { ChatRepo } from "./chats/repo";
import type { Database } from "./db";
import { hostGuard, tokenGuard } from "./guards";
import { ProviderRepo } from "./providers/repo";
import { chatRoutes, usageRoutes } from "./routes/chats";
import { projectRoutes } from "./routes/projects";
import { providerRoutes } from "./routes/providers";
import { taskRoutes } from "./routes/tasks";
import { createCipher } from "./secrets";
import { readSettings, writeSettings } from "./settings";
import { webHandler } from "./web";

export interface AppOptions {
  db: Database;
  /** Shared secret the UI sends as `Authorization: Bearer <token>`. */
  token: string;
  /** 32 bytes that encrypt provider keys at rest. */
  secretKey: Buffer;
  version: string;
  /** Holds the database and the agents' copies of projects. */
  dataDir: string;
  /** Built UI to serve. Omitted in development, where Vite serves it. */
  webDir?: string;
  allowedHosts?: string[];
  /** How long a model may stay silent mid-answer before the answer fails. Default 2 minutes. */
  idleTimeoutMs?: number;
}

const defaultHosts = ["127.0.0.1", "localhost", "[::1]"];

/** The API plus a way to stop running agents before the database closes. */
export function createCore(o: AppOptions) {
  const providers = new ProviderRepo(o.db, createCipher(o.secretKey));
  const chats = new ChatRepo(o.db);
  const projects = new ProjectRepo(o.db);
  const tasks = new TaskRepo(o.db);
  const idleTimeoutMs = o.idleTimeoutMs ?? 120_000;
  const runner = new AgentRunner({
    tasks,
    projects,
    providers,
    dataDir: o.dataDir,
    budgetUsd: () => readSettings(o.db).agentBudgetUsd,
    strongModel: () => readSettings(o.db).strongModel,
    idleTimeoutMs,
  });

  const api = new Hono()
    .get("/health", (c) => c.json({ ok: true as const }))
    .get("/status", (c) =>
      c.json({
        version: o.version,
        dataDir: o.dataDir,
        schemaVersion: o.db.schemaVersion(),
        node: process.versions.node,
      }),
    )
    .get("/settings", (c) => c.json(readSettings(o.db)))
    .patch("/settings", zValidator("json", settingsPatchSchema), (c) =>
      c.json(writeSettings(o.db, c.req.valid("json"))),
    )
    .route("/providers", providerRoutes(providers))
    .route("/chats", chatRoutes(chats, providers, idleTimeoutMs))
    .route("/usage", usageRoutes(chats))
    .route("/projects", projectRoutes(projects, tasks, providers, runner))
    .route("/tasks", taskRoutes(tasks, runner));

  const app = new Hono()
    .use("*", hostGuard(new Set(o.allowedHosts ?? defaultHosts)))
    .use("/api/*", tokenGuard(o.token, new Set(["/api/health"])))
    .route("/api", api);

  app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
  if (o.webDir) app.get("*", webHandler(o.webDir));
  return { app, shutdown: () => runner.shutdown() };
}

export function createApp(o: AppOptions) {
  return createCore(o).app;
}

export type AppType = ReturnType<typeof createApp>;
