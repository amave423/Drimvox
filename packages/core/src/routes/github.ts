import { zValidator } from "@hono/zod-validator";
import { githubPublishSchema } from "@drimvox/shared";
import { Hono } from "hono";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { ProjectRepo } from "../agent/repo";
import { GithubFailure, type GitHub } from "../github/github";
import { builtSite, markNoJekyll } from "../github/site";

const notFound = { error: { code: "not_found" } } as const;

const STATUS = { github_login: 401, name_taken: 409, has_remote: 409, no_remote: 409, push_failed: 502, github_error: 502 } as const;

/** Signing in to GitHub and publishing projects there. See docs/specs/github-publish.md. */
export function githubRoutes(github: GitHub, projects: ProjectRepo) {
  const failure = (err: unknown) => {
    if (err instanceof GithubFailure) return { body: { error: { code: err.code, detail: err.message } }, status: STATUS[err.code] };
    throw err;
  };
  const folder = (id: string) => {
    const project = projects.get(id);
    return project && existsSync(project.path) ? project.path : null;
  };

  return new Hono()
    .get("/", (c) => c.json(github.status()))
    .post("/login", async (c) => c.json(await github.login()))
    .delete("/", (c) => {
      github.disconnect();
      return c.body(null, 204);
    })
    .get("/projects/:id", async (c) => {
      const dir = folder(c.req.param("id"));
      if (!dir) return c.json(notFound, 404);
      return c.json(await github.project(dir), 200);
    })
    .post("/projects/:id/publish", zValidator("json", githubPublishSchema), async (c) => {
      const dir = folder(c.req.param("id"));
      if (!dir) return c.json(notFound, 404);
      const input = c.req.valid("json");
      try {
        return c.json(await github.publish(dir, input.name, input.private), 201);
      } catch (err) {
        const f = failure(err);
        return c.json(f.body, f.status);
      }
    })
    // The finished site, published with GitHub Pages (docs/specs/github-publish.md).
    .post("/projects/:id/site", async (c) => {
      const dir = folder(c.req.param("id"));
      if (!dir) return c.json(notFound, 404);
      const site = await builtSite(dir);
      if (!site) return c.json({ error: { code: "no_site" as const } }, 409);
      try {
        markNoJekyll(join(dir, site));
        return c.json({ ...(await github.publishSite(dir, join(dir, site))), folder: site }, 200);
      } catch (err) {
        const f = failure(err);
        return c.json(f.body, f.status);
      }
    })
    .post("/projects/:id/push", async (c) => {
      const dir = folder(c.req.param("id"));
      if (!dir) return c.json(notFound, 404);
      try {
        await github.push(dir);
        return c.json({ ok: true as const }, 200);
      } catch (err) {
        const f = failure(err);
        return c.json(f.body, f.status);
      }
    });
}
