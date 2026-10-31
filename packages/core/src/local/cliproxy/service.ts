import type { AccountLimits, AccountLimitWindow, CliProxyStatus, SubscriptionAccount, SubscriptionKind, SubscriptionLogin } from "@drimvox/shared";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Database } from "../../db";
import { removeTree } from "../../fsx";
import type { ProviderRepo } from "../../providers/repo";
import type { Cipher } from "../../secrets";
import { CLIPROXY_VERSION, cliProxyAsset, installCliProxy, installedProgram } from "./install";

/** Kept next to the settings; the two keys encrypted. */
const KEY = "cliproxy";
const PREFERRED_PORT = 8317;

interface Kept {
  port: number;
  management: string;
  client: string;
  stopOnQuit: boolean;
  /** The user switched the server on: it starts with Drimvox. */
  wanted: boolean;
  /** The server Drimvox left running when it closed (stopOnQuit off): picked up again by its process id. */
  pid: number | null;
  providerId: string | null;
}

export interface CliProxyOptions {
  db: Database;
  cipher: Cipher;
  providers: ProviderRepo;
  /** Where the program, its settings and the accounts' sign-ins live. */
  dir: string;
  fetch?: typeof fetch;
  /** Tests: a fake program and archive. */
  asset?: { url: string; sha256: string } | null;
}

/** A free port on this computer, the preferred one when it is free. */
function freePort(preferred: number): Promise<number> {
  const tryPort = (port: number) =>
    new Promise<number | null>((resolve) => {
      const s = createServer();
      s.once("error", () => resolve(null));
      s.listen(port, "127.0.0.1", () => {
        const got = (s.address() as { port: number }).port;
        s.close(() => resolve(got));
      });
    });
  return tryPort(preferred).then((p) => p ?? tryPort(0).then((q) => q ?? preferred));
}

const alive = (pid: number | null) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * CLIProxyAPI on this computer (asked for: free access through one's own subscriptions, on its own tab of the local
 * models): downloaded and removed like the other engines, started and stopped by a switch, kept running after Drimvox
 * closes when the user wants. Its accounts are signed in through its Management API; their limits are asked of each
 * service on the account's behalf.
 */
export class CliProxy {
  private child: ChildProcess | null = null;
  /** The running server was started to outlive Drimvox. */
  private childKept = false;
  private download: { received: number; total: number } | null = null;
  private error: string | null = null;
  private starting: Promise<void> | null = null;
  private readonly f: typeof fetch;

  constructor(private readonly o: CliProxyOptions) {
    this.f = o.fetch ?? fetch;
  }

  private get binDir() {
    return join(this.o.dir, "bin");
  }

  private kept(): Kept {
    const row = this.o.db.sql.prepare("select value from settings where key = ?").get(KEY) as { value: string } | undefined;
    const base: Kept = { port: PREFERRED_PORT, management: "", client: "", stopOnQuit: true, wanted: false, pid: null, providerId: null };
    if (!row) return base;
    try {
      const v = JSON.parse(row.value) as Kept;
      return { ...base, ...v, management: v.management ? this.o.cipher.decrypt(v.management) : "", client: v.client ? this.o.cipher.decrypt(v.client) : "" };
    } catch {
      return base;
    }
  }

