import { zValidator } from "@hono/zod-validator";
import { providerCreateSchema, providerUpdateSchema } from "@artel/shared";
import { Hono } from "hono";
import { fetchBalance } from "../providers/balance";
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
    .get("/:id/models", async (c) => {
      const conn = providers.connection(c.req.param("id"));
      if (!conn) return c.json(notFound, 404);
      try {
        return c.json(await listModels(conn, c.req.query("fresh") === "1"), 200);
      } catch (err) {
        return c.json({ error: describeError(err) }, 502);
      }
    })
    .get("/:id/balance", async (c) => {
      const conn = providers.connection(c.req.param("id"));
      if (!conn) return c.json(notFound, 404);
      try {
        return c.json({ balance: await fetchBalance(conn.preset, conn.baseUrl, conn.apiKey) }, 200);
      } catch (err) {
        return c.json({ error: describeError(err) }, 502);
      }
    });
}
