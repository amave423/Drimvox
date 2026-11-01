import { zValidator } from "@hono/zod-validator";
import { sshServerSchema } from "@drimvox/shared";
import { Hono } from "hono";
import { SshInputError, type SshServers } from "../tools/ssh";

const notFound = { error: { code: "not_found" } } as const;

/** Saved SSH servers (docs/specs/ssh.md): the password goes in and never comes back; a check connects and says so. */
export function sshRoutes(servers: SshServers) {
  return new Hono()
    .get("/", (c) => c.json(servers.list(), 200))
    .post("/", zValidator("json", sshServerSchema), (c) => {
      try {
        return c.json(servers.save(c.req.valid("json")), 201);
      } catch (err) {
        if (err instanceof SshInputError) return c.json({ error: { code: err.code } }, 400);
        throw err;
      }
    })
    .put("/:id", zValidator("json", sshServerSchema), (c) => {
      if (!servers.list().some((s) => s.id === c.req.param("id"))) return c.json(notFound, 404);
      try {
        return c.json(servers.save(c.req.valid("json"), c.req.param("id")), 200);
      } catch (err) {
        if (err instanceof SshInputError) return c.json({ error: { code: err.code } }, 400);
        throw err;
      }
    })
    .delete("/:id", (c) => (servers.remove(c.req.param("id")) ? c.body(null, 204) : c.json(notFound, 404)))
    .post("/:id/check", async (c) => {
      const s = servers.find(c.req.param("id"));
      if (!s) return c.json(notFound, 404);
      try {
        const r = await servers.exec(s, "uname -sn 2>/dev/null || hostname", 20_000);
        return c.json({ ok: true as const, output: r.output.trim().slice(0, 200), fingerprint: servers.find(s.id)?.fingerprint ?? null }, 200);
      } catch (err) {
        return c.json({ ok: false as const, error: err instanceof Error ? err.message : String(err) }, 200);
      }
    });
}
