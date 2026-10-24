import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PresetId } from "@drimvox/shared";
import { createCore, openDatabase, type Database } from "../src";
import type { WebAccess } from "../src/internet/web";
import type { SearchUrls } from "../src/internet/search-service";
import type { Screenshotter } from "../src/visual/look";
import type { CliId } from "../src/cli/kinds";
import type { LocalOptions } from "../src/local/service";
import type { GithubOptions } from "../src/github/github";

export const TOKEN = "test-token";
export const BASE = "http://127.0.0.1";
export const auth = { Authorization: `Bearer ${TOKEN}` };

/** Tests read loosely shaped JSON; types are asserted by the expectations. */
export type JsonResponse = Omit<Response, "json"> & { json(): Promise<any> };

export interface TestEnv {
  dir: string;
  db: Database;
  secretKey: Buffer;
  app(webDir?: string): ReturnType<typeof createCore>["app"];
  /** JSON request against the API with the token. */
  call(method: string, path: string, body?: unknown): Promise<JsonResponse>;
  /** A request with only the headers given: no token, as a browser on the server would send it. */
  raw(method: string, path: string, init?: { body?: unknown; headers?: Record<string, string> }): Promise<JsonResponse>;
  reopen(): void;
  /** Shortens how long a reply may stay silent, so tests do not wait 90 seconds. */
  setIdleTimeout(ms: number): void;
  /** Checks clips being rendered this often instead of every 10 seconds. */
  setMediaPollMs(ms: number): void;
  /** A fixed rate instead of the Central Bank's feed. */
  setUsdRub(rate: number): void;
  /** Points a fixed preset, such as RouterAI, at a fake server. */
  setPresetUrl(preset: PresetId, url: string): void;
  /** Replaces the internet for models. */
  setWeb(web: WebAccess): void;
  /** Screenshots for agents, instead of the desktop app's hidden window. */
  setScreenshot(fn: Screenshotter): void;
  /** Starts this program instead of Claude Code, Codex or Gemini CLI. */
  setCliCommand(id: CliId, argv: string[]): void;
  /** What checking the proxy opens through it. */
  setProxyCheckUrl(url: string): void;
  /** Where Tavily and Brave answer. */
  setSearchUrls(urls: SearchUrls): void;
  /** Ollama and its catalogs: by default nothing is installed and no catalog answers. */
  setLocal(o: LocalOptions): void;
  /** GitHub: by default an address where nothing answers. */
  setGithub(o: GithubOptions): void;
  close(): void;
  /** Stops running agents first; use when a test may leave one running. */
  closeAsync(): Promise<void>;
}

/** `setupCode` turns on the server's password sign-in instead of the desktop's token. */
export function createTestEnv(o: { setupCode?: string } = {}): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "drimvox-core-"));
  const secretKey = randomBytes(32);
  let idleTimeoutMs: number | undefined;
  let mediaPollMs: number | undefined;
  // Never the network in tests.
  let usdRub = 80;
  // Never this computer's own Ollama: one may be running on its usual port (seen: it made "installed" true at once).
  const presetUrls: Partial<Record<PresetId, string>> = { ollama: "http://127.0.0.1:9/v1" };
  let screenshot: Screenshotter | undefined;
  const cliCommands: Partial<Record<CliId, string[]>> = {};
  let proxyCheckUrl = "http://127.0.0.1:9/no-internet-in-tests";
  let searchUrls: SearchUrls = { tavily: "http://127.0.0.1:9/search", brave: "http://127.0.0.1:9/brave" };
  // Never the real Ollama, Hugging Face or this computer's hardware in tests.
  let local: LocalOptions = {
    command: null,
    hardware: { ramBytes: 32 * 2 ** 30, gpu: { name: "Test GPU", vramBytes: 10 * 2 ** 30 }, unified: false },
    registryUrl: "http://127.0.0.1:9",
    hfUrl: "http://127.0.0.1:9",
    images: { engineUrl: "http://127.0.0.1:9/engine.zip" },
  };
  let github: GithubOptions = { webUrl: "http://127.0.0.1:9", apiUrl: "http://127.0.0.1:9" };
  let web: WebAccess = {
    search: async () => {
      throw new Error("No internet in tests");
    },
    open: async () => {
      throw new Error("No internet in tests");
    },
  };
  // One core per open database: running agents and pending approvals live in it between requests.
  let core: ReturnType<typeof createCore> | undefined;
  const coreFor = (webDir?: string) => {
    const options = {
      db: env.db,
      token: TOKEN,
      secretKey,
      version: "0.0.0-test",
      dataDir: dir,
      idleTimeoutMs,
      mediaPollMs,
      usdRub: async () => usdRub,
      presetUrls,
      web,
      screenshot,
      cliCommands,
      proxyCheckUrl,
      searchUrls,
      local,
      github,
      ...(o.setupCode ? { password: { setupCode: o.setupCode } } : {}),
    };
    if (webDir) return createCore({ ...options, webDir });
    core ??= createCore(options);
    return core;
  };
  const dropCore = async () => {
    const old = core;
    core = undefined;
    await old?.shutdown();
  };
  const env: TestEnv = {
    dir,
    db: openDatabase(join(dir, "drimvox.db")),
    secretKey,
    app: (webDir) => coreFor(webDir).app,
    setIdleTimeout(ms) {
      idleTimeoutMs = ms;
      void dropCore();
    },
    setMediaPollMs(ms) {
      mediaPollMs = ms;
      void dropCore();
    },
    setUsdRub(rate) {
      usdRub = rate;
      void dropCore();
    },
    setPresetUrl(preset, url) {
      presetUrls[preset] = url;
      void dropCore();
    },
    setWeb(next) {
      web = next;
      void dropCore();
    },
    setScreenshot(fn) {
      screenshot = fn;
      void dropCore();
    },
    setProxyCheckUrl(url) {
      proxyCheckUrl = url;
      void dropCore();
    },
    setSearchUrls(urls) {
      searchUrls = urls;
      void dropCore();
    },
    setLocal(next) {
      local = { ...local, ...next };
      void dropCore();
    },
    setGithub(next) {
      github = next;
      void dropCore();
    },
    setCliCommand(id, argv) {
      cliCommands[id] = argv;
      void dropCore();
    },
    call: async (method, path, body) =>
      await env.app().request(`${BASE}${path}`, {
        method,
        headers: { ...auth, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    raw: async (method, path, init = {}) =>
      await env.app().request(`${BASE}${path}`, {
        method,
        headers: { ...(init.body === undefined ? {} : { "Content-Type": "application/json" }), ...init.headers },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
    reopen() {
      void core?.shutdown();
      core = undefined;
      env.db.close();
      env.db = openDatabase(join(dir, "drimvox.db"));
    },
    close() {
      void core?.shutdown();
      env.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
    async closeAsync() {
      await dropCore();
      env.db.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
  return env;
}

/** Reads a server-sent event stream to the end and returns the JSON payloads. */
export async function readEvents(res: Response): Promise<any[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}
