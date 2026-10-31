import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Favicons, iconInPage, pictureType } from "../src/internet/favicons";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "drimvox-icons-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Asked for: every link's site mark, not only the few drawn into the app.
describe("site icons", () => {
  it("tells a picture from an error page and finds the icon a page names", () => {
    expect(pictureType(PNG)).toBe("png");
    expect(pictureType(Buffer.from([0, 0, 1, 0, 1, 0]))).toBe("ico");
    expect(pictureType(Buffer.from("<svg xmlns='x'></svg>"))).toBe("svg");
    expect(pictureType(Buffer.from("<html>Not found</html>"))).toBeNull();
    expect(iconInPage(`<link rel="stylesheet" href="a.css"><link rel="shortcut icon" href="/img/i.png">`, "https://site.example/page")).toBe("https://site.example/img/i.png");
    expect(iconInPage(`<link rel="mask-icon" href="m.svg">`, "https://site.example/")).toBeNull();
  });

  it("asks the site itself, keeps the icon on disk, and remembers a site that has none", async () => {
    const asked: string[] = [];
    const fake = (async (url: string) => {
      asked.push(url);
      if (url === "https://with.example/favicon.ico") return new Response("<html>404</html>", { status: 404 });
      if (url === "https://with.example/") return new Response(`<link rel="icon" href="/i.png">`, { status: 200 });
      if (url === "https://with.example/i.png") return new Response(PNG, { status: 200 });
      return new Response("nothing", { status: 404 });
    }) as unknown as typeof fetch;
    const icons = new Favicons(dir, () => fake, async () => ["93.184.216.34"]);
    expect(await icons.get("https://with.example/some/article")).toMatchObject({ type: "image/png" });
    expect(await icons.get("https://www.with.example/other")).toMatchObject({ type: "image/png" });
    expect(await icons.get("https://without.example/")).toBeNull();
    expect(await icons.get("https://without.example/again")).toBeNull();
    // Once each: then from the disk.
    expect(asked.filter((u) => u.startsWith("https://with.example"))).toHaveLength(3);
    expect(asked.filter((u) => u.startsWith("https://without.example"))).toHaveLength(2);
    // Never this computer's network, by the address or by what a name points at.
    expect(await icons.get("http://127.0.0.1:8080/")).toBeNull();
    expect(await icons.get("http://localhost/")).toBeNull();
    expect(await new Favicons(dir, () => fake, async () => ["192.168.1.5"]).get("https://inside.example/")).toBeNull();
  });
});
