import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentBrowser, findBrowser } from "../src/browser/agent-browser";
import { Browser } from "../src/browser/browser";
import { browserTools, type ToolRun } from "../src/browser/tools";
import { webTools } from "../src/internet/tools";

const PAGES: Record<string, string> = {
  "/": `<title>Поиск</title>
    <form action="/found"><label>Что ищем <input name="q"></label><button>Найти</button></form>
    <select id="s" onchange="document.title='Выбрано: '+this.value"><option value="a">Яблоко</option><option value="b">Кедр</option></select>
    <p style="display:none">скрытый текст</p><a href="/far">Дальше</a>`,
  "/far": `<title>Далеко</title><p>Вторая страница</p>`,
};

// Asked for: a browser like Claude's, with the agent's own tools and full access, the same on the desktop and the server.
describe("the agent's browser tools", () => {
  let driver: AgentBrowser | undefined;
  let site: Server | undefined;
  let profile = "";
  afterEach(async () => {
    await driver?.stop();
    site?.closeAllConnections();
    await new Promise((r) => (site ? site.close(r) : r(null)));
    await new Promise((r) => setTimeout(r, 500));
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it.skipIf(!findBrowser())(
    "reads a page with numbered controls, types and submits a form, clicks, chooses, goes back and waits for the user",
    async () => {
      site = createServer((req, res) => {
        const path = (req.url ?? "/").split("?")[0]!;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(path === "/found" ? `<title>Найдено</title><p>Ищем: ${new URL(req.url!, "http://x").searchParams.get("q")}</p>` : (PAGES[path] ?? ""));
      });
      await new Promise<void>((r) => site!.listen(0, "127.0.0.1", r));
      const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
      profile = mkdtempSync(join(tmpdir(), "drimvox-tools-"));
      driver = new AgentBrowser({ profileDir: profile });
      const browser = new Browser(driver);
      const calls: string[] = [];
      const run: ToolRun = async (_id, name, input, work) => (calls.push(`${name} ${input}`), work());
      const tools = browserTools(browser, { local: true }, run);
      const call = (name: string, input: unknown) => (tools[name]!.execute as (i: unknown, o: unknown) => Promise<string>)(input, { toolCallId: name, messages: [] });

      const page = await call("browser_open", { url });
      expect(page).toContain("Поиск");
      expect(page).toMatch(/\[1 field "Что ищем"\]/);
      expect(page).toMatch(/\[2 button "Найти"\]/);
      expect(page).toMatch(/\[3 select "" value="Яблоко"]/);
      expect(page).toMatch(/\[4 link "Дальше"\]/);
      expect(page).not.toContain("скрытый текст");

      // Typed as a person types (Cyrillic too), then Enter.
      expect(await call("browser_type", { ref: 1, text: "кедровые шишки", submit: true })).toContain("Ищем: кедровые шишки");
      expect(await call("browser_back", {})).toContain("Что ищем");

      expect(await call("browser_choose", { ref: 3, option: "кедр" })).toContain("Выбрано: b");
      expect(await call("browser_click", { ref: 4 })).toContain("Вторая страница");
      // The numbers are of the page read last: a stale one says so instead of clicking something else.
      await expect(call("browser_click", { ref: 9 })).rejects.toThrow(/browser_read/);

      // A check the user passes: the panel shows what to do until the user says it is done.
      const asked = call("browser_ask_user", { reason: "Пройдите проверку" });
      await new Promise((r) => setTimeout(r, 100));
      expect(browser.state().waiting).toBe("Пройдите проверку");
      browser.done();
      expect(await asked).toContain("The user says it is done");
      expect(browser.state().waiting).toBeNull();

      // Tabs: one more, shown, then closed.
      expect(await call("browser_open", { url, new_tab: true })).toMatch(/Tabs: 1 "Далеко", 2 "Поиск" \(shown\)/);
      expect(await call("browser_tab", { tab: 2, action: "close" })).toContain("Вторая страница");
      expect(calls[0]).toBe(`browser_open ${url}`);
    },
    60_000,
  );

  it("keeps a chat to the public internet; a project's agent may open its own app on this computer", async () => {
    const driver = { available: () => true, state: () => ({ running: false, url: "", title: "", tabs: [], active: null }), onState: () => () => {} } as unknown as AgentBrowser;
    const run: ToolRun = (_id, _name, _input, work) => work();
    const chat = browserTools(new Browser(driver), { local: false }, run);
    await expect((chat.browser_open!.execute as (i: unknown, o: unknown) => Promise<string>)({ url: "http://127.0.0.1:5173/" }, { toolCallId: "1" })).rejects.toThrow(/public/);
    await expect((chat.browser_open!.execute as (i: unknown, o: unknown) => Promise<string>)({ url: "file:///C:/Windows/win.ini" }, { toolCallId: "1" })).rejects.toThrow(/http/);
  });

  it("replaces reading in a hidden window and a window for the user where there is a browser", () => {
    const fake = (available: boolean) => ({ available: () => available, state: () => ({ running: false, url: "", title: "", tabs: [], active: null }), onState: () => () => {} }) as unknown as AgentBrowser;
    const page = async () => ({ url: "", title: "", text: "" });
    const web = { search: async () => [], open: page, render: page, show: page };
    expect(Object.keys(webTools({ ...web, browser: new Browser(fake(true)) }))).toEqual(expect.arrayContaining(["web_search", "open_page", "browser_open", "browser_ask_user"]));
    expect(Object.keys(webTools({ ...web, browser: new Browser(fake(true)) }))).not.toContain("browse_page");
    // A server without Chrome: the old way stays.
    expect(Object.keys(webTools({ ...web, browser: new Browser(fake(false)) }))).toEqual(["web_search", "open_page", "open_for_user", "browse_page"]);
  });
});
