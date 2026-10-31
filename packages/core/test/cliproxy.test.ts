import { zipSync, gzipSync } from "fflate";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installCliProxy, PROGRAM, untar } from "../src/local/cliproxy/install";
import { antigravityWindows, claudeWindows, CliProxy, codexWindows } from "../src/local/cliproxy/service";
import { createTestEnv, type TestEnv } from "./env";
import { ProviderRepo } from "../src/providers/repo";
import { ProxyStore } from "../src/proxy";
import { createCipher } from "../src/secrets";
import { randomBytes } from "node:crypto";

/** A tar archive with one file, as GitHub's Linux builds come. */
function tarOf(name: string, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(512);
  const put = (text: string, at: number) => header.set(new TextEncoder().encode(text), at);
  put(name, 0);
  put("0000755\0", 100);
  put(data.length.toString(8).padStart(11, "0") + "\0", 124);
  put("0", 156);
  put("ustar\0", 257);
  const body = new Uint8Array(Math.ceil(data.length / 512) * 512);
  body.set(data);
  const out = new Uint8Array(512 + body.length + 1024);
  out.set(header);
  out.set(body, 512);
  return out;
}

const program = new TextEncoder().encode("the program itself");
const respond = (bytes: Uint8Array) => (async () => new Response(Buffer.from(bytes), { headers: { "content-length": String(bytes.length) } })) as unknown as typeof fetch;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "drimvox-cliproxy-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Asked for: CLIProxyAPI downloaded and removed like the other engines.
describe("installing CLIProxyAPI", () => {
  it("unpacks the Windows zip and the Linux tar.gz, checking the archive against its checksum", async () => {
    const zip = zipSync({ "cli-proxy-api.exe": program, "cli-proxy-api": program, "README.md": new Uint8Array([1]) });
    const path = await installCliProxy({ url: "https://x/a.zip", sha256: sha(zip), dir: join(dir, "bin"), fetch: respond(zip), signal: AbortSignal.timeout(5000), progress: () => {} });
    expect(path).toBe(join(dir, "bin", PROGRAM));
    expect(readFileSync(path, "utf8")).toBe("the program itself");

    const tgz = gzipSync(tarOf("cli-proxy-api", program));
    expect(untar(tarOf("cli-proxy-api", program))["cli-proxy-api"]).toEqual(program);
    const second = await installCliProxy({ url: "https://x/a.tar.gz", sha256: sha(tgz), dir: join(dir, "bin2"), fetch: respond(tgz), signal: AbortSignal.timeout(5000), progress: () => {} });
    expect(readFileSync(second, "utf8")).toBe("the program itself");
  });

  it("refuses an archive that does not match its checksum and leaves nothing behind", async () => {
    const zip = zipSync({ "cli-proxy-api.exe": program });
    await expect(installCliProxy({ url: "https://x/a.zip", sha256: "0".repeat(64), dir: join(dir, "bin"), fetch: respond(zip), signal: AbortSignal.timeout(5000), progress: () => {} })).rejects.toThrow(/checksum/);
    expect(existsSync(join(dir, "bin"))).toBe(false);
  });
});

// Asked for: limits with the time they start over, as the services' own sites show them.
describe("account limits", () => {
  it("reads Claude's five hours and week, Codex's windows by their length, Antigravity's per-model quotas", () => {
    expect(claudeWindows({ five_hour: { utilization: 41.6, resets_at: "2026-11-01T10:00:00Z" }, seven_day: { utilization: 12, resets_at: "2026-11-05T00:00:00Z" }, seven_day_opus: null, extra: { utilization: 3 } })).toEqual([
      { window: "five_hour", usedPercent: 42, resetsAt: "2026-11-01T10:00:00Z" },
      { window: "seven_day", usedPercent: 12, resetsAt: "2026-11-05T00:00:00Z" },
    ]);
    const at = Math.floor(Date.parse("2026-11-01T12:00:00Z") / 1000);
    expect(codexWindows({ rate_limit: { primary_window: { used_percent: 27, limit_window_seconds: 18_000, reset_at: at }, secondary_window: { used_percent: 60, limit_window_seconds: 604_800, reset_at: at } } })).toEqual([
      { window: "five_hour", usedPercent: 27, resetsAt: "2026-11-01T12:00:00.000Z" },
      { window: "seven_day", usedPercent: 60, resetsAt: "2026-11-01T12:00:00.000Z" },
    ]);
    expect(antigravityWindows({ models: { "gemini-3-pro": { displayName: "Gemini 3 Pro", quotaInfo: { remainingFraction: 0.25, resetTime: "2026-11-01T00:00:00Z" } }, nope: {} } })).toEqual([
      { window: "Gemini 3 Pro", usedPercent: 75, resetsAt: "2026-11-01T00:00:00Z" },
    ]);
  });
});

