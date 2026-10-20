import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { ProjectRepo } from "../agent/repo";
import type { BacklogRepo } from "../backlog/repo";
import { BacklogRefused, type BacklogService } from "../backlog/service";

const notFound = { error: { code: "not_found" } } as const;

function refused(err: unknown) {
  if (err instanceof BacklogRefused) return { error: { code: err.code } };
  throw err;
}

/**
 * The old task list, read only (docs/specs/project-work.md replaced it): its tasks' conversations can still show what they
 * changed, be accepted as one commit or rolled back.
 */
export function backlogRoutes(projects: ProjectRepo, backlog: BacklogRepo, service: BacklogService) {
  const own = (projectId: string, itemId: string) => {
    const item = backlog.get(itemId);
    return item && item.projectId === projectId ? item : null;
  };
  return new Hono()
    .get("/:id/backlog", (c) => {
      const id = c.req.param("id");
      if (!projects.get(id)) return c.json(notFound, 404);
      return c.json({ items: backlog.list(id), plan: backlog.plan(id) }, 200);
    })
    // A task's conversation: what it changed, accepting it as one commit, or rolling the folder back.
    .get("/:id/backlog/:itemId/changes", async (c) => {
      const item = own(c.req.param("id"), c.req.param("itemId"));
      if (!item) return c.json(notFound, 404);
      try {
        return c.json(await service.changes(item.id), 200);
      } catch (err) {
        return c.json(refused(err), 409);
      }
    })
    .post("/:id/backlog/:itemId/accept", zValidator("json", z.object({ message: z.string().trim().max(500).optional() }).strict()), async (c) => {
      const item = own(c.req.param("id"), c.req.param("itemId"));
      if (!item) return c.json(notFound, 404);
      try {
        return c.json(await service.accept(item.id, c.req.valid("json").message), 200);
      } catch (err) {
        return c.json(refused(err), 409);
      }
    })
    .post("/:id/backlog/:itemId/undo", async (c) => {
      const item = own(c.req.param("id"), c.req.param("itemId"));
      if (!item) return c.json(notFound, 404);
      try {
        await service.undo(item.id);
        return c.json({ ok: true as const }, 200);
      } catch (err) {
        return c.json(refused(err), 409);
      }
    });
}
