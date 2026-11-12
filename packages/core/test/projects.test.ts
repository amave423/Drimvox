import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "./env";
import { git, makeRepo } from "./git-repo";

let env: TestEnv;
let repo: string;

beforeEach(() => {
  env = createTestEnv();
  repo = makeRepo({ "src/app.ts": "export const greeting = 'hi';\n", "README.md": "# Demo\n" });
});

afterEach(async () => {
  await env.closeAsync();
  rmSync(repo, { recursive: true, force: true });
});

describe("projects", () => {
  it("adds a git repository", async () => {
    const res = await env.call("POST", "/api/projects", { path: repo });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ path: repo, gitState: "ready" });
  });

  // Seen live: git appeared in the user's folder though nobody asked. A plain folder stays plain until the user agrees on
  // the project's page; then it gets git, dependencies left out.
  it("starts git in a plain folder only when the user asks", async () => {
    const plain = mkdtempSync(join(tmpdir(), "drimvox-plain-"));
    writeFileSync(join(plain, "notes.txt"), "hello");
    mkdirSync(join(plain, "node_modules", "x"), { recursive: true });
    writeFileSync(join(plain, "node_modules", "x", "index.js"), "x");
    const added = await (await env.call("POST", "/api/projects", { path: plain })).json();
    expect(added.gitState).toBe("not_repo");
    expect(existsSync(join(plain, ".git"))).toBe(false);
    const project = await (await env.call("POST", `/api/projects/${added.id}/init-git`)).json();
    expect(project.gitState).toBe("ready");
    expect(git(plain, "log", "--format=%s")).toBe("Initial commit");
    expect(git(plain, "show", "--name-only", "--format=")).toBe("notes.txt");
    rmSync(plain, { recursive: true, force: true });
  });

  it("commits under the computer's user name when git has none set", async () => {
    const plain = mkdtempSync(join(tmpdir(), "drimvox-plain-"));
    writeFileSync(join(plain, "notes.txt"), "hello");
    const empty = join(plain, "..", `drimvox-empty-gitconfig-${Date.now()}`);
    writeFileSync(empty, "");
    const keys = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys.slice(2)) delete process.env[k];
    process.env.GIT_CONFIG_GLOBAL = empty;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    try {
      const added = await (await env.call("POST", "/api/projects", { path: plain })).json();
      const project = await (await env.call("POST", `/api/projects/${added.id}/init-git`)).json();
      expect(project.gitState).toBe("ready");
      // Windows' git refuses to commit without a name, and Drimvox gives the user's; macOS's git takes the account's
      // full name by itself (seen on a Mac runner: "Anka" for the user "runner"). Either way the commit is made.
      const author = git(plain, "log", "--format=%an");
      if (process.platform === "win32") expect(author).toBe(userInfo().username);
      else expect(author).toMatch(/\S/);
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      rmSync(empty, { force: true });
      rmSync(plain, { recursive: true, force: true });
    }
  });

  // Seen: a project was called by its folder's name with no way to change it; chats could be renamed.
  it("renames a project without touching its folder", async () => {
    const project = await (await env.call("POST", "/api/projects", { path: repo })).json();
    const res = await env.call("PATCH", `/api/projects/${project.id}`, { name: "  Сайт кофейни  " });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "Сайт кофейни", path: repo });
    expect((await (await env.call("GET", "/api/projects")).json())[0].name).toBe("Сайт кофейни");
    expect((await env.call("PATCH", `/api/projects/${project.id}`, { name: " " })).status).toBe(400);
    expect((await env.call("PATCH", "/api/projects/nope", { name: "X" })).status).toBe(404);
  });

  it("refuses a folder that does not exist", async () => {
    const res = await env.call("POST", "/api/projects", { path: join(repo, "nope") });
    expect(res.status).toBe(400);
  });

  it("lists and removes projects without touching the folder", async () => {
    const project = await (await env.call("POST", "/api/projects", { path: repo })).json();
    expect((await (await env.call("GET", "/api/projects")).json()).length).toBe(1);
    expect((await env.call("DELETE", `/api/projects/${project.id}`)).status).toBe(204);
    expect(existsSync(join(repo, "README.md"))).toBe(true);
  });
});