  private keep(patch: Partial<Kept>): Kept {
    const next = { ...this.kept(), ...patch };
    const stored = { ...next, management: next.management ? this.o.cipher.encrypt(next.management) : "", client: next.client ? this.o.cipher.encrypt(next.client) : "" };
    this.o.db.sql.prepare("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(KEY, JSON.stringify(stored));
    return next;
  }

  private asset() {
    return this.o.asset !== undefined ? this.o.asset : cliProxyAsset();
  }

  async status(): Promise<CliProxyStatus> {
    const k = this.kept();
    const installed = !!installedProgram(this.binDir);
    const running = installed && (await this.healthy(k));
    return {
      supported: !!this.asset(),
      installed,
      version: installed ? CLIPROXY_VERSION : null,
      running,
      port: running ? k.port : null,
      stopOnQuit: k.stopOnQuit,
      download: this.download,
      error: this.error,
      providerId: k.providerId && this.o.providers.get(k.providerId) ? k.providerId : null,
    };
  }

  /** Starts the download; its progress shows in status(). */
  install(): void {
    const asset = this.asset();
    if (!asset || this.download) return;
    this.error = null;
    this.download = { received: 0, total: 0 };
    void installCliProxy({ ...asset, dir: this.binDir, fetch: this.f, signal: AbortSignal.timeout(15 * 60_000), progress: (received, total) => (this.download = { received, total }) })
      .then(() => this.start())
      .catch((err) => (this.error = err instanceof Error ? err.message : String(err)))
      .finally(() => (this.download = null));
  }

  /** Stops it and removes the program, its settings, the accounts' sign-ins and its provider. */
  async remove(): Promise<void> {
    await this.stop();
    const k = this.kept();
    if (k.providerId && this.o.providers.get(k.providerId)) this.o.providers.remove(k.providerId);
    removeTree(this.o.dir);
    this.o.db.sql.prepare("delete from settings where key = ?").run(KEY);
  }

  async setStopOnQuit(stopOnQuit: boolean): Promise<void> {
    this.keep({ stopOnQuit });
    // A server already running the other way is started again the new way: tied to Drimvox, or a process of its own.
    if (this.child && this.childKept === stopOnQuit) {
      await this.stop();
      await this.start();
    }
  }

  /** At Drimvox's start: the server the user left on is started again, or picked up when it still runs. */
  async resume(): Promise<void> {
    const k = this.kept();
    if (k.wanted && installedProgram(this.binDir)) await this.start().catch((err) => (this.error = err instanceof Error ? err.message : String(err)));
  }

  start(): Promise<void> {
    this.starting ??= this.doStart().finally(() => (this.starting = null));
    return this.starting;
  }

  private async doStart(): Promise<void> {
    let k = this.keep({ wanted: true });
    // Still running from last time (kept after Drimvox closed): picked up as it is.
    if (await this.healthy(k)) return void this.ensureProvider(k);
    const program = installedProgram(this.binDir);
    if (!program) throw new Error("CLIProxyAPI is not installed");
    const port = await freePort(k.port || PREFERRED_PORT);
    k = this.keep({ port, management: k.management || randomBytes(24).toString("hex"), client: k.client || randomBytes(24).toString("hex") });
    const auths = join(this.o.dir, "auths");
    mkdirSync(auths, { recursive: true });
    const config = join(this.o.dir, "config.yaml");
    const q = (s: string) => JSON.stringify(s);
    writeFileSync(
      config,
      [
        "config-version: 8",
        "server:",
        `  host: ${q("127.0.0.1")}`,
        `  port: ${port}`,
        "management:",
        `  secret-key: ${q(k.management)}`,
        "  allow-remote: false",
        "  disable-control-panel: true",
        "access:",
        "  api-keys:",
        `    - ${q(k.client)}`,
        "oauth:",
        `  auth-dir: ${q(auths.split("\\").join("/"))}`,
        "",
      ].join("\n"),
    );
    this.error = null;
    // Left running after Drimvox closes when the user wants: a process of its own, not tied to Drimvox's.
    const child = spawn(program, ["-config", config], { cwd: this.o.dir, stdio: "ignore", windowsHide: true, detached: !k.stopOnQuit });
    if (!k.stopOnQuit) child.unref();
    this.child = child;
    this.childKept = !k.stopOnQuit;
    child.once("exit", () => {
      if (this.child === child) this.child = null;
    });
    this.keep({ pid: child.pid ?? null });
    for (let i = 0; i < 60; i++) {
      if (await this.healthy(k)) return void this.ensureProvider(k);
      if (this.child !== child) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("CLIProxyAPI did not start");
  }

  async stop(): Promise<void> {
    const k = this.keep({ wanted: false });
    const child = this.child;
    this.child = null;
    if (child) child.kill();
    else if (alive(k.pid)) process.kill(k.pid!);
    this.keep({ pid: null });
  }

  /** Drimvox closes: the server goes with it unless the user keeps it (then it was started as a process of its own). */
  close(): void {
    if (this.child && !this.childKept) this.child.kill();
  }

  private async healthy(k: Kept): Promise<boolean> {
    if (!k.client) return false;
    try {
      const res = await this.f(`http://127.0.0.1:${k.port}/v1/models`, { headers: { authorization: `Bearer ${k.client}` }, signal: AbortSignal.timeout(1500) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** The provider in "Keys and models" that talks to the server, at its current address. */
  private ensureProvider(k: Kept): void {
    const baseUrl = `http://127.0.0.1:${k.port}/v1`;
    const known = k.providerId ? this.o.providers.get(k.providerId) : null;
    if (known) {
      this.o.providers.update(known.id, { baseUrl, apiKey: k.client });
      return;
    }
    const created = this.o.providers.create({ preset: "custom", name: "CLIProxyAPI", baseUrl, apiKey: k.client });
    this.keep({ providerId: created.id });
  }

  private async management(path: string, init: RequestInit = {}): Promise<unknown> {
    const k = this.kept();
    const res = await this.f(`http://127.0.0.1:${k.port}/v0/management${path}`, {
      ...init,
      headers: { authorization: `Bearer ${k.management}`, "content-type": "application/json", ...(init.headers as Record<string, string>) },
      signal: init.signal ?? AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `CLIProxyAPI answered ${res.status}`);
    return body;
  }

  async accounts(): Promise<SubscriptionAccount[]> {
    const body = (await this.management("/auth-files")) as { files?: Record<string, unknown>[] };
    return (body.files ?? []).map((f) => ({
      name: String(f.name ?? f.id ?? ""),
      kind: String(f.provider ?? f.type ?? ""),
      email: typeof f.email === "string" && f.email ? f.email : typeof f.account === "string" && f.account ? f.account : null,
      status: String(f.status ?? (f.unavailable ? "unavailable" : "active")),
      disabled: !!f.disabled,
      authIndex: f.auth_index !== undefined ? String(f.auth_index) : null,
    }));
  }

  async login(kind: SubscriptionKind): Promise<SubscriptionLogin> {
    const body = (await this.management(`/${kind}-auth-url`)) as { url?: string; state?: string; user_code?: string };
    if (!body.url || !body.state) throw new Error("CLIProxyAPI gave no sign-in address");
    return { url: body.url, state: body.state, userCode: body.user_code ?? null };
  }

  async loginStatus(state: string): Promise<{ status: "wait" | "ok" | "error"; error: string | null }> {
    const body = (await this.management(`/get-auth-status?state=${encodeURIComponent(state)}`)) as { status?: string; error?: string };
    const status = body.status === "ok" ? "ok" : body.status === "error" ? "error" : "wait";
    return { status, error: body.error ?? null };
  }

  /** The address the sign-in page ended on, pasted on a server where it could not come back to localhost. */
  async loginCallback(kind: SubscriptionKind, state: string, redirectUrl: string): Promise<void> {
    await this.management("/oauth-callback", { method: "POST", body: JSON.stringify({ provider: kind === "anthropic" ? "anthropic" : kind, state, redirect_url: redirectUrl }) });
  }

  async removeAccount(name: string): Promise<void> {
    await this.management(`/auth-files?name=${encodeURIComponent(name)}`, { method: "DELETE" });
  }

  /** A request to a service on an account's behalf: CLIProxyAPI puts the account's token in place of $TOKEN$. */
  private async onBehalf(authIndex: string, method: string, url: string, header: Record<string, string>, data?: string): Promise<unknown> {
    const body = (await this.management("/api-call", { method: "POST", body: JSON.stringify({ auth_index: authIndex, method, url, header, ...(data !== undefined ? { data } : {}) }) })) as {
      status_code?: number;
      body?: string;
    };
    if (!body.status_code || body.status_code >= 300) throw new Error(`The service answered ${body.status_code ?? "nothing"}`);
    return JSON.parse(body.body ?? "null") as unknown;
  }

  /** Every signed-in account's limits: how much is used and when each starts over. */
  async limits(): Promise<AccountLimits[]> {
    const accounts = (await this.accounts()).filter((a) => !a.disabled);
    return Promise.all(
      accounts.map(async (a): Promise<AccountLimits> => {
        const base = { account: a.name, kind: a.kind, email: a.email };
        if (!a.authIndex) return { ...base, windows: [], note: "unknown" };
        try {
          const windows = await this.limitsOf(a.kind, a.authIndex);
          return windows ? { ...base, windows, note: null } : { ...base, windows: [], note: "not_reported" };
        } catch {
          return { ...base, windows: [], note: "failed" };
        }
      }),
    );
  }

  private async limitsOf(kind: string, authIndex: string): Promise<AccountLimitWindow[] | null> {
    const bearer = { authorization: "Bearer $TOKEN$" };
    if (kind === "claude" || kind === "anthropic") {
      const u = (await this.onBehalf(authIndex, "GET", "https://api.anthropic.com/api/oauth/usage", { ...bearer, "anthropic-beta": "oauth-2025-04-20" })) as Record<
        string,
        { utilization?: number; resets_at?: string } | null
      >;
      return claudeWindows(u);
    }
    if (kind === "codex") {
      const u = (await this.onBehalf(authIndex, "GET", "https://chatgpt.com/backend-api/wham/usage", bearer)) as { rate_limit?: Record<string, CodexWindow | null> };
      return codexWindows(u);
    }
    if (kind === "antigravity") {
      const u = (await this.onBehalf(authIndex, "POST", "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels", { ...bearer, "content-type": "application/json" }, "{}")) as {
        models?: Record<string, { displayName?: string; quotaInfo?: { remainingFraction?: number; resetTime?: string } }>;
      };
      return antigravityWindows(u);
    }
    return null;
  }
}

interface CodexWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_at?: number;
  reset_after_seconds?: number;
}

/** Claude: the five-hour window, the week, and the week of single models when the account has them. */
export function claudeWindows(u: Record<string, { utilization?: number; resets_at?: string } | null>): AccountLimitWindow[] {
  const out: AccountLimitWindow[] = [];
  for (const [key, w] of Object.entries(u ?? {})) {
    if (!w || typeof w !== "object" || typeof w.utilization !== "number") continue;
    if (!/^(five_hour|seven_day)/.test(key)) continue;
    out.push({ window: key, usedPercent: Math.round(w.utilization), resetsAt: w.resets_at ?? null });
  }
  return out;
}

/** Codex: the short window (usually five hours) and the week, by their length. */
export function codexWindows(u: { rate_limit?: Record<string, CodexWindow | null> }): AccountLimitWindow[] {
  const out: AccountLimitWindow[] = [];
  for (const w of [u.rate_limit?.primary_window, u.rate_limit?.secondary_window]) {
    if (!w || typeof w.used_percent !== "number") continue;
    const seconds = w.limit_window_seconds ?? 0;
    const window = seconds === 18_000 ? "five_hour" : seconds === 604_800 ? "seven_day" : `${Math.round(seconds / 3600)}h`;
    const reset = w.reset_at ? new Date(w.reset_at * 1000) : w.reset_after_seconds !== undefined ? new Date(Date.now() + w.reset_after_seconds * 1000) : null;
    out.push({ window, usedPercent: Math.round(w.used_percent), resetsAt: reset ? reset.toISOString() : null });
  }
  return out;
}

/** Antigravity: a quota per model, as the share left. */
export function antigravityWindows(u: { models?: Record<string, { displayName?: string; quotaInfo?: { remainingFraction?: number; resetTime?: string } }> }): AccountLimitWindow[] {
  return Object.entries(u.models ?? {})
    .filter(([, m]) => typeof m?.quotaInfo?.remainingFraction === "number")
    .map(([id, m]) => ({ window: m.displayName || id, usedPercent: Math.round((1 - m.quotaInfo!.remainingFraction!) * 100), resetsAt: m.quotaInfo!.resetTime ?? null }));
}
