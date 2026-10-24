import type { GithubProject, GithubStatus } from "@drimvox/shared";
import type { Database } from "../db";
import { currentBranch, GitError, runGit } from "../agent/git";
import type { Cipher } from "../secrets";

/** Drimvox's OAuth app on GitHub. Public by design: the device flow has no client secret. */
export const CLIENT_ID = "Ov23liuac4Ai8HSL86BH";

export interface GithubOptions {
  /** github.com, where signing in happens; a fake in tests. */
  webUrl?: string;
  /** api.github.com. */
  apiUrl?: string;
  /** The shortest wait between asks while the user enters the code; GitHub's own interval wins when longer. */
  pollMs?: number;
}

/** A failure the page can name: nobody signed in, the name is taken, the project already has a remote, git refused. */
export class GithubFailure extends Error {
  constructor(
    readonly code: "github_login" | "name_taken" | "has_remote" | "no_remote" | "push_failed" | "github_error",
    message: string,
  ) {
    super(message);
  }
}

/** Kept next to the settings, encrypted, like the proxy address. */
const KEY = "github";

interface Account {
  token: string;
  user: string;
}

/** Signing in to GitHub with a code, creating repositories and pushing to them. See docs/specs/github-publish.md. */
export class GitHub {
  private pending: GithubStatus["pending"] = null;
  private error: GithubStatus["error"] = null;
  /** Bumped on every new sign-in or disconnect: an older wait stops when it sees a newer one. */
  private attempt = 0;
  private readonly web: string;
  private readonly api: string;

  constructor(
    private readonly db: Database,
    private readonly cipher: Cipher,
    private readonly o: GithubOptions = {},
  ) {
    this.web = o.webUrl ?? "https://github.com";
    this.api = o.apiUrl ?? "https://api.github.com";
  }

