import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PresetId } from "@artel/shared";
import { createCore, openDatabase, type Database } from "../src";
import type { WebAccess } from "../src/internet/web";

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
  close(): void;
  /** Stops running agents first; use when a test may leave one running. */
  closeAsync(): Promise<void>;
}

export function createTestEnv(): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "artel-core-"));
  const secretKey = randomBytes(32);
  let idleTimeoutMs: number | undefined;
  let mediaPollMs: number | undefined;
  // Never the network in tests.
  let usdRub = 80;
  const presetUrls: Partial<Record<PresetId, string>> = {};
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
    db: openDatabase(join(dir, "artel.db")),
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
    call: async (method, path, body) =>
      await env.app().request(`${BASE}${path}`, {
        method,
        headers: { ...auth, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    reopen() {
      void core?.shutdown();
      core = undefined;
      env.db.close();
      env.db = openDatabase(join(dir, "artel.db"));
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
