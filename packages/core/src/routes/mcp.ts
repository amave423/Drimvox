import { zValidator } from "@hono/zod-validator";
import { mcpServerCreateSchema, mcpServerUpdateSchema } from "@artel/shared";
import { Hono } from "hono";
import type { McpHub } from "../mcp/hub";
import type { McpRepo } from "../mcp/repo";

const notFound = { error: { code: "not_found" } } as const;

/** The user's MCP servers: add, look at their tools, switch off, forget "always allow". */
export function mcpRoutes(repo: McpRepo, hub: McpHub) {
  return new Hono()
    .get("/", (c) => c.json(repo.list()))
    .post("/", zValidator("json", mcpServerCreateSchema), (c) => c.json(repo.create(c.req.valid("json")), 201))
    .get("/:id/status", async (c) => {
      if (!repo.get(c.req.param("id"))) return c.json(notFound, 404);
      return c.json(await hub.status(c.req.param("id")), 200);
    })
    .patch("/:id", zValidator("json", mcpServerUpdateSchema), (c) => {
      const view = repo.update(c.req.param("id"), c.req.valid("json"));
      return view ? c.json(view, 200) : c.json(notFound, 404);
    })
    .delete("/:id", (c) => (repo.remove(c.req.param("id")) ? c.body(null, 204) : c.json(notFound, 404)))
    .delete("/:id/allowed/:tool", (c) =>
      repo.disallow(c.req.param("id"), c.req.param("tool")) ? c.body(null, 204) : c.json(notFound, 404),
    );
}
