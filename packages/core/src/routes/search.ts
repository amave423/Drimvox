import { zValidator } from "@hono/zod-validator";
import { searchCheckSchema, searchSetSchema } from "@drimvox/shared";
import { Hono } from "hono";
import { checkSearch, type SearchStore, type SearchUrls } from "../internet/search-service";

/** The web search service: set the key, remove it, check it. The key never comes back. */
export function searchRoutes(store: SearchStore, urls: SearchUrls) {
  return new Hono()
    .get("/", (c) => c.json(store.view()))
    .put("/", zValidator("json", searchSetSchema), (c) => {
      store.set(c.req.valid("json"));
      return c.json(store.view(), 200);
    })
    .delete("/", (c) => {
      store.set(null);
      return c.json(store.view(), 200);
    })
    .post("/check", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const parsed = searchCheckSchema.safeParse(body ?? {});
      return c.json(await checkSearch(store, urls, parsed.success ? parsed.data.query : undefined), 200);
    });
}
