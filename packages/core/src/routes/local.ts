import { zValidator } from "@hono/zod-validator";
import { hfRepoName, localModelName, localPullSchema } from "@artel/shared";
import { Hono } from "hono";
import { z } from "zod";
import { CatalogError } from "../local/catalog";
import type { LocalModels } from "../local/service";

const unreachable = (err: unknown) => ({ error: { code: "hf_unreachable", detail: err instanceof Error ? err.message : String(err) } });

/** Ollama on this computer: its state, the catalog sized for the computer, downloads. */
export function localRoutes(local: LocalModels) {
  return new Hono()
    .get("/", async (c) => c.json(await local.status()))
    .post("/connect", (c) => c.json({ providerId: local.connect() }, 200))
    // Ollama from Artel: the size first, then the download and the official setup (Windows).
    .get("/install", async (c) => c.json({ size: await local.installer.size(), ...local.installer.state() }, 200))
    .post("/install", async (c) => {
      if (!(await local.status()).canInstall) return c.json({ error: { code: "unsupported" as const } }, 409);
      local.installer.start();
      return c.json(local.installer.state(), 202);
    })
    .get("/picks", async (c) => c.json(await local.picks()))
    .get("/search", zValidator("query", z.object({ q: z.string().trim().min(1).max(200) })), async (c) => {
      try {
        return c.json(await local.search(c.req.valid("query").q), 200);
      } catch (err) {
        if (err instanceof CatalogError) return c.json(unreachable(err), 502);
        throw err;
      }
    })
    .get("/hf", zValidator("query", z.object({ repo: hfRepoName })), async (c) => {
      try {
        return c.json(await local.variants(c.req.valid("query").repo), 200);
      } catch (err) {
        if (err instanceof CatalogError) return c.json(unreachable(err), 502);
        throw err;
      }
    })
    .post("/pulls", zValidator("json", localPullSchema), async (c) => c.json(await local.pull(c.req.valid("json").model), 202))
    .delete("/pulls", zValidator("query", z.object({ model: localModelName })), (c) =>
      local.cancel(c.req.valid("query").model) ? c.json({ ok: true }, 200) : c.json({ error: { code: "not_found" } }, 404),
    )
    .delete("/models", zValidator("query", z.object({ name: localModelName })), async (c) =>
      (await local.remove(c.req.valid("query").name)) ? c.json({ ok: true }, 200) : c.json({ error: { code: "not_found" } }, 404),
    );
}
