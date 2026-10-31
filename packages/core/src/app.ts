import { AttachmentRepo } from "./chats/attachment-repo";
import { BacklogService } from "./backlog/service";
import { backlogRoutes } from "./routes/backlog";
import { BacklogRepo } from "./backlog/repo";
import { ProjectWorkRepo } from "./work/repo";
import { ProjectWork } from "./work/service";
import { workRoutes } from "./routes/work";
import { resolveVision } from "./visual/look";
import { findModel, listModels } from "./providers/catalog";
import { zValidator } from "@hono/zod-validator";
import { settingsPatchSchema, speakSchema, speechText, type PresetId } from "@drimvox/shared";
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
import { duckDuckGo, openPage, type PageReader, type PageShower, type WebAccess } from "./internet/web";
import { BlockedSites, withBlockedProxy } from "./internet/blocked";
import { Favicons } from "./internet/favicons";
import { Background } from "./agent/background";
import { McpHub } from "./mcp/hub";
import { AgentBrowser } from "./browser/agent-browser";
import { Browser } from "./browser/browser";
import { bingSearch, withSecondSearch } from "./internet/bing";
import type { BrowserDriver } from "./browser/driver";
import { browserRoutes } from "./routes/browser";
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
import { forgetCliProxy } from "./local/cliproxy-leftovers";
import { proxyRoutes } from "./routes/proxy";
import { searchRoutes } from "./routes/search";
import { monthUsage } from "./budget";
import { transcribe } from "./voice";
import { useLocalAudio } from "./local/audio/service";
import { z } from "zod";
import { describeError } from "./providers/errors";
import { spendingByModel } from "./savings";
import { SKILL_SOURCES, type SkillSources } from "./skills/install";
import { SEARCH_URLS, SearchStore, withSearchService, type SearchUrls } from "./internet/search-service";
import { githubRoutes } from "./routes/github";
import { GitHub, type GithubOptions } from "./github/github";
import { fetchVia, ProxyStore } from "./proxy";
import { taskRoutes } from "./routes/tasks";
import { setPriceCatalogUrl } from "./providers/native";
import type { CliId } from "./cli/kinds";
import { setCliCommands } from "./cli/resolve";
import { keepCliListsIn } from "./cli/models";
import { forgetLimits } from "./cli/limits";
import { setRateSource, usdRub, type RateSource } from "./rates";
import { Shots, type Screenshotter } from "./visual/look";
import { createCipher } from "./secrets";
import { readSettings, writeSettings } from "./settings";
import { webHandler } from "./web";
import { useLocalImages } from "./media/local";

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
  /** Reads a page in a real browser (scripts run): browse_page for models with the internet. */
  readPage?: PageReader;
  /** Shows a page to the user in a window, for a captcha or a sign-in they pass themselves (the desktop app only). */
  showPage?: PageShower;
  /**
   * The agent's browser: the desktop gives a tab inside its window; by default Chrome without a window, which the panel
   * shows as pictures (the server).
   */
  browser?: BrowserDriver;
  /** How to start Claude Code, Codex and Gemini CLI instead of finding them on PATH; tests run a fake. */
  cliCommands?: Partial<Record<CliId, string[]>>;
  /** What "Check the proxy" opens through it; a small page that answers fast by default. */
  proxyCheckUrl?: string;
  /** Where Tavily and Brave answer: fakes in tests. */
  searchUrls?: SearchUrls;
  /** Where GitHub answers for ready skills: a fake in tests. */
  skillSources?: SkillSources;
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
  keepCliListsIn(join(o.dataDir, "cli-models.json"));
  forgetLimits();
  // Prices of vendors' own APIs come from OpenRouter's public catalog (a fake one in tests).
  setPriceCatalogUrl(o.presetUrls?.openrouter);
  const cipher = createCipher(o.secretKey);
  const proxies = new ProxyStore(o.db, cipher);
  const searchStore = new SearchStore(o.db, cipher);
  const searchUrls = o.searchUrls ?? SEARCH_URLS;
  const providers = new ProviderRepo(o.db, cipher, proxies, o.presetUrls);
  const local = new LocalModels(providers, providers.urlOf("ollama"), { downloadsDir: join(o.dataDir, "downloads"), imagesDir: join(o.dataDir, "images"), audioDir: join(o.dataDir, "audio"), speechDir: join(o.dataDir, "speech"), proxy: () => proxies.url(), ...o.local });
  providers.setWaker(local.ollama);
  void local.connectIfServed().catch(() => {});
  // CLIProxyAPI is gone (asked for: Drimvox does it all itself): what an earlier version left is cleared once.
  forgetCliProxy(o.db, providers, join(o.dataDir, "cliproxy"));
  useLocalImages(local.images);
  useLocalAudio(local.audio);
  const github = new GitHub(o.db, cipher, o.github);
  const mcpRepo = new McpRepo(o.db, cipher);
  const agentBrowser = o.browser ?? new AgentBrowser({ profileDir: join(o.dataDir, "agent-browser") });
  const sites = new BlockedSites(o.db);
  // The marks of linked sites, asked of each site and kept on disk; a site closed from Russia through the proxy.
  const favicons = new Favicons(join(o.dataDir, "favicons"), (host) => {
    const proxy = proxies.url();
    return proxy && sites.has(host) ? fetchVia(proxy) : fetch;
  });
  const browser = new Browser(agentBrowser);
  // The desktop's browser takes the proxy for the listed sites only, and tells of a site that opened only through it.
  const driver: BrowserDriver = agentBrowser;
  const pushProxy = () => void driver.useProxy?.(proxies.url(), sites.list()).catch(() => {});
  driver.onBlocked?.((host) => sites.add(host));
  sites.onChange(pushProxy);
  pushProxy();
  // The Playwright server can work in Chrome without a window; the desktop's tab inside the window has no address for it.
  const mcp = new McpHub(mcpRepo, agentBrowser instanceof AgentBrowser ? agentBrowser : undefined);
  const approvals = new ChatApprovals();
  const shots = new Shots(join(o.dataDir, "screenshots"));
  const visualKit = { background: new Background(), screenshot: o.screenshot ?? null, shots };
  const media = new MediaRepo(o.db, o.dataDir);
  const chats = new ChatRepo(o.db, media, new AttachmentRepo(o.db, o.dataDir));
  const projects = new ProjectRepo(o.db);
  const tasks = new TaskRepo(o.db);
  const backlog = new BacklogRepo(o.db);
  const workRepo = new ProjectWorkRepo(o.db);
  const idleTimeoutMs = o.idleTimeoutMs ?? 120_000;
  // Sites that draw with scripts (databases, shops) are read in the desktop's or the server's browser.
  // A search service's key, when the user set one, replaces the free search (seen live: DuckDuckGo blocked again and again).
  // Behind DuckDuckGo, Bing (asked for: the free search must not stop at one engine's limit). Pages of sites closed from
  // Russia go through the proxy, the rest directly (asked for: some Russian sites refuse a proxy).
  const free = withSecondSearch(duckDuckGo, (q, s) => bingSearch(q, s));
  const base = withSearchService(
    o.web ?? withBlockedProxy(free, { proxy: () => proxies.url(), sites, openVia: (url, proxy, signal) => openPage(url, signal, fetchVia(proxy)) }),
    searchStore,
    searchUrls,
  );
  const reader = o.readPage;
  const shower = o.showPage;
  const web: WebAccess = {
    ...base,
    ...(base.render || !reader ? {} : { render: (url: string, steps?: Parameters<PageReader>[1]) => reader(url, steps) }),
    ...(base.show || !shower ? {} : { show: (url: string, reason: string) => shower(url, reason) }),
    // A fake internet (tests) gets the real browser only when it is given one too.
    ...(base.browser || (o.web && !o.browser) ? {} : { browser }),
  };
  const runner = new AgentRunner({
    tasks,
    backlog,
    work: workRepo,
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
  const backlogService = new BacklogService(backlog, projects, chats);
  const projectWork = new ProjectWork({
    repo: workRepo,
    runner,
    projects,
    chats,
    backlog,
    approvals,
    cliDir: join(o.dataDir, "cli-chats"),
    run: {
      chats,
      providers,
      approvals,
      repo: workRepo,
      visualKit,
      web,
      skillsDir: join(o.dataDir, "skills"),
      mcp,
      idleTimeoutMs,
      plan: (projectId) => backlog.plan(projectId),
      month: () => monthUsage(o.db, chats),
      vision: (conn, model) => resolveVision(readSettings(o.db).visionModel, providers, { providerId: conn.id, model }, findModel, listModels),
    },
  });
  const studio = new Studio({ chats, media, providers, pollMs: o.mediaPollMs ?? 10_000 });
  studio.resume();

  const api = new Hono()
    .get("/health", (c) => c.json({ ok: true as const }))
    .get("/favicon", async (c) => {
      const icon = await favicons.get(c.req.query("url") ?? "").catch(() => null);
      if (!icon) return c.body(null, 404);
      return c.body(new Uint8Array(icon.bytes), 200, { "content-type": icon.type, "cache-control": "private, max-age=86400" });
    })
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
    .route("/proxy", proxyRoutes(proxies, o.proxyCheckUrl ?? "https://www.google.com/generate_204", sites, pushProxy))
    .route("/search", searchRoutes(searchStore, searchUrls))
    // Dictation (asked for): the recording to the voice model from the settings, its text back.
    .post("/voice/transcribe", zValidator("json", z.object({ audio: z.string().min(1).max(30_000_000), mimeType: z.string().regex(/^audio\/[\w.+-]+$/) })), async (c) => {
      const choice = readSettings(o.db).voiceModel;
      const conn = choice ? providers.connection(choice.providerId) : null;
      if (!choice || !conn) return c.json({ error: { code: "no_voice_model" as const } }, 409);
      const { audio, mimeType } = c.req.valid("json");
      try {
        const bytes = Buffer.from(audio, "base64");
        // A model on this computer writes it down itself, free and offline (docs/specs/local-audio.md).
        const text = conn.preset === "whispercpp" ? await local.audio.transcribe(choice.model, bytes) : await transcribe(conn, choice.model, bytes, mimeType);
        return c.json({ text }, 200);
      } catch (err) {
        return c.json({ error: describeError(err) }, 502);
      }
    })
    // An answer read aloud by the Piper voice from the settings (docs/specs/local-speech.md), as a WAV.
    .post("/voice/speak", zValidator("json", speakSchema), async (c) => {
      const voice = readSettings(o.db).speechVoice;
      if (!voice) return c.json({ error: { code: "no_speech_voice" as const } }, 409);
      try {
        const words = speechText(c.req.valid("json").text);
        if (!words) return c.json({ error: { code: "nothing_to_read" as const } }, 400);
        const wav = await local.speech.speak(voice, words);
        return c.body(new Uint8Array(wav), 200, { "Content-Type": "audio/wav" });
      } catch (err) {
        return c.json({ error: { code: "speech_failed" as const, detail: err instanceof Error ? err.message : String(err) } }, 502);
      }
    })
    .route(
      "/chats",
      chatRoutes(chats, providers, studio, web, mcp, approvals, idleTimeoutMs, join(o.dataDir, "cli-chats"), {
        service: backlogService,
        plan: (projectId) => backlog.plan(projectId),
        visualKit,
        visionModel: () => readSettings(o.db).visionModel,
        folderAutoApprove: () => readSettings(o.db).folderAutoApprove,
        skillsDir: join(o.dataDir, "skills"),
        month: () => monthUsage(o.db, chats),
      }),
    )
    .route("/mcp", mcpRoutes(mcpRepo, mcp))
    .route("/browser", browserRoutes(browser))
    .route("/media", mediaRoutes(media))
    .route("/skills", skillRoutes(join(o.dataDir, "skills"), o.skillSources ?? SKILL_SOURCES))
    .route("/usage", usageRoutes(chats, () => monthUsage(o.db, chats), async (since) => spendingByModel(o.db, providers, since)))
    .route("/projects", projectRoutes(projects, tasks, providers, runner))
    .route("/projects", backlogRoutes(projects, backlog, backlogService))
    .route("/projects", workRoutes(projects, providers, projectWork, shots, workRepo))
    .route("/tasks", taskRoutes(tasks, runner, shots, backlogService))
    .route("/github", githubRoutes(github, projects))
    // Every project's work at once: the window's notifications (docs/specs/project-work.md).
    .get("/work", (c) => c.json(projectWork.list()));

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
      await projectWork.shutdown();
      await runner.shutdown();
      visualKit.background.shutdown();
      await mcp.shutdown();
      await agentBrowser.stop();
      local.close();
    },
  };
}

export function createApp(o: AppOptions) {
  return createCore(o).app;
}

export type AppType = ReturnType<typeof createApp>;
