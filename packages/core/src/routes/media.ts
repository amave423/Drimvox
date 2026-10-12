import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import type { MediaRepo } from "../media/repo";

const notFound = { error: { code: "not_found" } } as const;

/** The gallery: every picture and clip, newest first, and their files. */
export function mediaRoutes(media: MediaRepo) {
  return new Hono()
    .get("/", (c) => c.json(media.list()))
    .get("/:id/content", async (c) => {
      const file = media.file(c.req.param("id"));
      if (!file) return c.json(notFound, 404);
      try {
        const bytes = await readFile(file.path);
        return c.body(bytes, 200, { "Content-Type": file.mime, "Cache-Control": "private, max-age=31536000, immutable" });
      } catch {
        return c.json(notFound, 404);
      }
    })
    .delete("/:id", (c) => (media.remove(c.req.param("id")) ? c.body(null, 204) : c.json(notFound, 404)));
}
