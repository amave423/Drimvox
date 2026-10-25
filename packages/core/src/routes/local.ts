import { zValidator } from "@hono/zod-validator";
import { localAudioPullSchema, localAudioSearchSchema, localVoicePullSchema, hfMediaSearchSchema, hfRepoName, localImageModelId, localImagePullSchema, localModelName, localPullSchema } from "@drimvox/shared";
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
    // Ollama from Drimvox: the size first, then the download and the official setup (Windows).
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
    // Speech on this computer (docs/specs/local-audio.md): the speech models, the engine with the first one.
    .get("/audio", (c) => c.json(local.audio.status()))
    .post("/audio/pulls", zValidator("json", localAudioPullSchema), async (c) => {
      try {
        return c.json(await local.audio.pull(c.req.valid("json").model), 202);
      } catch (err) {
        return c.json({ error: { code: "unsupported", detail: err instanceof Error ? err.message : String(err) } }, 409);
      }
    })
    .post("/audio/pulls/pause", zValidator("json", localAudioPullSchema), (c) => (local.audio.pause(c.req.valid("json").model) ? c.json({ ok: true as const }, 200) : c.json({ error: { code: "not_found" } }, 404)))
    .delete("/audio/pulls", zValidator("query", localAudioPullSchema), (c) => (local.audio.cancel(c.req.valid("query").model) ? c.body(null, 204) : c.json({ error: { code: "not_found" } }, 404)))
    // By query: a found model's id has the repository's slash in it.
    .delete("/audio/models", zValidator("query", localAudioPullSchema), (c) =>
      local.audio.remove(c.req.valid("query").model) ? c.body(null, 204) : c.json({ error: { code: "not_found" } }, 404),
    )
    .get("/audio/search", zValidator("query", localAudioSearchSchema), async (c) => {
      try {
        return c.json(await local.audio.search(c.req.valid("query").q), 200);
      } catch (err) {
        if (err instanceof HubError) return c.json(unreachable(err), 502);
        throw err;
      }
    })
    .get("/audio/hf", zValidator("query", z.object({ repo: hfRepoName })), async (c) => {
      try {
        return c.json(await local.audio.files(c.req.valid("query").repo), 200);
      } catch (err) {
        if (err instanceof HubError) return c.json(unreachable(err), 502);
        throw err;
      }
    })
    // Reading aloud (docs/specs/local-speech.md): Piper's voices, the engine with the first one.
    .get("/speech", (c) => c.json(local.speech.status()))
    .post("/speech/pulls", zValidator("json", localVoicePullSchema), (c) => {
      try {
        return c.json(local.speech.pull(c.req.valid("json").voice), 202);
      } catch (err) {
        return c.json({ error: { code: "unsupported", detail: err instanceof Error ? err.message : String(err) } }, 409);
      }
    })
    .post("/speech/pulls/pause", zValidator("json", localVoicePullSchema), (c) => (local.speech.pause(c.req.valid("json").voice) ? c.json({ ok: true as const }, 200) : c.json({ error: { code: "not_found" } }, 404)))
    .delete("/speech/pulls", zValidator("query", localVoicePullSchema), (c) => (local.speech.cancel(c.req.valid("query").voice) ? c.body(null, 204) : c.json({ error: { code: "not_found" } }, 404)))
    .delete("/speech/voices", zValidator("query", localVoicePullSchema), (c) => (local.speech.remove(c.req.valid("query").voice) ? c.body(null, 204) : c.json({ error: { code: "not_found" } }, 404)))
    .delete("/speech/engine", (c) => (local.speech.removeEngine() ? c.body(null, 204) : c.json({ error: { code: "busy" } }, 409)))
    .delete("/audio/engine", (c) => (local.audio.removeEngine() ? c.body(null, 204) : c.json({ error: { code: "busy" } }, 409)))
    .get("/images", async (c) => c.json(await local.images.status()))
    .delete("/images/engine", (c) => (local.images.removeEngine() ? c.body(null, 204) : c.json({ error: { code: "busy" } }, 409)))
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
