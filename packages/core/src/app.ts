import { AttachmentRepo } from "./chats/attachment-repo";
import { BacklogService } from "./backlog/service";
import { backlogRoutes } from "./routes/backlog";
import { BacklogRepo } from "./backlog/repo";
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
import { authRoutes, sessionGuard } from "./auth/routes";
import { AuthStore } from "./auth/store";
import { duckDuckGo, type WebAccess } from "./internet/web";
import { Background } from "./agent/background";
import { McpHub } from "./mcp/hub";
import { McpRepo } from "./mcp/repo";
import { MediaRepo } from "./media/repo";
import { Studio } from "./media/studio";
import { LocalModels, type LocalOptions } from "./local/service";
import { ProviderRepo } from "./providers/repo";
import { chatRoutes, usageRoutes } from "./routes/chats";
import { mcpRoutes } from "./routes/mcp";
import { mediaRoutes } from "./routes/media";
import { skillRoutes } from "./routes/skills";
import { projectRoutes } from "./routes/projects";
import { providerRoutes } from "./routes/providers";
import { localRoutes } from "./routes/local";
import { proxyRoutes } from "./routes/proxy";
import { githubRoutes } from "./routes/github";
import { GitHub, type GithubOptions } from "./github/github";
import { ProxyStore } from "./proxy";
import { taskRoutes } from "./routes/tasks";
import { setPriceCatalogUrl } from "./providers/native";
import type { CliId } from "./cli/kinds";
import { setCliCommands } from "./cli/resolve";
import { forgetLimits } from "./cli/limits";
import { setRateSource, usdRub, type RateSource } from "./rates";
import { Shots, type Screenshotter } from "./visual/look";
import { createCipher } from "./secrets";
import { readSettings, writeSettings } from "./settings";
import { webHandler } from "./web";

export interface AppOptions {
  db: Database;
  /** Desktop: the shared secret the window sends as `Authorization: Bearer <token>`. */
  token?: string;
  /**
   * Server: a password set in the browser, then a session cookie. `setupCode` is what the server writes to its log
   * while no password is set; setting the first password needs it. Replaces the token.
   */
  password?: { setupCode: string };
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
  /** How to start Claude Code, Codex and Gemini CLI instead of finding them on PATH; tests run a fake. */
  cliCommands?: Partial<Record<CliId, string[]>>;
  /** What "Check the proxy" opens through it; a small page that answers fast by default. */
  proxyCheckUrl?: string;
  /** Ollama and its catalogs; tests give a fake program, fixed hardware and fake catalogs. */
  local?: LocalOptions;
  /** GitHub's addresses; tests give a fake. */
  github?: GithubOptions;
}

const defaultHosts = ["127.0.0.1", "localhost", "[::1]"];

/** The API plus a way to stop running agents before the database closes. */
export function createCore(o: AppOptions) {
  setRateSource(o.usdRub);
  setCliCommands(o.cliCommands);
  forgetLimits();
  // Prices of vendors' own APIs come from OpenRouter's public catalog (a fake one in tests).
  setPriceCatalogUrl(o.presetUrls?.openrouter);
  const cipher = createCipher(o.secretKey);
  const proxies = new ProxyStore(o.db, cipher);
  const providers = new ProviderRepo(o.db, cipher, proxies, o.presetUrls);
  const local = new LocalModels(providers, providers.urlOf("ollama"), o.local);
  providers.setWaker(local.ollama);
  const github = new GitHub(o.db, cipher, o.github);
  const mcpRepo = new McpRepo(o.db, cipher);
  const mcp = new McpHub(mcpRepo);
  const approvals = new ChatApprovals();
  const shots = new Shots(join(o.dataDir, "screenshots"));
  const visualKit = { background: new Background(), screenshot: o.screenshot ?? null, shots };
  const media = new MediaRepo(o.db, o.dataDir);
  const chats = new ChatRepo(o.db, media, new AttachmentRepo(o.db, o.dataDir));
  const projects = new ProjectRepo(o.db);
  const tasks = new TaskRepo(o.db);
  const backlog = new BacklogRepo(o.db);
  const idleTimeoutMs = o.idleTimeoutMs ?? 120_000;
  const web = o.web ?? duckDuckGo;
  const runner = new AgentRunner({
    tasks,
    backlog,
    projects,
    providers,
    dataDir: o.dataDir,
    budgetUsd: () => readSettings(o.db).agentBudgetUsd,
    strongModel: () => readSettings(o.db).strongModel,
    acceptanceModel: () => readSettings(o.db).acceptanceModel,
    developer: () => readSettings(o.db).developer,
    imageModel: () => readSettings(o.db).imageModel,
    media,
    web,
    mcp,
    visualKit,
    visionModel: () => readSettings(o.db).visionModel,
    skillsDir: join(o.dataDir, "skills"),
    idleTimeoutMs,
  });
  const backlogService = new BacklogService(backlog, tasks, runner);
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
        // Install commands differ between Windows and the rest; this is the computer the programs run on.
        platform: process.platform,
      }),
    )
    .get("/rates", async (c) => c.json({ usdRub: await usdRub() }))
    .get("/settings", (c) => c.json(readSettings(o.db)))
    .patch("/settings", zValidator("json", settingsPatchSchema), (c) =>
      c.json(writeSettings(o.db, c.req.valid("json"))),
    )
    .route("/providers", providerRoutes(providers))
    .route("/local", localRoutes(local))
    .route("/proxy", proxyRoutes(proxies, o.proxyCheckUrl ?? "https://www.google.com/generate_204"))
    .route("/chats", chatRoutes(chats, providers, studio, web, mcp, approvals, idleTimeoutMs, join(o.dataDir, "cli-chats")))
    .route("/mcp", mcpRoutes(mcpRepo, mcp))
    .route("/media", mediaRoutes(media))
    .route("/skills", skillRoutes(join(o.dataDir, "skills")))
    .route("/usage", usageRoutes(chats))
    .route("/projects", projectRoutes(projects, tasks, providers, runner))
    .route("/projects", backlogRoutes(projects, backlog, backlogService))
    .route("/tasks", taskRoutes(tasks, runner, shots, backlogService))
    .route("/github", githubRoutes(github, projects));

  const hosts = new Set(o.allowedHosts ?? defaultHosts);
  const auth = new AuthStore(o.db);
  if (!o.password && !o.token) throw new Error("Either a token or a password setup is required");
  const app = new Hono()
    .use("*", hostGuard(hosts))
    .use("/api/*", o.password ? sessionGuard(auth, hosts) : tokenGuard(o.token!, new Set(["/api/health"])))
    .route("/api/auth", authRoutes(auth, o.password?.setupCode ?? null))
    .route("/api", api);

  app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
  if (o.webDir) app.get("*", webHandler(o.webDir));
  return {
    app,
    /** Server mode: nobody can sign in until the first password is set with the setup code. */
    needsPassword: () => !!o.password && !auth.passwordSet(),
    shutdown: async () => {
      studio.shutdown();
      await runner.shutdown();
      visualKit.background.shutdown();
      await mcp.shutdown();
      local.close();
    },
  };
}

export function createApp(o: AppOptions) {
  return createCore(o).app;
}

export type AppType = ReturnType<typeof createApp>;
