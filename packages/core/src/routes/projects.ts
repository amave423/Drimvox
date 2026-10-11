import { zValidator } from "@hono/zod-validator";
import { projectCreateSchema, taskCreateSchema, type ProjectView } from "@artel/shared";
import { Hono } from "hono";
import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { GitError, initWithCommit, isRepoRoot, removeWorktree } from "../agent/git";
import type { ProjectRepo, TaskRepo } from "../agent/repo";
import type { AgentRunner } from "../agent/runner";
import type { ProviderRepo } from "../providers/repo";

const notFound = { error: { code: "not_found" } } as const;

export function projectRoutes(projects: ProjectRepo, tasks: TaskRepo, providers: ProviderRepo, runner: AgentRunner) {
  const withGit = async (p: Omit<ProjectView, "gitState">): Promise<ProjectView> => ({
    ...p,
    gitState: existsSync(p.path) && (await isRepoRoot(p.path)) ? "ready" : "not_repo",
  });

  const gitFailure = (err: unknown) => {
    if (err instanceof GitError) return { error: { code: err.code, detail: err.message } };
    throw err;
  };

  return new Hono()
    .get("/", async (c) => c.json(await Promise.all(projects.list().map(withGit))))
    .post("/", zValidator("json", projectCreateSchema), async (c) => {
      const path = resolve(c.req.valid("json").path);
      if (!existsSync(path) || !statSync(path).isDirectory()) return c.json({ error: { code: "not_found" as const } }, 400);
      const existing = projects.findByPath(path);
      if (existing) return c.json(await withGit(existing), 200);
      try {
        return c.json(await withGit(projects.create(basename(path) || path, path)), 201);
      } catch (err) {
        return c.json(gitFailure(err), 409);
      }
    })
    .post("/:id/init-git", async (c) => {
      const project = projects.get(c.req.param("id"));
      if (!project) return c.json(notFound, 404);
      try {
        if (!(await isRepoRoot(project.path))) await initWithCommit(project.path);
        return c.json(await withGit(project), 200);
      } catch (err) {
        return c.json(gitFailure(err), 409);
      }
    })
    .delete("/:id", async (c) => {
      const project = projects.get(c.req.param("id"));
      if (!project) return c.json(notFound, 404);
      const own = tasks.list(project.id);
      if (own.some((t) => runner.isRunning(t.id))) return c.json({ error: { code: "busy" } }, 409);
      for (const t of own) {
        if (t.status !== "accepted" && t.status !== "discarded") await removeWorktree(project.path, t.worktree, t.branch).catch(() => {});
      }
      projects.remove(project.id);
      return c.body(null, 204);
    })
    .get("/:id/tasks", (c) => {
      const project = projects.get(c.req.param("id"));
      if (!project) return c.json(notFound, 404);
      return c.json(tasks.list(project.id).map((t) => runner.view(t.id)!), 200);
    })
    .post("/:id/tasks", zValidator("json", taskCreateSchema), async (c) => {
      const project = projects.get(c.req.param("id"));
      if (!project) return c.json(notFound, 404);
      const input = c.req.valid("json");
      if (!providers.get(input.providerId)) return c.json({ error: { code: "invalid", detail: "Unknown provider" } }, 400);
      if (!(await isRepoRoot(project.path))) return c.json({ error: { code: "not_repo" } }, 409);
      try {
        return c.json(await runner.start(project.id, input), 201);
      } catch (err) {
        return c.json(gitFailure(err), 409);
      }
    });
}
