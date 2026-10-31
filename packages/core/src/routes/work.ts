import { zValidator } from "@hono/zod-validator";
import { projectGitRulesSchema, projectPlanReviseSchema, projectPlanStartSchema, projectWorkChatSchema, projectWorkMessageSchema, projectWorkStartSchema, projectWorkUpdateSchema } from "@drimvox/shared";
import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import type { ProjectRepo } from "../agent/repo";
import { TaskBusy } from "../agent/runner";
import type { ProviderRepo } from "../providers/repo";
import type { Shots } from "../visual/look";
import { folderChanges } from "../work/changes";
import { workReport } from "../work/report";
import type { ProjectWorkRepo } from "../work/repo";
import type { ProjectGit } from "../work/project-git";
import { WorkRefused, type ProjectWork } from "../work/service";

const notFound = { error: { code: "not_found" } } as const;

/** A project's work (docs/specs/project-work.md): the interview and the plan, "Go", messages on the way, Stop, limits. */
export function workRoutes(projects: ProjectRepo, providers: ProviderRepo, work: ProjectWork, shots: Shots, repo: ProjectWorkRepo, git: ProjectGit) {
  const refused = (err: unknown) => {
    if (err instanceof WorkRefused) return { error: { code: err.code } };
    if (err instanceof TaskBusy) return { error: { code: "busy" as const } };
    throw err;
  };
  return new Hono()
    .get("/:id/work", (c) => (projects.get(c.req.param("id")) ? c.json(work.view(c.req.param("id")), 200) : c.json(notFound, 404)))
    .post("/:id/work/plan", zValidator("json", projectPlanStartSchema), async (c) => {
      const id = c.req.param("id");
      if (!projects.get(id)) return c.json(notFound, 404);
      const { task, models, quick } = c.req.valid("json");
      const refs = [models.interview, models.plan, models.work, ...(models.strong ? [models.strong] : [])];
      if (refs.some((m) => !providers.get(m.providerId))) return c.json({ error: { code: "invalid", detail: "Unknown provider" } }, 400);
      try {
        return c.json(await work.plan(id, task, models, quick), 201);
      } catch (err) {
        return c.json(refused(err), 409);
      }
    })
    .post("/:id/work/revise", zValidator("json", projectPlanReviseSchema), (c) => {
      const id = c.req.param("id");
      if (!projects.get(id)) return c.json(notFound, 404);
      try {
        return c.json(work.revise(id, c.req.valid("json").note), 200);
      } catch (err) {
        return c.json(refused(err), 409);
      }
    })
    .post("/:id/work/start", zValidator("json", projectWorkStartSchema), (c) => {
      const id = c.req.param("id");
      if (!projects.get(id)) return c.json(notFound, 404);
      try {
        return c.json(work.start(id, c.req.valid("json")), 200);
      } catch (err) {
        return c.json(refused(err), 409);
      }
    })
    .post("/:id/work/message", zValidator("json", projectWorkMessageSchema), (c) => {
      const id = c.req.param("id");
      if (!projects.get(id)) return c.json(notFound, 404);
      try {
        return c.json(work.message(id, c.req.valid("json").content), 200);
      } catch (err) {
        return c.json(refused(err), 409);
      }
    })
    .post("/:id/work/chat", zValidator("json", projectWorkChatSchema), (c) => {
      const id = c.req.param("id");
      if (!projects.get(id)) return c.json(notFound, 404);
      const { content, model } = c.req.valid("json");
      if (!providers.get(model.providerId)) return c.json({ error: { code: "invalid", detail: "Unknown provider" } }, 400);
      try {
        return c.json(work.chat(id, content, model), 200);
      } catch (err) {
        return c.json(refused(err), 409);
      }
    })
    .post("/:id/work/continue", (c) => {
      const id = c.req.param("id");
      if (!projects.get(id)) return c.json(notFound, 404);
      try {
        return c.json(work.continue(id), 200);
      } catch (err) {
        return c.json(refused(err), 409);
      }
    })
    .post("/:id/work/site/start", (c) => {
      const id = c.req.param("id");
      if (!projects.get(id)) return c.json(notFound, 404);
      try {
        return c.json(work.startSite(id), 200);
      } catch (err) {
        return c.json(refused(err), 409);
      }
    })
    .post("/:id/work/site/stop", (c) => (projects.get(c.req.param("id")) ? c.json(work.stopSite(c.req.param("id")), 200) : c.json(notFound, 404)))
    .post("/:id/work/stop", (c) => (work.stop(c.req.param("id")) ? c.json({ ok: true as const }, 200) : c.json(notFound, 404)))
    .patch("/:id/work", zValidator("json", projectWorkUpdateSchema), (c) => {
      const id = c.req.param("id");
      if (!projects.get(id)) return c.json(notFound, 404);
      const patch = c.req.valid("json");
      if (patch.strong && !providers.get(patch.strong.providerId)) return c.json({ error: { code: "invalid", detail: "Unknown provider" } }, 400);
      return c.json(work.update(id, patch), 200);
    })
    .get("/:id/work/report", async (c) => {
      const project = projects.get(c.req.param("id"));
      if (!project) return c.json(notFound, 404);
      const report = await workReport(repo, project.id, project.path);
      return report ? c.json(report, 200) : c.json(notFound, 404);
    })
    .get("/:id/work/changes", async (c) => {
      const project = projects.get(c.req.param("id"));
      if (!project) return c.json(notFound, 404);
      // In the agent's own branch: everything since the branch it came from, committed or not.
      const base = (await git.state(project.id, project.path)).base;
      return c.json(await folderChanges(project.path, base), 200);
    })
    // How the agent works with git, and where its branch is (docs/specs/project-git.md).
    .get("/:id/git", async (c) => {
      const project = projects.get(c.req.param("id"));
      if (!project) return c.json(notFound, 404);
      return c.json({ rules: git.rules(project.id), state: await git.state(project.id, project.path) }, 200);
    })
    .put("/:id/git/rules", zValidator("json", projectGitRulesSchema), (c) => {
      const project = projects.get(c.req.param("id"));
      if (!project) return c.json(notFound, 404);
      return c.json(git.setRules(project.id, c.req.valid("json")), 200);
    })
    .post("/:id/git/accept", async (c) => {
      const project = projects.get(c.req.param("id"));
      if (!project) return c.json(notFound, 404);
      if (work.isRunning(project.id)) return c.json({ error: { code: "busy" as const } }, 409);
      return (await git.accept(project.id, project.path)) ? c.json(await git.state(project.id, project.path), 200) : c.json({ error: { code: "merge_failed" as const } }, 409);
    })
    .post("/:id/git/reject", async (c) => {
      const project = projects.get(c.req.param("id"));
      if (!project) return c.json(notFound, 404);
      if (work.isRunning(project.id)) return c.json({ error: { code: "busy" as const } }, 409);
      return (await git.reject(project.id, project.path)) ? c.json(await git.state(project.id, project.path), 200) : c.json({ error: { code: "switch_failed" as const } }, 409);
    })
    .get("/:id/work/shots/:shot", async (c) => {
      const id = c.req.param("id");
      // Only the shots of this project's work: the id alone opens nothing else.
      if (!work.view(id).shots.some((s) => s.id === c.req.param("shot"))) return c.json(notFound, 404);
      const path = shots.path(c.req.param("shot"));
      if (!path) return c.json(notFound, 404);
      try {
        return c.body(new Uint8Array(await readFile(path)), 200, { "Content-Type": "image/png" });
      } catch {
        return c.json(notFound, 404);
      }
    });
}
