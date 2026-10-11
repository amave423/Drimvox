import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/** Blocks DNS rebinding: a foreign site resolving its name to 127.0.0.1 must not reach the API. */
export function hostGuard(allowed: ReadonlySet<string>): MiddlewareHandler {
  return async (c, next) => {
    const host = new URL(c.req.url).hostname;
    if (!allowed.has(host)) return c.text("Forbidden host", 403);
    await next();
  };
}

export function tokenGuard(token: string, open: ReadonlySet<string>): MiddlewareHandler {
  const expected = Buffer.from(`Bearer ${token}`);
  return async (c, next) => {
    if (open.has(c.req.path)) return next();
    const given = Buffer.from(c.req.header("Authorization") ?? "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}
