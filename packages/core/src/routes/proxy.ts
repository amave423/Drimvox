import { zValidator } from "@hono/zod-validator";
import { proxySetSchema } from "@artel/shared";
import { Hono } from "hono";
import { checkProxy, type ProxyStore } from "../proxy";

/** The proxy for providers: set, remove, check. The password never comes back. */
export function proxyRoutes(proxies: ProxyStore, checkUrl: string) {
  return new Hono()
    .get("/", (c) => c.json(proxies.view()))
    .put("/", zValidator("json", proxySetSchema), (c) => {
      proxies.set(c.req.valid("json").url);
      return c.json(proxies.view(), 200);
    })
    .delete("/", (c) => {
      proxies.set(null);
      return c.json(proxies.view(), 200);
    })
    .post("/check", async (c) => {
      const url = proxies.url();
      if (!url) return c.json({ ok: false, error: { code: "no_proxy" } }, 200);
      return c.json(await checkProxy(url, checkUrl), 200);
    });
}
