import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "./env";

// Asked for: ready skills from their authors (Anthropic's open ones, obra/superpowers) installed in one click.
let env: TestEnv;
let server: Server;
let base: string;

const files: Record<string, string> = {
  "skills/frontend-design/SKILL.md": "---\nname: frontend-design\ndescription: Distinctive interfaces\n---\n\n# Frontend design\nBe bold.\n",
  "skills/frontend-design/LICENSE.txt": "Apache License 2.0\n",
  "skills/frontend-design/examples/card.html": "<div>card</div>\n",
  "skills/other/SKILL.md": "---\nname: other\ndescription: Not this one\n---\nNo.\n",
};

beforeEach(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/api/repos/anthropics/skills/git/trees/main?recursive=1") {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ tree: [...Object.keys(files).map((path) => ({ path, type: "blob", size: files[path]!.length })), { path: "skills/frontend-design/examples", type: "tree" }] }));
    }
    const raw = url.match(/^\/raw\/anthropics\/skills\/main\/(.+)$/);
    if (raw && files[decodeURIComponent(raw[1]!)] !== undefined) return res.end(files[decodeURIComponent(raw[1]!)]);
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  env = createTestEnv();
  env.setSkillSources({ api: `${base}/api`, raw: `${base}/raw` });
});

afterEach(async () => {
  await env.closeAsync();
  await new Promise((r) => server.close(r));
});

describe("installing a ready skill", () => {
  it("takes the skill's folder from a GitHub repository with all its files", async () => {
    const res = await env.call("POST", "/api/skills/install", { source: { kind: "github", repo: "anthropics/skills", path: "skills/frontend-design", ref: "main" } });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ name: "frontend-design", description: "Distinctive interfaces", scope: "shared" });
    const dir = join(env.dir, "skills", "frontend-design");
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toContain("Be bold.");
    expect(readFileSync(join(dir, "examples", "card.html"), "utf8")).toBe("<div>card</div>\n");
    expect(existsSync(join(env.dir, "skills", "other"))).toBe(false);
    // Installed once: the same again says so.
    expect((await env.call("POST", "/api/skills/install", { source: { kind: "github", repo: "anthropics/skills", path: "skills/frontend-design", ref: "main" } })).status).toBe(409);
  });

  it("refuses a folder without SKILL.md and paths that leave the repository", async () => {
    expect((await env.call("POST", "/api/skills/install", { source: { kind: "github", repo: "anthropics/skills", path: "skills/missing", ref: "main" } })).status).toBe(400);
    expect((await env.call("POST", "/api/skills/install", { source: { kind: "github", repo: "anthropics/skills", path: "../etc", ref: "main" } })).status).toBe(400);
  });

  it("installs Drimvox's own skills, such as Word documents", async () => {
    const res = await env.call("POST", "/api/skills/install", { source: { kind: "builtin", id: "docx" } });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ name: "docx" });
    expect(readFileSync(join(env.dir, "skills", "docx", "SKILL.md"), "utf8")).toMatch(/python-docx/);
  });
});
