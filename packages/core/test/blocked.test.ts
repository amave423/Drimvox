import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlockedSites, connectionFailed, KNOWN_BLOCKED, withBlockedProxy } from "../src/internet/blocked";
import type { WebAccess } from "../src/internet/web";
import { createTestEnv, type TestEnv } from "./env";

let env: TestEnv;
beforeEach(() => {
  env = createTestEnv();
});
afterEach(() => env.close());

const page = (url: string, via: string) => ({ url, title: via, text: via });

// Asked for: the proxy only for sites closed from Russia, not for all — some Russian sites refuse visitors through one.
describe("sites through the proxy", () => {
  it("starts with the sites known to be closed, matches their subdomains, and keeps an edited list", () => {
    const sites = new BlockedSites(env.db);
    expect(sites.list()).toEqual(KNOWN_BLOCKED);
    expect(sites.has("m.facebook.com")).toBe(true);
    expect(sites.has("notfacebook.com")).toBe(false);
    expect(sites.set(["https://www.Example.org/page", "ya.ru", "nonsense", "ya.ru"])).toEqual(["example.org", "ya.ru"]);
    expect(new BlockedSites(env.db).list()).toEqual(["example.org", "ya.ru"]);
  });

  it("opens a listed site through the proxy, others directly, and remembers a site that opened only through it", async () => {
    const sites = new BlockedSites(env.db);
    sites.set(["instagram.com"]);
    const direct: string[] = [];
    const base: WebAccess = {
      search: async () => [],
      open: async (url) => {
        direct.push(url);
        if (url.includes("closed.example")) throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
        if (url.includes("gone.example")) throw new Error("The page answered 404");
        return page(url, "direct");
      },
    };
    const web = withBlockedProxy(base, { proxy: () => "http://proxy:8080", sites, openVia: async (url) => page(url, "proxy") });

    expect((await web.open("https://www.instagram.com/x")).title).toBe("proxy");
    expect((await web.open("https://ya.ru/")).title).toBe("direct");
    expect((await web.open("https://closed.example/a")).title).toBe("proxy");
    expect(sites.has("closed.example")).toBe(true);
    // An answer of the site itself is not a block.
    await expect(web.open("https://gone.example/")).rejects.toThrow(/404/);
    expect(sites.has("gone.example")).toBe(false);
    expect(direct).toEqual(["https://ya.ru/", "https://closed.example/a", "https://gone.example/"]);
  });

  it("goes directly when no proxy is set", async () => {
    const sites = new BlockedSites(env.db);
    const base: WebAccess = { search: async () => [], open: async (url) => page(url, "direct") };
    const web = withBlockedProxy(base, { proxy: () => null, sites, openVia: async (url) => page(url, "proxy") });
    expect((await web.open("https://instagram.com/")).title).toBe("direct");
  });

  it("tells a broken connection from a site's own answer", () => {
    expect(connectionFailed(new TypeError("fetch failed"))).toBe(true);
    expect(connectionFailed(Object.assign(new Error("timed out"), { name: "TimeoutError" }))).toBe(true);
    expect(connectionFailed(new Error("The page answered 404"))).toBe(false);
  });

  it("is listed and changed through the API", async () => {
    expect((await (await env.call("GET", "/api/proxy/sites")).json()).hosts).toEqual(KNOWN_BLOCKED);
    const res = await env.call("PUT", "/api/proxy/sites", { hosts: ["chatgpt.com", "x.com"] });
    expect((await res.json()).hosts).toEqual(["chatgpt.com", "x.com"]);
  });
});
