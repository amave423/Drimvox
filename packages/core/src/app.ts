import { zValidator } from "@hono/zod-validator";
import { settingsPatchSchema, type PresetId } from "@artel/shared";
import { Hono } from "hono";
import { join } from "node:path";
import { ProjectRepo, TaskRepo } from "./agent/repo";
import { AgentRunner } from "./agent/runner";
import { ChatApprovals } from "./chats/approvals";
import { ChatRepo } from "./chats/repo";
import type { Database } from "./db";
import { hostGuard, tokenGuard } from "./guards";
import { duckDuckGo, type WebAccess } from "./internet/web";
import { Background } from "./agent/background";
import { McpHub } from "./mcp/hub";
import { McpRepo } from "./mcp/repo";
import { MediaRepo } from "./media/repo";
import { Studio } from "./media/studio";
import { ProviderRepo } from "./providers/repo";
import { chatRoutes, usageRoutes } from "./routes/chats";
import { mcpRoutes } from "./routes/mcp";
import { mediaRoutes } from "./routes/media";
import { skillRoutes } from "./routes/skills";
import { projectRoutes } from "./routes/projects";
import { providerRoutes } from "./routes/providers";
import { taskRoutes } from "./routes/tasks";
import { setRateSource, usdRub, type RateSource } from "./rates";
import { Shots, type Screenshotter } from "./visual/look";
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
  /** How often a clip being rendered is checked. Default 10 seconds. */
  mediaPollMs?: number;
  /** Rubles per dollar; the Central Bank's daily rate by default. */
  usdRub?: RateSource;
  /** Addresses of fixed presets, for tests against a fake server. */
  presetUrls?: Partial<Record<PresetId, string>>;
  /** How models reach the internet; DuckDuckGo and plain page fetching by default. */
  web?: WebAccess;
  /** Takes screenshots of pages; the desktop app gives one, tests a fake. Without it agents cannot look at pages. */
  screenshot?: Screenshotter;
}

const defaultHosts = ["127.0.0.1", "localhost", "[::1]"];

/** The API plus a way to stop running agents before the database closes. */
export function createCore(o: AppOptions) {
  setRateSource(o.usdRub);
  const cipher = createCipher(o.secretKey);
  const providers = new ProviderRepo(o.db, cipher, o.presetUrls);
  const mcpRepo = new McpRepo(o.db, cipher);
  const mcp = new McpHub(mcpRepo);
  const approvals = new ChatApprovals();
  const shots = new Shots(join(o.dataDir, "screenshots"));
  const visualKit = { background: new Background(), screenshot: o.screenshot ?? null, shots };
  const media = new MediaRepo(o.db, o.dataDir);
  const chats = new ChatRepo(o.db, media);
  const projects = new ProjectRepo(o.db);
  const tasks = new TaskRepo(o.db);
  const idleTimeoutMs = o.idleTimeoutMs ?? 120_000;
  const web = o.web ?? duckDuckGo;
  const runner = new AgentRunner({
    tasks,
    projects,
    providers,
    dataDir: o.dataDir,
    budgetUsd: () => readSettings(o.db).agentBudgetUsd,
    strongModel: () => readSettings(o.db).strongModel,
    imageModel: () => readSettings(o.db).imageModel,
    media,
    web,
    mcp,
    visualKit,
    visionModel: () => readSettings(o.db).visionModel,
    skillsDir: join(o.dataDir, "skills"),
    idleTimeoutMs,
  });
  const studio = new Studio({ chats, media, providers, pollMs: o.mediaPollMs ?? 10_000 });
  studio.resume();

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
    .get("/rates", async (c) => c.json({ usdRub: await usdRub() }))
    .get("/settings", (c) => c.json(readSettings(o.db)))
    .patch("/settings", zValidator("json", settingsPatchSchema), (c) =>
      c.json(writeSettings(o.db, c.req.valid("json"))),
    )
    .route("/providers", providerRoutes(providers))
    .route("/chats", chatRoutes(chats, providers, studio, web, mcp, approvals, idleTimeoutMs))
    .route("/mcp", mcpRoutes(mcpRepo, mcp))
    .route("/media", mediaRoutes(media))
    .route("/skills", skillRoutes(join(o.dataDir, "skills")))
    .route("/usage", usageRoutes(chats))
    .route("/projects", projectRoutes(projects, tasks, providers, runner))
    .route("/tasks", taskRoutes(tasks, runner, shots));

  const app = new Hono()
    .use("*", hostGuard(new Set(o.allowedHosts ?? defaultHosts)))
    .use("/api/*", tokenGuard(o.token, new Set(["/api/health"])))
    .route("/api", api);

  app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
  if (o.webDir) app.get("*", webHandler(o.webDir));
  return {
    app,
    shutdown: async () => {
      studio.shutdown();
      await runner.shutdown();
      visualKit.background.shutdown();
      await mcp.shutdown();
    },
  };
}

export function createApp(o: AppOptions) {
  return createCore(o).app;
}

export type AppType = ReturnType<typeof createApp>;
