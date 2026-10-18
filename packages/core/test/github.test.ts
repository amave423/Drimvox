import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "./env";
// @ts-expect-error A plain module shared with the window's tests.
import { FAKE_TOKEN, startFakeGithub } from "./fake-github.mjs";
import { git, makeRepo } from "./git-repo";

let env: TestEnv;
let hub: any;
const repos: string[] = [];

async function start(o: { pending?: number; deny?: boolean } = {}) {
  hub = await startFakeGithub(o);
  env.setGithub({ webUrl: hub.origin, apiUrl: hub.origin, pollMs: 20 });
}

beforeEach(() => {
  env = createTestEnv();
});

afterEach(async () => {
  await env.closeAsync();
  await hub?.close();
  hub = undefined;
  for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const status = async () => await (await env.call("GET", "/api/github")).json();

async function signIn() {
  expect((await env.call("POST", "/api/github/login")).status).toBe(200);
  await expect.poll(async () => (await status()).user, { timeout: 5_000 }).toBe("octo");
}

async function project(): Promise<{ id: string; path: string }> {
  const path = makeRepo({ "index.html": "<h1>Hi</h1>\n" });
  repos.push(path);
  const res = await env.call("POST", "/api/projects", { path });
  return { id: (await res.json()).id, path };
}

describe("signing in", () => {
  it("shows GitHub's code, waits for the user and keeps the token to itself", async () => {
    await start({ pending: 2 });
    const started = await (await env.call("POST", "/api/github/login")).json();
    expect(started).toMatchObject({ user: null, pending: { userCode: "ABCD-1234", verificationUri: `${hub.origin}/login/device` } });
    await expect.poll(async () => (await status()).user, { timeout: 5_000 }).toBe("octo");

    const asked = hub.requests.find((r: any) => r.path === "/login/device/code");
    expect(asked.body).toMatchObject({ client_id: "Ov23liuac4Ai8HSL86BH", scope: "repo" });
    // The token never comes out: not in answers, not in the database as it is.
    expect(JSON.stringify(await status())).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(env.db.sql.prepare("select value from settings").all())).not.toContain(FAKE_TOKEN);

    // It survives a restart, and "Disconnect" forgets it.
    env.reopen();
    expect(await status()).toMatchObject({ user: "octo" });
    expect((await env.call("DELETE", "/api/github")).status).toBe(204);
    expect(await status()).toMatchObject({ user: null, pending: null });
  });

  it("says when the user refused", async () => {
    await start({ deny: true });
    await env.call("POST", "/api/github/login");
    await expect.poll(async () => (await status()).error, { timeout: 5_000 }).toBe("denied");
  });
});

describe("publishing", () => {
  it("creates a private repository, pushes the branch, then pushes new commits", async () => {
    await start();
    const p = await project();
    expect((await env.call("POST", `/api/github/projects/${p.id}/publish`, { name: "demo", private: true })).status).toBe(401);
    await signIn();

    const res = await env.call("POST", `/api/github/projects/${p.id}/publish`, { name: "demo", private: true });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ url: `${hub.origin}/octo/demo` });
    const made = hub.repos.get("demo");
    expect(made.private).toBe(true);
    expect(git(made.bare, "rev-parse", "main")).toBe(git(p.path, "rev-parse", "HEAD"));
    expect(hub.requests.find((r: any) => r.path === "/user/repos").auth).toBe(`Bearer ${FAKE_TOKEN}`);
    // The token is not written into the project's git config.
    expect(execFileSync("git", ["config", "--list", "--local"], { cwd: p.path, encoding: "utf8" })).not.toContain(FAKE_TOKEN);
    expect(await (await env.call("GET", `/api/github/projects/${p.id}`)).json()).toMatchObject({ remote: expect.stringContaining("demo.git") });

    // Published once: the next time it only pushes.
    expect((await env.call("POST", `/api/github/projects/${p.id}/publish`, { name: "demo2", private: true })).status).toBe(409);
    writeFileSync(join(p.path, "about.html"), "<p>About</p>\n");
    git(p.path, "add", "-A");
    git(p.path, "commit", "-q", "-m", "Add about page");
    expect((await env.call("POST", `/api/github/projects/${p.id}/push`)).status).toBe(200);
    expect(git(made.bare, "rev-parse", "main")).toBe(git(p.path, "rev-parse", "HEAD"));
  });

  it("says when the name is taken", async () => {
    await start();
    await signIn();
    const a = await project();
    const b = await project();
    await env.call("POST", `/api/github/projects/${a.id}/publish`, { name: "demo", private: false });
    const res = await env.call("POST", `/api/github/projects/${b.id}/publish`, { name: "demo", private: false });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({ code: "name_taken" });
    // Nothing was added to the second project.
    expect(execFileSync("git", ["remote"], { cwd: b.path, encoding: "utf8" }).trim()).toBe("");
  });
});
