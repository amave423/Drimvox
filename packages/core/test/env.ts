import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCore, openDatabase, type Database } from "../src";

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
  close(): void;
  /** Stops running agents first; use when a test may leave one running. */
  closeAsync(): Promise<void>;
}

export function createTestEnv(): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "artel-core-"));
  const secretKey = randomBytes(32);
  let idleTimeoutMs: number | undefined;
  // One core per open database: running agents and pending approvals live in it between requests.
  let core: ReturnType<typeof createCore> | undefined;
  const coreFor = (webDir?: string) => {
    if (webDir) return createCore({ db: env.db, token: TOKEN, secretKey, version: "0.0.0-test", dataDir: dir, webDir, idleTimeoutMs });
    core ??= createCore({ db: env.db, token: TOKEN, secretKey, version: "0.0.0-test", dataDir: dir, idleTimeoutMs });
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
