import { zValidator } from "@hono/zod-validator";
import { cliProxyUpdateSchema, subscriptionCallbackSchema, subscriptionLoginSchema } from "@drimvox/shared";
import { Hono } from "hono";
import type { CliProxy } from "../local/cliproxy/service";

const failed = (err: unknown) => ({ error: { code: "failed" as const, detail: err instanceof Error ? err.message : String(err) } });

/**
 * Free access through one's own subscriptions (docs/specs/subscriptions.md): CLIProxyAPI's download, switches,
 * accounts and their limits.
 */
export function subscriptionRoutes(proxy: CliProxy) {
  return new Hono()
    .get("/", async (c) => c.json(await proxy.status(), 200))
    .post("/install", async (c) => {
      proxy.install();
      return c.json(await proxy.status(), 202);
    })
    .delete("/", async (c) => {
      await proxy.remove();
      return c.json(await proxy.status(), 200);
    })
    .patch("/", zValidator("json", cliProxyUpdateSchema), async (c) => {
      const { stopOnQuit, running } = c.req.valid("json");
      try {
        if (stopOnQuit !== undefined) await proxy.setStopOnQuit(stopOnQuit);
        if (running === true) await proxy.start();
        if (running === false) await proxy.stop();
      } catch (err) {
        return c.json(failed(err), 409);
      }
      return c.json(await proxy.status(), 200);
    })
    .get("/accounts", async (c) => {
      try {
        return c.json(await proxy.accounts(), 200);
      } catch (err) {
        return c.json(failed(err), 409);
      }
    })
    .delete("/accounts/:name", async (c) => {
      try {
        await proxy.removeAccount(c.req.param("name"));
        return c.body(null, 204);
      } catch (err) {
        return c.json(failed(err), 409);
      }
    })
    .post("/login", zValidator("json", subscriptionLoginSchema), async (c) => {
      try {
        return c.json(await proxy.login(c.req.valid("json").kind), 200);
      } catch (err) {
        return c.json(failed(err), 409);
      }
    })
    .get("/login/:state", async (c) => {
      try {
        return c.json(await proxy.loginStatus(c.req.param("state")), 200);
      } catch (err) {
        return c.json(failed(err), 409);
      }
    })
    .post("/login/callback", zValidator("json", subscriptionCallbackSchema), async (c) => {
      const { kind, state, redirectUrl } = c.req.valid("json");
      try {
        await proxy.loginCallback(kind, state, redirectUrl);
        return c.body(null, 204);
      } catch (err) {
        return c.json(failed(err), 409);
      }
    })
    .get("/limits", async (c) => {
      try {
        return c.json(await proxy.limits(), 200);
      } catch (err) {
        return c.json(failed(err), 409);
      }
    });
}
