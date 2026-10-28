import { zValidator } from "@hono/zod-validator";
import { browserInputSchema, browserOpenSchema, browserSizeSchema, browserTabSchema } from "@drimvox/shared";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AgentBrowser, BrowserFrame, BrowserState } from "../browser/agent-browser";

/**
 * The agent's browser in Drimvox's panel (asked for: like Claude's browser, not a window of its own): its state, its
 * current tab as pictures while the panel is open, and the user's clicks, keys and addresses into it.
 */
export function browserRoutes(browser: AgentBrowser) {
  return new Hono()
    .get("/", (c) => c.json(browser.state(), 200))
    .get("/stream", (c) =>
      streamSSE(c, async (stream) => {
        let closed = false;
        // Pictures come faster than a slow window takes them: only the newest one waits to go.
        let waiting: BrowserFrame | null = null;
        let sending = false;
        const flush = async () => {
          if (sending) return;
          sending = true;
          while (waiting && !closed) {
            const frame = waiting;
            waiting = null;
            await stream.writeSSE({ event: "frame", data: JSON.stringify(frame) }).catch(() => (closed = true));
          }
          sending = false;
        };
        const stop = browser.watch({
          frame: (f) => {
            waiting = f;
            void flush();
          },
          state: (s: BrowserState) => void stream.writeSSE({ event: "state", data: JSON.stringify(s) }).catch(() => (closed = true)),
        });
        await new Promise<void>((resolve) => stream.onAbort(resolve));
        closed = true;
        stop();
      }),
    )
    .post("/open", zValidator("json", browserOpenSchema), async (c) => {
      const { url } = c.req.valid("json");
      try {
        await browser.open(url ?? "about:blank");
      } catch (err) {
        return c.json({ error: { code: "no_browser" as const, detail: err instanceof Error ? err.message : String(err) } }, 409);
      }
      return c.json(browser.state(), 200);
    })
    .post("/input", zValidator("json", browserInputSchema), async (c) => {
      await browser.input(c.req.valid("json")).catch(() => {});
      return c.body(null, 204);
    })
    .post("/tab", zValidator("json", browserTabSchema), async (c) => {
      await browser.select(c.req.valid("json").id).catch(() => {});
      return c.json(browser.state(), 200);
    })
    .post("/tab/close", zValidator("json", browserTabSchema), async (c) => {
      await browser.close(c.req.valid("json").id).catch(() => {});
      return c.body(null, 204);
    })
    .post("/tab/new", zValidator("json", browserOpenSchema), async (c) => {
      const { url } = c.req.valid("json");
      try {
        await browser.newTab(url ?? "about:blank");
      } catch (err) {
        return c.json({ error: { code: "no_browser" as const, detail: err instanceof Error ? err.message : String(err) } }, 409);
      }
      return c.json(browser.state(), 200);
    })
    .post("/size", zValidator("json", browserSizeSchema), async (c) => {
      const { width, height, scale } = c.req.valid("json");
      await browser.resize(width, height, scale).catch(() => {});
      return c.body(null, 204);
    })
    .post("/back", async (c) => {
      await browser.back().catch(() => {});
      return c.body(null, 204);
    })
    .post("/reload", async (c) => {
      await browser.reload().catch(() => {});
      return c.body(null, 204);
    });
}
