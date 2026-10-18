import { limitsOf } from "../cli/limits";
import { isCli } from "../cli/kinds";
import { zValidator } from "@hono/zod-validator";
import { presets, providerCreateSchema, providerUpdateSchema } from "@artel/shared";
import { Hono } from "hono";
import { z } from "zod";
import { listMediaModels, mediaModel } from "../media/catalog";
import { fetchBalance } from "../providers/balance";
import { checkFree, withAvailability } from "../providers/availability";
import { listModels } from "../providers/catalog";
import { describeError } from "../providers/errors";
import { InvalidInput, type ProviderRepo } from "../providers/repo";

const notFound = { error: { code: "not_found" } } as const;

export function providerRoutes(providers: ProviderRepo) {
  const invalid = (err: unknown) => {
    if (err instanceof InvalidInput) return { error: { code: "invalid" as const, detail: err.message } };
    throw err;
  };

  return new Hono()
    .get("/", (c) => c.json(providers.list()))
    .post("/", zValidator("json", providerCreateSchema), (c) => {
      try {
        return c.json(providers.create(c.req.valid("json")), 201);
      } catch (err) {
        return c.json(invalid(err), 400);
      }
    })
    .patch("/:id", zValidator("json", providerUpdateSchema), (c) => {
      try {
        const view = providers.update(c.req.param("id"), c.req.valid("json"));
        return view ? c.json(view, 200) : c.json(notFound, 404);
      } catch (err) {
        return c.json(invalid(err), 400);
      }
    })
    .delete("/:id", (c) => (providers.remove(c.req.param("id")) ? c.body(null, 204) : c.json(notFound, 404)))
    .get("/:id/models", zValidator("query", z.object({ fresh: z.literal("1").optional() })), async (c) => {
      const conn = providers.connection(c.req.param("id"));
      if (!conn) return c.json(notFound, 404);
      try {
        return c.json(withAvailability(conn, await listModels(conn, c.req.valid("query").fresh === "1")), 200);
      } catch (err) {
        const error = describeError(err);
        // A pasted address often lacks the /v1 that OpenAI-style APIs live under: try it once and keep it if it works.
        if (error.code === "model_not_found" && presets[conn.preset].editableUrl && !/\/v\d+\/?$/.test(conn.baseUrl)) {
          const withV1 = `${conn.baseUrl.replace(/\/+$/, "")}/v1`;
          try {
            const models = await listModels({ ...conn, baseUrl: withV1, cacheKey: `${conn.cacheKey}:v1` }, true);
            providers.update(conn.id, { baseUrl: withV1 });
            return c.json(withAvailability(conn, models), 200);
          } catch {
            return c.json({ error: { ...error, detail: `${conn.baseUrl}/models: 404. ${error.detail ?? ""}`.trim() } }, 502);
          }
        }
        return c.json({ error }, 502);
      }
    })
    // Asks the free models a word each; paid ones are never asked.
    .post("/:id/models/check", async (c) => {
      const conn = providers.connection(c.req.param("id"));
      if (!conn) return c.json(notFound, 404);
      try {
        return c.json(await checkFree(conn, await listModels(conn)), 200);
      } catch (err) {
        return c.json({ error: describeError(err) }, 502);
      }
    })
    .get("/:id/media-models", zValidator("query", z.object({ kind: z.enum(["image", "video"]) })), async (c) => {
      const conn = providers.connection(c.req.param("id"));
      if (!conn) return c.json(notFound, 404);
      return c.json(await listMediaModels(conn, c.req.valid("query").kind), 200);
    })
    .get("/:id/media-models/one", zValidator("query", z.object({ kind: z.enum(["image", "video"]), model: z.string().min(1).max(200) })), async (c) => {
      const conn = providers.connection(c.req.param("id"));
      if (!conn) return c.json(notFound, 404);
      const { kind, model } = c.req.valid("query");
      const found = await mediaModel(conn, kind, model);
      return found ? c.json(found, 200) : c.json(notFound, 404);
    })
    .get("/:id/limits", (c) => {
      const conn = providers.connection(c.req.param("id"));
      if (!conn) return c.json(notFound, 404);
      return c.json(isCli(conn.preset) ? limitsOf(conn.preset) : [], 200);
    })
    .get("/:id/balance", async (c) => {
      const conn = providers.connection(c.req.param("id"));
      if (!conn) return c.json(notFound, 404);
      try {
        return c.json({ balance: await fetchBalance(conn.preset, conn.baseUrl, conn.apiKey, conn.fetch) }, 200);
      } catch (err) {
        return c.json({ error: describeError(err) }, 502);
      }
    });
}
