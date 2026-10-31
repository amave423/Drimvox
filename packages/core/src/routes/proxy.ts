import { zValidator } from "@hono/zod-validator";
import { proxySetSchema, proxySitesSchema } from "@drimvox/shared";
import { Hono } from "hono";
import type { BlockedSites } from "../internet/blocked";
import { checkProxy, type ProxyStore } from "../proxy";

/** The proxy for providers: set, remove, check. The password never comes back. */
export function proxyRoutes(proxies: ProxyStore, checkUrl: string, sites: BlockedSites, changed: () => void = () => {}) {
  return new Hono()
    .get("/", (c) => c.json(proxies.view()))
    .put("/", zValidator("json", proxySetSchema), (c) => {
      proxies.set(c.req.valid("json").url);
      changed();
      return c.json(proxies.view(), 200);
    })
    .delete("/", (c) => {
      proxies.set(null);
      changed();
      return c.json(proxies.view(), 200);
    })
    // The sites that go through the proxy; the rest go directly (asked for: some Russian sites refuse a proxy).
    .get("/sites", (c) => c.json({ hosts: sites.list() }, 200))
    .put("/sites", zValidator("json", proxySitesSchema), (c) => c.json({ hosts: sites.set(c.req.valid("json").hosts) }, 200))
    .post("/check", async (c) => {
      const url = proxies.url();
      if (!url) return c.json({ ok: false, error: { code: "no_proxy" } }, 200);
      return c.json(await checkProxy(url, checkUrl), 200);
    });
}
