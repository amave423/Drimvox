import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttp, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Server as SshServer, utils } from "ssh2";
import { afterEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/agent/workspace";
import { AgentBrowser, findBrowser } from "../src/browser/agent-browser";
import { createCipher } from "../src/secrets";
import { classifyCommand } from "../src/agent/commands";
import { auditTools, npmSummary } from "../src/tools/audit";
import { compareTools } from "../src/tools/compare";
import { downloadTools, downloadsDir } from "../src/tools/downloads";
import { emailTools, setMailApi } from "../src/tools/email";
import { readImageText } from "../src/tools/ocr";
import { SshServers, sshTools } from "../src/tools/ssh";
import { createTestEnv, type TestEnv } from "./env";

// docs/specs/tools.md: tools beyond files and the web, asked for one by one.
const call = (tools: Record<string, unknown>, name: string, input: unknown) =>
  (tools[name] as { execute: (i: unknown, o: unknown) => Promise<string> }).execute(input, { toolCallId: name, messages: [] });
const hooks = { onCall: () => {}, askApproval: async () => true as const };
const dirs: string[] = [];
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
let env: TestEnv | undefined;
let http: HttpServer | undefined;
let ssh: SshServer | undefined;
afterEach(async () => {
  await env?.closeAsync();
  env = undefined;
  http?.closeAllConnections();
  await new Promise((r) => (http ? http.close(r) : r(null)));
  http = undefined;
  await new Promise((r) => (ssh ? ssh.close(() => r(null)) : r(null)));
  ssh = undefined;
  setMailApi(undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("downloads", () => {
  it("lists what the browser downloaded, reads it and copies it into the folder", async () => {
    const data = temp("drimvox-data-");
    const folder = temp("drimvox-folder-");
    mkdirSync(downloadsDir(data));
    writeFileSync(join(downloadsDir(data), "prices.csv"), "товар;цена\nдоска;120\n");
    writeFileSync(join(downloadsDir(data), "half.zip.crdownload"), "…");
    const tools = downloadTools(data, new Workspace(folder), null, hooks);
    const list = await call(tools, "downloads_list", {});
    expect(list).toContain("prices.csv");
    expect(list).not.toContain("crdownload");
    expect(await call(tools, "downloads_read", { name: "prices" })).toContain("доска;120");
    expect(await call(tools, "downloads_save", { name: "prices.csv", path: "data/prices.csv" })).toContain("data/prices.csv");
    expect(readFileSync(join(folder, "data/prices.csv"), "utf8")).toContain("доска");
    expect(await call(tools, "downloads_read", { name: "nothing" })).toMatch(/No downloaded file/);
  });
});

describe("a temporary inbox", () => {
  it("makes an address, waits for a letter and gives its links and codes", async () => {
    const letters: { id: string; from: { address: string }; subject: string; intro: string; createdAt: string }[] = [];
    http = createHttp((req, res) => {
      const json = (status: number, body: unknown) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(body)));
      if (req.url === "/domains") return json(200, { "hydra:member": [{ domain: "mail.test", isActive: true }] });
      if (req.url === "/accounts" && req.method === "POST") return json(201, { id: "a1" });
      if (req.url === "/token" && req.method === "POST") return json(200, { token: "t1" });
      if (req.headers.authorization !== "Bearer t1") return json(401, {});
      if (req.url === "/messages") return json(200, { "hydra:member": letters });
      if (req.url === "/messages/m1") return json(200, { from: { address: "noreply@site.test" }, subject: "Подтвердите почту", text: "Ваш код 482913. Или откройте https://site.test/confirm?t=abc" });
      json(404, {});
    });
    await new Promise<void>((r) => http!.listen(0, "127.0.0.1", r));
    setMailApi(`http://127.0.0.1:${(http.address() as AddressInfo).port}`);
    const tools = emailTools(hooks);
    expect(await call(tools, "email_inbox", {})).toMatch(/email_new first/);
    expect(await call(tools, "email_new", {})).toMatch(/^New address: [0-9a-f]{10}@mail\.test$/);
    expect(await call(tools, "email_inbox", {})).toMatch(/No letters/);
    setTimeout(() => letters.push({ id: "m1", from: { address: "noreply@site.test" }, subject: "Подтвердите почту", intro: "Ваш код…", createdAt: "" }), 300);
    expect(await call(tools, "email_inbox", { wait_seconds: 10 })).toContain("m1 · from noreply@site.test · Подтвердите почту");
    const letter = await call(tools, "email_read", { id: "m1" });
    expect(letter).toContain("https://site.test/confirm?t=abc");
    expect(letter).toContain("Codes: 482913");
  });
});

describe("other computers over SSH", () => {
  async function server(onExec: (command: string) => string) {
    // ssh2 now and then makes an ed25519 key it cannot read back: one it reads is taken.
    let hostKey = utils.generateKeyPairSync("ed25519").private;
    while (utils.parseKey(hostKey) instanceof Error) hostKey = utils.generateKeyPairSync("ed25519").private;
    ssh = new SshServer({ hostKeys: [hostKey] }, (client) => {
      client
        .on("authentication", (ctx) => (ctx.method === "password" && ctx.username === "root" && ctx.password === "s3cret-pass" ? ctx.accept() : ctx.reject(["password"])))
        .on("ready", () =>
          client.on("session", (accept) =>
            accept().on("exec", (acceptExec, _reject, info) => {
              const stream = acceptExec();
              stream.write(onExec(info.command));
              stream.exit(0);
              stream.end();
            }),
          ),
        )
        .on("error", () => {});
    });
    await new Promise<void>((r) => ssh!.listen(0, "127.0.0.1", r));
    return (ssh.address() as AddressInfo).port;
  }

  it("runs a command by the server's name: the password never shown, asked first, the server's key remembered", async () => {
    env = createTestEnv();
    const port = await server((command) => `ran: ${command}\nthe password is s3cret-pass\n`);
    const servers = new SshServers(env.db, createCipher(randomBytes(32)));
    const saved = servers.save({ name: "Дом", host: "127.0.0.1", port, user: "root", auth: "password", password: "s3cret-pass", trust: "ask" });
    expect(JSON.stringify(servers.list())).not.toContain("s3cret-pass");
    expect(saved).toMatchObject({ hasPassword: true, fingerprint: null });

    const asked: string[] = [];
    let allow = false;
    const tools = sshTools(servers, null, { onCall: () => {}, askApproval: async (command) => (asked.push(command), allow) });
    expect(await call(tools, "ssh_run", { server: "дом", command: "uptime" })).toMatch(/denied/);
    expect(asked).toEqual(["Дом: uptime"]);
    allow = true;
    const out = await call(tools, "ssh_run", { server: "Дом", command: "uptime" });
    expect(out).toContain("Exit code: 0");
    expect(out).toContain("ran: uptime");
    expect(out).not.toContain("s3cret-pass");
    expect(servers.list()[0]!.fingerprint).toMatch(/^SHA256:/);

    // A trusted server runs without asking.
    servers.save({ name: "Дом", host: "127.0.0.1", port, user: "root", auth: "password", trust: "trusted" }, saved.id);
    asked.length = 0;
    expect(await call(sshTools(servers, null, { onCall: () => {}, askApproval: async (c) => (asked.push(c), false) }), "ssh_run", { server: "Дом", command: "ls" })).toContain("ran: ls");
    expect(asked).toEqual([]);
  });

  // Asked: what if the key's path is one letter off? Checked on saving, said in words.
  it("checks a key file on saving: there, and a private key", () => {
    env = createTestEnv();
    const servers = new SshServers(env.db, createCipher(randomBytes(32)));
    const dir = temp("drimvox-keys-");
    let key = utils.generateKeyPairSync("ed25519");
    while (utils.parseKey(key.private) instanceof Error) key = utils.generateKeyPairSync("ed25519");
    writeFileSync(join(dir, "id_ed25519"), key.private);
    writeFileSync(join(dir, "id_ed25519.pub"), "not a private key");
    const base = { name: "k", host: "h", port: 22, user: "u", auth: "key" as const, trust: "ask" as const };
    expect(servers.save({ ...base, keyPath: join(dir, "id_ed25519") })).toMatchObject({ keyPath: join(dir, "id_ed25519") });
    expect(() => servers.save({ ...base, keyPath: join(dir, "id_ed2551") })).toThrow(expect.objectContaining({ code: "key_missing" }));
    expect(() => servers.save({ ...base, keyPath: join(dir, "id_ed25519.pub") })).toThrow(expect.objectContaining({ code: "key_invalid" }));
    // No path: the computer's own key or ssh-agent, nothing to check.
    expect(servers.save({ ...base })).toMatchObject({ keyPath: null });
  });

  it("refuses a server whose key changed", async () => {
    env = createTestEnv();
    const port = await server(() => "ok");
    const servers = new SshServers(env.db, createCipher(randomBytes(32)));
    const saved = servers.save({ name: "s", host: "127.0.0.1", port, user: "root", auth: "password", password: "s3cret-pass", trust: "trusted" });
    expect(await call(sshTools(servers, null, hooks), "ssh_run", { server: "s", command: "x" })).toContain("Exit code: 0");
    // The same address answers with another key: someone may be in between.
    await new Promise((r) => ssh!.close(() => r(null)));
    ssh = undefined;
    const other = await server(() => "ok");
    servers.save({ name: "s", host: "127.0.0.1", port: other, user: "root", auth: "password", trust: "trusted" }, saved.id);
    const kept = servers.list()[0]!;
    expect(kept.fingerprint).toBeNull();
    expect(await call(sshTools(servers, null, hooks), "ssh_run", { server: "s", command: "x" })).toContain("Exit code: 0");
    const first = servers.list()[0]!.fingerprint;
    await new Promise((r) => ssh!.close(() => r(null)));
    ssh = undefined;
    const third = await server(() => "ok");
    // Moved to a new port by hand would clear the key; here the key itself is replaced behind the same entry.
    (servers as unknown as { keep(list: unknown[]): void }).keep(
      (servers as unknown as { all(): { port: number }[] }).all().map((s) => ({ ...s, port: third, fingerprint: first })),
    );
    expect(await call(sshTools(servers, null, hooks), "ssh_run", { server: "s", command: "x" })).toMatch(/key changed/);
  });
});

describe("dependencies' vulnerabilities", () => {
  it("sums up npm audit: by severity, each package with its fix", () => {
    const report = {
      metadata: { vulnerabilities: { critical: 1, high: 0, moderate: 1, low: 0, info: 0, total: 2 } },
      vulnerabilities: {
        lodash: { severity: "moderate", via: [{ title: "Prototype pollution" }], fixAvailable: true },
        minimist: { severity: "critical", via: [{ title: "Prototype pollution in minimist" }], fixAvailable: { name: "mkdirp", version: "1.0.4", isSemVerMajor: true } },
      },
    };
    const text = npmSummary(JSON.stringify(report))!;
    expect(text.split("\n")[0]).toBe("1 critical, 1 moderate");
    expect(text).toContain("- [critical] minimist: Prototype pollution in minimist — fix: mkdirp@1.0.4 (major update: check it)");
    expect(text.indexOf("minimist")).toBeLessThan(text.indexOf("lodash"));
    expect(npmSummary(JSON.stringify({ metadata: { vulnerabilities: { total: 0 } } }))).toBe("No known vulnerabilities.");
  });

  it("asks before plink or sshpass run through a command (a password in the command line)", () => {
    expect(classifyCommand('plink -ssh root@1.2.3.4 -pw secret "ls"', process.cwd())).toEqual({ action: "ask", reason: "ssh" });
    expect(classifyCommand("sshpass -p x ssh a@b", process.cwd())).toEqual({ action: "ask", reason: "ssh" });
  });

  it("says when there is nothing to check", async () => {
    const folder = temp("drimvox-audit-");
    expect(await call(auditTools(folder, hooks), "audit_dependencies", {})).toMatch(/No dependency files/);
  });
});

describe("a real browser", () => {
  let driver: AgentBrowser | undefined;
  let profile = "";
  afterEach(async () => {
    await driver?.stop();
    driver = undefined;
    await new Promise((r) => setTimeout(r, 500));
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    profile = "";
  });

  it.skipIf(!findBrowser())(
    "compares a page before and after, and reads the text on a picture",
    async () => {
      http = createHttp((_req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<body style="margin:0;font:64px sans-serif;background:#fff"><h1 id="t" style="margin:40px">PRICE 2026</h1><div style="height:600px"></div></body>`);
      });
      await new Promise<void>((r) => http!.listen(0, "127.0.0.1", r));
      const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/`;
      profile = mkdtempSync(join(tmpdir(), "drimvox-profile-"));
      driver = new AgentBrowser({ profileDir: profile });
      await driver.open(url);
      await new Promise((r) => setTimeout(r, 800));
      const snaps = temp("drimvox-snaps-");
      const tools = compareTools(driver, snaps, hooks);
      expect(await call(tools, "page_compare", { name: "home" })).toMatch(/page_snapshot first/);
      expect(await call(tools, "page_snapshot", { name: "home" })).toContain("Kept");
      expect(await call(tools, "page_compare", { name: "home" })).toBe("No visible change at 1280 px.");
      await driver.command("Runtime.evaluate", { expression: "document.getElementById('t').style.marginLeft = '400px'" });
      expect(await call(tools, "page_compare", { name: "home" })).toMatch(/% of the page changed at 1280 px\. Changed between \d+ and \d+ px from the top\./);

      // The text on a picture, read by Windows itself when no model that sees is set.
      if (process.platform === "win32") {
        const shot = (await driver.command("Page.captureScreenshot", { format: "png" })) as { data: string };
        const png = join(snaps, "shot.png");
        writeFileSync(png, Buffer.from(shot.data, "base64"));
        const read = await readImageText(png, readFileSync(png), null);
        expect(read.by).toBe("Windows OCR");
        expect(read.text).toMatch(/2026/);
      }
    },
    90_000,
  );
});
