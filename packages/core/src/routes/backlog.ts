import { zValidator } from "@hono/zod-validator";
import { backlogItemInputSchema, backlogOrderSchema, backlogRunSchema, backlogUpdateSchema } from "@artel/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { ProjectRepo } from "../agent/repo";
import type { BacklogRepo } from "../backlog/repo";
import { BacklogRefused, type BacklogService } from "../backlog/service";

const notFound = { error: { code: "not_found" } } as const;
const planSchema = z.object({ task: z.string().trim().min(1).max(50_000), providerId: z.string().min(1), model: z.string().min(1).max(200) }).strict();

function refused(err: unknown) {
  if (err instanceof BacklogRefused) return { error: { code: err.code } };
  throw err;
}

/** The project's task list: the plan that fills it, editing it, and running it batch by batch. */
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
    .post("/:id/backlog/plan", zValidator("json", planSchema), async (c) => {
      const id = c.req.param("id");
      if (!projects.get(id)) return c.json(notFound, 404);
      return c.json(await service.plan(id, c.req.valid("json")), 201);
    })
    .post("/:id/backlog", zValidator("json", backlogItemInputSchema), (c) => {
      const id = c.req.param("id");
      if (!projects.get(id)) return c.json(notFound, 404);
      return c.json(backlog.add(id, [c.req.valid("json")])[0]!, 201);
    })
    .patch("/:id/backlog/:itemId", zValidator("json", backlogUpdateSchema), (c) => {
      const item = own(c.req.param("id"), c.req.param("itemId"));
      if (!item) return c.json(notFound, 404);
      backlog.update(item.id, c.req.valid("json"));
      return c.json(backlog.get(item.id)!, 200);
    })
    .delete("/:id/backlog/:itemId", (c) => {
      const item = own(c.req.param("id"), c.req.param("itemId"));
      if (!item) return c.json(notFound, 404);
      if (item.status === "active" || item.status === "review") return c.json({ error: { code: "busy" as const } }, 409);
      backlog.remove(item.id);
      return c.body(null, 204);
    })
    .post("/:id/backlog/order", zValidator("json", backlogOrderSchema), (c) => {
      const id = c.req.param("id");
      if (!projects.get(id)) return c.json(notFound, 404);
      backlog.reorder(id, c.req.valid("json").ids);
      return c.json({ items: backlog.list(id) }, 200);
    })
    .post("/:id/backlog/run", zValidator("json", backlogRunSchema), async (c) => {
      const id = c.req.param("id");
      if (!projects.get(id)) return c.json(notFound, 404);
      const { ids, providerId, model } = c.req.valid("json");
      try {
        return c.json(await service.run(id, ids, providerId, model), 201);
      } catch (err) {
        return c.json(refused(err), 409);
      }
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
    })
    .post("/:id/backlog/next", async (c) => {
      const id = c.req.param("id");
      if (!projects.get(id)) return c.json(notFound, 404);
      try {
        return c.json(await service.next(id), 201);
      } catch (err) {
        return c.json(refused(err), 409);
      }
    });
}
