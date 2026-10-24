import { zValidator } from "@hono/zod-validator";
import { authLoginSchema, authPasswordSchema, authSetupSchema, type AuthState } from "@drimvox/shared";
import { timingSafeEqual } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { SESSION_DAYS, type AuthStore } from "./store";

export const SESSION_COOKIE = "drimvox_session";
const MAX_FAILURES = 5;
const LOCK_MS = 60_000;

/**
 * Who is signing in. Behind `tailscale serve` every request comes from 127.0.0.1, and the proxy appends the real
 * address to X-Forwarded-For; the entries before it are whatever the client sent, so only the last one counts.
 */
function clientOf(c: Context): string {
  const forwarded = c.req.header("X-Forwarded-For")?.split(",").at(-1)?.trim();
  const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
  return forwarded || socket || "local";
}

/**
 * Behind `tailscale serve` the browser speaks HTTPS even though the core hears plain HTTP. The server listens on
 * 127.0.0.1 only, so a request under any other name came through that HTTPS proxy.
 */
function overHttps(c: Context): boolean {
  const url = new URL(c.req.url);
  return c.req.header("X-Forwarded-Proto") === "https" || url.protocol === "https:" || !LOOPBACK.has(url.hostname);
}
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function startSession(c: Context, store: AuthStore): void {
  setCookie(c, SESSION_COOKIE, store.openSession(), {
    httpOnly: true,
    sameSite: "Strict",
    secure: overHttps(c),
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

function sameCode(given: string, expected: string): boolean {
  const a = Buffer.from(given.trim());
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Setting the first password, signing in and out, changing the password; open without a session.
 * `setupCode` is null on the desktop, where the window's token signs in and there is no password.
 */
export function authRoutes(store: AuthStore, setupCode: string | null) {
  /** Wrong passwords and codes per address; five in a row lock that address out for a minute. */
  const failures = new Map<string, { count: number; until: number }>();
  const locked = (c: Context) => {
    const entry = failures.get(clientOf(c));
    return !!entry && entry.count >= MAX_FAILURES && entry.until > Date.now();
  };
  const failed = (c: Context) => {
    const key = clientOf(c);
    const entry = failures.get(key);
    const count = entry && entry.until > Date.now() ? entry.count + 1 : 1;
    failures.set(key, { count, until: Date.now() + LOCK_MS });
  };

  const desktop = setupCode === null;
  return new Hono()
    .get("/state", (c) =>
      c.json(
        (desktop
          ? { mode: "token", passwordSet: false, signedIn: true }
          : { mode: "password", passwordSet: store.passwordSet(), signedIn: store.validSession(getCookie(c, SESSION_COOKIE)) }) satisfies AuthState,
      ),
    )
    .use("/*", async (c, next) => (desktop ? c.json({ error: "not_found" }, 404) : next()))
    .post("/setup", zValidator("json", authSetupSchema), async (c) => {
      if (store.passwordSet()) return c.json({ error: "already_set" }, 409);
      if (locked(c)) return c.json({ error: "wait" }, 429);
      const { password, code } = c.req.valid("json");
      if (!sameCode(code, setupCode!)) {
        failed(c);
        return c.json({ error: "bad_code" }, 403);
      }
      await store.setPassword(password);
      startSession(c, store);
      return c.json({ ok: true as const }, 200);
    })
    .post("/login", zValidator("json", authLoginSchema), async (c) => {
      if (locked(c)) return c.json({ error: "wait" }, 429);
      if (!(await store.checkPassword(c.req.valid("json").password))) {
        failed(c);
        return c.json({ error: "bad_password" }, 401);
      }
      failures.delete(clientOf(c));
      startSession(c, store);
      return c.json({ ok: true as const }, 200);
    })
    .post("/logout", (c) => {
      store.closeSession(getCookie(c, SESSION_COOKIE));
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
      return c.json({ ok: true as const }, 200);
    })
    .post("/password", zValidator("json", authPasswordSchema), async (c) => {
      const session = getCookie(c, SESSION_COOKIE);
      if (!store.validSession(session)) return c.json({ error: "unauthorized" }, 401);
      const { current, next } = c.req.valid("json");
      if (!(await store.checkPassword(current))) return c.json({ error: "bad_password" }, 403);
      await store.setPassword(next);
      store.closeOtherSessions(session!);
      return c.json({ ok: true as const }, 200);
    });
}

/**
 * Server mode: the API needs a session cookie, except the health check and signing in. A browser that sends
 * a change from another site (its Origin is not one of ours) is refused, on top of the SameSite cookie.
 */
export function sessionGuard(store: AuthStore, hosts: ReadonlySet<string>): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header("Origin");
    if (origin && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      let host = "";
      try {
        host = new URL(origin).hostname;
      } catch {
        // An Origin that is not a URL is not ours.
      }
      if (!hosts.has(host)) return c.json({ error: "foreign_origin" }, 403);
    }
    if (c.req.path === "/api/health" || c.req.path.startsWith("/api/auth/")) return next();
    if (!store.validSession(getCookie(c, SESSION_COOKIE))) return c.json({ error: "unauthorized" }, 401);
    await next();
  };
}