describe("a running CLIProxyAPI", () => {
  let env: TestEnv;
  beforeEach(() => {
    env = createTestEnv();
  });
  afterEach(() => env.close());

  /** A server that already answers (left running last time): Drimvox picks it up without starting anything. */
  function running(answers: (path: string, init?: RequestInit) => unknown) {
    const calls: { path: string; body: unknown; auth: string | null }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname + new URL(url).search;
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null, auth: (init?.headers as Record<string, string>)?.authorization ?? null });
      return new Response(JSON.stringify(answers(path, init) ?? {}), { status: 200 });
    }) as unknown as typeof fetch;
    const cipher = createCipher(randomBytes(32));
    const providers = new ProviderRepo(env.db, cipher, new ProxyStore(env.db, cipher));
    const proxy = new CliProxy({ db: env.db, cipher, providers, dir, fetch: f, asset: null });
    env.db.sql
      .prepare("insert into settings (key, value) values ('cliproxy', ?)")
      .run(JSON.stringify({ port: 8317, management: cipher.encrypt("mgmt"), client: cipher.encrypt("client"), stopOnQuit: true, wanted: true, pid: null, providerId: null }));
    return { proxy, calls, providers };
  }

  it("connects its provider, lists accounts, signs in and asks each service for its limits on the account's behalf", async () => {
    const { proxy, calls, providers } = running((path) => {
      if (path === "/v0/management/auth-files") return { files: [{ name: "claude-a.json", provider: "claude", email: "a@example.com", status: "active", auth_index: "1" }, { name: "x.json", provider: "kimi", auth_index: "2" }] };
      if (path === "/v0/management/anthropic-auth-url") return { status: "ok", url: "https://claude.ai/oauth/authorize?x", state: "s1" };
      if (path.startsWith("/v0/management/get-auth-status")) return { status: "ok" };
      if (path === "/v0/management/api-call") return { status_code: 200, body: JSON.stringify({ five_hour: { utilization: 50, resets_at: "2026-11-01T10:00:00Z" } }) };
      return { data: [] };
    });
    // Picked up at Drimvox's start; nothing installed, so nothing is spawned.
    await proxy.start().catch(() => {});
    expect(providers.list().find((p) => p.name === "CLIProxyAPI")?.baseUrl).toBe("http://127.0.0.1:8317/v1");

    expect(await proxy.accounts()).toEqual([
      { name: "claude-a.json", kind: "claude", email: "a@example.com", status: "active", disabled: false, authIndex: "1" },
      { name: "x.json", kind: "kimi", email: null, status: "active", disabled: false, authIndex: "2" },
    ]);
    expect(await proxy.login("anthropic")).toEqual({ url: "https://claude.ai/oauth/authorize?x", state: "s1", userCode: null });
    expect(await proxy.loginStatus("s1")).toEqual({ status: "ok", error: null });

    const limits = await proxy.limits();
    expect(limits[0]).toMatchObject({ kind: "claude", windows: [{ window: "five_hour", usedPercent: 50 }], note: null });
    expect(limits[1]).toMatchObject({ kind: "kimi", windows: [], note: "not_reported" });
    const call = calls.find((c) => c.path === "/v0/management/api-call")!;
    expect(call.body).toMatchObject({ auth_index: "1", url: "https://api.anthropic.com/api/oauth/usage", header: { authorization: "Bearer $TOKEN$" } });
    expect(call.auth).toBe("Bearer mgmt");
  });
});
