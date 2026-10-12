import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BASE, auth, createTestEnv, type TestEnv } from "./env";

let env: TestEnv;

beforeEach(() => {
  env = createTestEnv();
});

afterEach(() => env.close());

const app = (webDir?: string) => env.app(webDir);

describe("health", () => {
  it("answers without a token", async () => {
    const res = await app().request(`${BASE}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("protection", () => {
  it("rejects api calls without a token", async () => {
    const res = await app().request(`${BASE}/api/settings`);
    expect(res.status).toBe(401);
  });

  it("rejects api calls with a wrong token", async () => {
    const res = await app().request(`${BASE}/api/settings`, { headers: { Authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });

  it("rejects requests addressed to a foreign host (DNS rebinding)", async () => {
    const res = await app().request("http://evil.example/api/health");
    expect(res.status).toBe(403);
  });

  it("accepts localhost as a host", async () => {
    const res = await app().request("http://localhost:5173/api/health");
    expect(res.status).toBe(200);
  });
});

describe("status", () => {
  it("reports version and data location", async () => {
    const res = await app().request(`${BASE}/api/status`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ version: "0.0.0-test", dataDir: env.dir });
  });
});

describe("settings", () => {
  it("returns defaults on a fresh database", async () => {
    const res = await app().request(`${BASE}/api/settings`, { headers: auth });
    expect(await res.json()).toEqual({ theme: "system", locale: "ru", agentBudgetUsd: 0.5, strongModel: null, imageModel: null });
  });

  it("saves a partial update and keeps it after reopening the database", async () => {
    const res = await app().request(`${BASE}/api/settings`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ theme: "dark" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ theme: "dark", locale: "ru", agentBudgetUsd: 0.5, strongModel: null, imageModel: null });

    env.reopen();
    const again = await app().request(`${BASE}/api/settings`, { headers: auth });
    expect(await again.json()).toEqual({ theme: "dark", locale: "ru", agentBudgetUsd: 0.5, strongModel: null, imageModel: null });
  });

  it("refuses unknown values", async () => {
    const res = await app().request(`${BASE}/api/settings`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ theme: "pink" }),
    });
    expect(res.status).toBe(400);
  });

  it("refuses unknown keys", async () => {
    const res = await app().request(`${BASE}/api/settings`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "x" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("database", () => {
  it("can be opened twice without re-running migrations", () => {
    const version = env.db.schemaVersion();
    env.reopen();
    expect(env.db.schemaVersion()).toBe(version);
  });
});

describe("web ui", () => {
  let web: string;

  beforeEach(() => {
    web = join(env.dir, "web");
    mkdirSync(join(web, "assets"), { recursive: true });
    writeFileSync(join(web, "index.html"), "<!doctype html><title>Artel</title>");
    writeFileSync(join(web, "assets", "app.js"), "console.log(1)");
    writeFileSync(join(env.dir, "secret.txt"), "do not serve");
  });

  it("serves index.html at the root", async () => {
    const res = await app(web).request(`${BASE}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<title>Artel</title>");
  });

  it("locks the page to its own origin", async () => {
    const res = await app(web).request(`${BASE}/`);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("serves assets with a matching content type", async () => {
    const res = await app(web).request(`${BASE}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
  });

  it("falls back to index.html for app routes", async () => {
    const res = await app(web).request(`${BASE}/settings`);
    expect(await res.text()).toContain("<title>Artel</title>");
  });

  it("never serves files outside the web folder", async () => {
    const res = await app(web).request(`${BASE}/..%2Fsecret.txt`);
    expect(await res.text()).not.toContain("do not serve");
  });

  it("answers 404 for unknown api routes instead of the page", async () => {
    const res = await app(web).request(`${BASE}/api/nope`, { headers: auth });
    expect(res.status).toBe(404);
  });
});
