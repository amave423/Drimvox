import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { forgetCliProxy } from "../src/local/cliproxy-leftovers";
import { createTestEnv, type TestEnv } from "./env";

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.closeAsync();
  env = undefined;
});

// CLIProxyAPI is gone: what an earlier version left (its provider, program and setting) is cleared at start.
it("clears what CLIProxyAPI left and leaves the rest alone", async () => {
  env = createTestEnv();
  const kept = await (await env.call("POST", "/api/providers", { preset: "custom", name: "CLIProxyAPI", baseUrl: "http://127.0.0.1:8317/v1", apiKey: "k" })).json();
  const other = await (await env.call("POST", "/api/providers", { preset: "custom", name: "Other", baseUrl: "http://127.0.0.1:9/v1", apiKey: "k" })).json();
  const dir = mkdtempSync(join(tmpdir(), "drimvox-cliproxy-"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "cli-proxy-api.exe"), "");
  env.db.sql.prepare("insert into settings (key, value) values ('cliproxy', ?)").run(JSON.stringify({ providerId: kept.id, pid: null }));

  // The providers as the core keeps them, straight in the database.
  const db = env.db;
  const providers = {
    get: (id: string) => (db.sql.prepare("select id from providers where id = ?").get(id) ?? null) as never,
    remove: (id: string) => Number(db.sql.prepare("delete from providers where id = ?").run(id).changes) > 0,
  };
  forgetCliProxy(env.db, providers, dir);

  const ids = ((await (await env.call("GET", "/api/providers")).json()) as { id: string }[]).map((p) => p.id);
  expect(ids).toEqual([other.id]);
  expect(existsSync(dir)).toBe(false);
  expect(env.db.sql.prepare("select 1 from settings where key = 'cliproxy'").get()).toBeUndefined();
  // Once only: nothing left, nothing more removed.
  forgetCliProxy(env.db, providers, dir);
  expect(((await (await env.call("GET", "/api/providers")).json()) as unknown[]).length).toBe(1);
  rmSync(dir, { recursive: true, force: true });
});