  private account(): Account | null {
    const row = this.db.sql.prepare("select value from settings where key = ?").get(KEY) as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(this.cipher.decrypt(JSON.parse(row.value) as string)) as Account;
    } catch {
      return null;
    }
  }

  private save(account: Account | null): void {
    if (!account) this.db.sql.prepare("delete from settings where key = ?").run(KEY);
    else {
      this.db.sql
        .prepare("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value")
        .run(KEY, JSON.stringify(this.cipher.encrypt(JSON.stringify(account))));
    }
  }

  status(): GithubStatus {
    if (this.pending && Date.now() > this.pending.expiresAt) {
      this.pending = null;
      this.error = "expired";
    }
    return { user: this.account()?.user ?? null, pending: this.pending, error: this.error };
  }

  /** Asks GitHub for a code and waits in the background while the user enters it. */
  async login(): Promise<GithubStatus> {
    const attempt = ++this.attempt;
    this.error = null;
    const res = await fetch(`${this.web}/login/device/code`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID, scope: "repo" }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as {
      device_code?: string;
      user_code?: string;
      verification_uri?: string;
      expires_in?: number;
      interval?: number;
    } | null;
    if (!res?.ok || !body?.device_code || !body.user_code) {
      this.error = "failed";
      return this.status();
    }
    this.pending = { userCode: body.user_code, verificationUri: body.verification_uri ?? `${this.web}/login/device`, expiresAt: Date.now() + (body.expires_in ?? 900) * 1000 };
    void this.wait(attempt, body.device_code, body.interval ?? 5);
    return this.status();
  }

  private async wait(attempt: number, deviceCode: string, interval: number): Promise<void> {
    let gap = Math.max(this.o.pollMs ?? 5_000, interval * 1000);
    while (attempt === this.attempt && this.pending && Date.now() < this.pending.expiresAt) {
      await new Promise((r) => setTimeout(r, gap));
      if (attempt !== this.attempt) return;
      const res = await fetch(`${this.web}/login/oauth/access_token`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ client_id: CLIENT_ID, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null);
      const body = (await res?.json().catch(() => null)) as { access_token?: string; error?: string; interval?: number } | null;
      if (attempt !== this.attempt) return;
      if (body?.access_token) {
        const user = await this.whoami(body.access_token);
        if (attempt !== this.attempt) return;
        this.pending = null;
        if (user) this.save({ token: body.access_token, user });
        else this.error = "failed";
        return;
      }
      if (body?.error === "authorization_pending" || !body) continue;
      if (body.error === "slow_down") {
        gap = Math.max(gap + 5_000, (body.interval ?? 0) * 1000);
        continue;
      }
      this.pending = null;
      this.error = body.error === "access_denied" ? "denied" : body.error === "expired_token" ? "expired" : "failed";
      return;
    }
  }

  private async whoami(token: string): Promise<string | null> {
    const res = await this.call("/user", token).catch(() => null);
    const body = (await res?.json().catch(() => null)) as { login?: string } | null;
    return res?.ok && body?.login ? body.login : null;
  }

  private call(path: string, token: string, body?: unknown): Promise<Response> {
    return fetch(`${this.api}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  }

  disconnect(): void {
    this.attempt++;
    this.pending = null;
    this.error = null;
    this.save(null);
  }

  private signedIn(): Account {
    const account = this.account();
    if (!account) throw new GithubFailure("github_login", "Not signed in to GitHub");
    return account;
  }

  async project(dir: string): Promise<GithubProject> {
    const remote = (await runGit(dir, ["remote", "get-url", "origin"], true)).stdout.trim() || null;
    return { remote, url: remote ? pageOf(remote) : null };
  }

  /** Creates the repository and pushes the current branch to it as `origin`. */
  async publish(dir: string, name: string, isPrivate: boolean): Promise<{ url: string }> {
    const account = this.signedIn();
    if ((await this.project(dir)).remote) throw new GithubFailure("has_remote", "The project already has a remote");
    const res = await this.call("/user/repos", account.token, { name, private: isPrivate, auto_init: false }).catch((err: unknown) => {
      throw new GithubFailure("github_error", err instanceof Error ? err.message : String(err));
    });
    const body = (await res.json().catch(() => ({}))) as { html_url?: string; clone_url?: string; message?: string; errors?: { message?: string }[] };
    if (res.status === 401) {
      this.save(null);
      throw new GithubFailure("github_login", "GitHub no longer accepts the token");
    }
    if (res.status === 422 && body.errors?.some((e) => /already exists/i.test(e.message ?? ""))) throw new GithubFailure("name_taken", body.errors[0]!.message ?? "");
    if (!res.ok || !body.clone_url) throw new GithubFailure("github_error", body.message ?? `GitHub answered ${res.status}`);
    await runGit(dir, ["remote", "add", "origin", body.clone_url]);
    await this.pushTo(dir, account, true);
    return { url: body.html_url ?? pageOf(body.clone_url) ?? body.clone_url };
  }

  /** Pushes the current branch to `origin`. */
  async push(dir: string): Promise<void> {
    const account = this.signedIn();
    if (!(await this.project(dir)).remote) throw new GithubFailure("no_remote", "The project has no remote");
    await this.pushTo(dir, account, false);
  }

  private async pushTo(dir: string, account: Account, first: boolean): Promise<void> {
    const branch = (await currentBranch(dir)) ?? "HEAD";
    const remote = (await this.project(dir)).remote ?? "";
    // The token goes as a header for the remote's host, through the environment: never in the arguments or the config.
    const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
    if (/^https:\/\//i.test(remote)) {
      const basic = Buffer.from(`x-access-token:${account.token}`).toString("base64");
      Object.assign(env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `http.${new URL(remote).origin}/.extraheader`, GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` });
    }
    try {
      const result = await runGit(dir, ["push", ...(first ? ["-u"] : []), "origin", branch], true, env);
      if (result.code !== 0) throw new GithubFailure("push_failed", hide(result.stderr.trim() || result.stdout.trim(), account.token));
    } catch (err) {
      if (err instanceof GitError) throw new GithubFailure("push_failed", err.message);
      throw err;
    }
  }
}

/** https://github.com/owner/name.git → https://github.com/owner/name; other remotes have no page Drimvox knows. */
function pageOf(remote: string): string | null {
  const m = /^https:\/\/([^/@]+@)?([^/]+)\/([^/]+)\/([^/]+?)(\.git)?\/?$/i.exec(remote);
  if (m) return `https://${m[2]}/${m[3]}/${m[4]}`;
  const ssh = /^git@([^:]+):([^/]+)\/(.+?)(\.git)?$/i.exec(remote);
  return ssh ? `https://${ssh[1]}/${ssh[2]}/${ssh[3]}` : null;
}

/** git may echo what it was given; the token is cut out of anything shown. */
function hide(text: string, token: string): string {
  return text.split(token).join("•••");
}
