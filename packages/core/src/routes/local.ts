import { zValidator } from "@hono/zod-validator";
import { hfMediaSearchSchema, hfRepoName, localImageModelId, localImagePullSchema, localModelName, localPullSchema } from "@artel/shared";
import { Hono } from "hono";
import { z } from "zod";
import { CatalogError } from "../local/catalog";
import { EngineError } from "../local/images/server";
import { HubError } from "../local/images/found";
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
    // Paused, a download stays listed; pulling it again goes on where it stopped.
    .post("/pulls/pause", zValidator("json", localPullSchema), (c) =>
      local.pause(c.req.valid("json").model) ? c.json({ ok: true as const }, 200) : c.json({ error: { code: "not_found" as const } }, 404),
    )
    .delete("/pulls", zValidator("query", z.object({ model: localModelName })), (c) =>
      local.cancel(c.req.valid("query").model) ? c.json({ ok: true }, 200) : c.json({ error: { code: "not_found" } }, 404),
    )
    .delete("/models", zValidator("query", z.object({ name: localModelName })), async (c) =>
      (await local.remove(c.req.valid("query").name)) ? c.json({ ok: true }, 200) : c.json({ error: { code: "not_found" } }, 404),
    )
    // Pictures on this computer (docs/specs/local-images.md): the short list, downloads of the engine and the models.
    .get("/images", async (c) => c.json(await local.images.status()))
    .post("/images/pulls", zValidator("json", localImagePullSchema), async (c) => {
      try {
        return c.json(await local.images.pull(c.req.valid("json").model), 202);
      } catch (err) {
        if (err instanceof EngineError) return c.json({ error: { code: "unsupported" as const, detail: err.message } }, 409);
        throw err;
      }
    })
    .post("/images/engine", (c) => {
      try {
        return c.json(local.images.installEngine(), 202);
      } catch (err) {
        if (err instanceof EngineError) return c.json({ error: { code: "unsupported" as const, detail: err.message } }, 409);
        throw err;
      }
    })
    .post("/images/pulls/pause", zValidator("json", localImagePullSchema), (c) =>
      local.images.pause(c.req.valid("json").model) ? c.json({ ok: true as const }, 200) : c.json({ error: { code: "not_found" as const } }, 404),
    )
    .delete("/images/pulls", zValidator("query", localImagePullSchema), (c) =>
      local.images.cancel(c.req.valid("query").model) ? c.json({ ok: true as const }, 200) : c.json({ error: { code: "not_found" as const } }, 404),
    )
    // Models that make pictures or clips on Hugging Face, and a repository's files with the fit of each.
    .get("/images/search", zValidator("query", hfMediaSearchSchema), async (c) => {
      const { kind, q } = c.req.valid("query");
      try {
        return c.json(await local.images.search(kind, q), 200);
      } catch (err) {
        if (err instanceof HubError) return c.json(unreachable(err), 502);
        throw err;
      }
    })
    .get("/images/hf", zValidator("query", z.object({ repo: hfRepoName })), async (c) => {
      try {
        return c.json(await local.images.files(c.req.valid("query").repo), 200);
      } catch (err) {
        if (err instanceof HubError) return c.json(unreachable(err), 502);
        throw err;
      }
    })
    .delete("/images/models/:id", zValidator("param", z.object({ id: localImageModelId })), async (c) => {
      await local.images.remove(c.req.valid("param").id);
      return c.json({ ok: true as const }, 200);
    });
}
