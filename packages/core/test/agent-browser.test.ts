import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentBrowser, findBrowser, playwrightArgs, type BrowserFrame, type BrowserState } from "../src/browser/agent-browser";

// Asked for: the agent's browser in a panel of Drimvox, like Claude's, where the user can click a check away.
describe("the agent's browser", () => {
  it("points the Playwright server at it, its own browser options taken out", () => {
    expect(playwrightArgs(["-y", "@playwright/mcp@latest", "--headless", "--browser", "msedge", "--isolated"], "http://127.0.0.1:9333")).toEqual([
      "-y",
      "@playwright/mcp@latest",
      "--cdp-endpoint",
      "http://127.0.0.1:9333",
    ]);
    expect(playwrightArgs(["@playwright/mcp", "--output-dir", "x"], "http://h", "C:/data/out")).toEqual(["@playwright/mcp", "--cdp-endpoint", "http://h", "--output-dir", "C:/data/out"]);
  });

  let browser: AgentBrowser | undefined;
  let site: Server | undefined;
  let profile = "";
  afterEach(async () => {
    await browser?.stop();
    site?.closeAllConnections();
    await new Promise((r) => (site ? site.close(r) : r(null)));
    await new Promise((r) => setTimeout(r, 500));
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  // A real Chrome or Edge: skipped on a computer without one.
  it.skipIf(!findBrowser())(
    "shows its tab as pictures, takes clicks and typing, and says where it is",
    async () => {
      site = createServer((_, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<title>Проверка</title><body style="margin:0"><button id="b" style="position:absolute;left:0;top:0;width:300px;height:200px" onclick="document.title='Нажато'">Я не робот</button><input id="i" style="position:absolute;left:0;top:300px" oninput="document.title='Введено: '+this.value"></body>`,
        );
      });
      await new Promise<void>((r) => site!.listen(0, "127.0.0.1", r));
      const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
      profile = mkdtempSync(join(tmpdir(), "drimvox-browser-"));
      browser = new AgentBrowser({ profileDir: profile });

      const frames: BrowserFrame[] = [];
      const states: BrowserState[] = [];
      const stop = browser.watch({ frame: (f) => frames.push(f), state: (s) => states.push(s) });
      await browser.open(url);
      const until = async (check: () => boolean) => {
        for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 100));
        expect(check(), JSON.stringify({ state: browser!.state(), frames: frames.length })).toBe(true);
      };
      await until(() => browser!.state().title === "Проверка" && frames.length > 0);
      expect(frames.at(-1)!.width).toBeGreaterThan(600);
      expect(Buffer.from(frames.at(-1)!.data, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");

      await browser.input({ type: "mouse", action: "down", x: 100, y: 100 });
      await browser.input({ type: "mouse", action: "up", x: 100, y: 100 });
      await until(() => browser!.state().title === "Нажато");

      await browser.input({ type: "mouse", action: "down", x: 20, y: 310 });
      await browser.input({ type: "mouse", action: "up", x: 20, y: 310 });
      await browser.input({ type: "text", text: "кедр" });
      await until(() => browser!.state().title === "Введено: кедр");
      expect(states.at(-1)).toMatchObject({ running: true, url });
      stop();
    },
    40_000,
  );

  // Asked for: the agent may open several tabs; the panel shows them all and switches between them.
  it.skipIf(!findBrowser())(
    "lists its tabs, switches the panel between them, opens and closes one",
    async () => {
      site = createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<title>${req.url === "/b" ? "Вторая" : "Первая"}</title><h1>${req.url}</h1>`);
      });
      await new Promise<void>((r) => site!.listen(0, "127.0.0.1", r));
      const base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
      profile = mkdtempSync(join(tmpdir(), "drimvox-browser-"));
      browser = new AgentBrowser({ profileDir: profile });
      const stop = browser.watch({ frame: () => {}, state: () => {} });
      const until = async (check: () => boolean, what: string) => {
        for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 100));
        expect(check(), `${what}: ${JSON.stringify(browser!.state())}`).toBe(true);
      };
      await browser.open(`${base}/a`);
      await until(() => browser!.state().title === "Первая", "first");
      await browser.newTab(`${base}/b`);
      await until(() => browser!.state().tabs.length === 2 && browser!.state().title === "Вторая", "second");
      const [first, second] = browser.state().tabs;
      expect(browser.state().active).toBe(second!.id);

      await browser.select(first!.id);
      await until(() => browser!.state().active === first!.id && browser!.state().title === "Первая", "back to the first");

      await browser.close(second!.id);
      await until(() => browser!.state().tabs.length === 1, "closed");
      expect(browser.state().tabs.map((t) => t.title)).toEqual(["Первая"]);
      stop();
    },
    40_000,
  );
});
