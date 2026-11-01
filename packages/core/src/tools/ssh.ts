import { sshServerSchema, type SshServerInput, type SshServerView } from "@drimvox/shared";
import { tool, type ToolSet } from "ai";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Client, type ConnectConfig } from "ssh2";
import { z } from "zod";
import type { ToolHooks } from "../agent/tools";
import type { Database } from "../db";
import type { Cipher } from "../secrets";
import type { Workspace } from "../agent/workspace";

const KEY = "ssh.servers";
const OUTPUT = 20_000;

interface Stored extends Omit<SshServerView, "hasPassword"> {
  /** The password, encrypted; null for a key. */
  secret: string | null;
}

/**
 * Other computers the agent works on over SSH (docs/specs/ssh.md, asked for: it was done with plink and a password
 * written into the command, kept in the chat's history). The sign-in stays here, encrypted; the model names the server.
 * The server's key is remembered on the first connection and a different one is refused.
 */
export class SshServers {
  constructor(
    private readonly db: Database,
    private readonly cipher: Cipher,
  ) {}

  private all(): Stored[] {
    const row = this.db.sql.prepare("select value from settings where key = ?").get(KEY) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as Stored[]) : [];
  }

  private keep(list: Stored[]): void {
    this.db.sql.prepare("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(KEY, JSON.stringify(list));
  }

  list(): SshServerView[] {
    return this.all().map(view);
  }

  find(name: string): Stored | null {
    const n = name.trim().toLowerCase();
    return this.all().find((s) => s.name.toLowerCase() === n || s.id === name) ?? null;
  }

  save(input: SshServerInput, id?: string): SshServerView {
    const parsed = sshServerSchema.parse(input);
    const list = this.all();
    const old = id ? list.find((s) => s.id === id) : undefined;
    const sameHost = old && old.host === parsed.host && old.port === parsed.port;
    const next: Stored = {
      id: old?.id ?? randomUUID(),
      name: parsed.name,
      host: parsed.host,
      port: parsed.port,
      user: parsed.user,
      auth: parsed.auth,
      keyPath: parsed.auth === "key" ? parsed.keyPath || null : null,
      trust: parsed.trust,
      // A new password replaces the old; none given keeps it.
      secret: parsed.auth === "password" ? (parsed.password ? this.cipher.encrypt(parsed.password) : (old?.secret ?? null)) : null,
      fingerprint: sameHost ? (old?.fingerprint ?? null) : null,
    };
    this.keep(old ? list.map((s) => (s.id === old.id ? next : s)) : [...list, next]);
    return view(next);
  }

  remove(id: string): boolean {
    const list = this.all();
    this.keep(list.filter((s) => s.id !== id));
    return list.some((s) => s.id === id);
  }

  private remember(id: string, fingerprint: string): void {
    this.keep(this.all().map((s) => (s.id === id ? { ...s, fingerprint } : s)));
  }

  /** The password, for hiding it from anything shown. */
  secretOf(server: Stored): string | null {
    if (!server.secret) return null;
    try {
      return this.cipher.decrypt(server.secret);
    } catch {
      return null;
    }
  }

  /** An open connection; the server's key checked against the one remembered. */
  connect(server: Stored, signal?: AbortSignal): Promise<Client> {
    const config: ConnectConfig = { host: server.host, port: server.port, username: server.user, readyTimeout: 20_000, keepaliveInterval: 15_000 };
    if (server.auth === "password") config.password = this.secretOf(server) ?? "";
    else {
      const key = keyFile(server.keyPath);
      if (key) config.privateKey = readFileSync(key);
      // Windows' own agent, or one named by SSH_AUTH_SOCK: keys loaded there sign in too.
      config.agent = process.env.SSH_AUTH_SOCK ?? (process.platform === "win32" ? "\\\\.\\pipe\\openssh-ssh-agent" : undefined);
    }
    let seen: string | null = null;
    config.hostVerifier = (hostKey: Buffer) => {
      seen = `SHA256:${createHash("sha256").update(hostKey).digest("base64").replace(/=+$/, "")}`;
      return !server.fingerprint || server.fingerprint === seen;
    };
    return new Promise((resolve, reject) => {
      const client = new Client();
      const stop = () => (client.end(), reject(new Error("Stopped")));
      signal?.addEventListener("abort", stop, { once: true });
      client
        .on("ready", () => {
          signal?.removeEventListener("abort", stop);
          if (!server.fingerprint && seen) this.remember(server.id, seen);
          resolve(client);
        })
        .on("error", (err) => {
          signal?.removeEventListener("abort", stop);
          const changed = server.fingerprint && seen && seen !== server.fingerprint;
          reject(new Error(changed ? `The server's key changed (was ${server.fingerprint}, now ${seen}): refused, someone may be in between. If the server was reinstalled, remove it in the settings and add it again.` : err.message));
        })
        .connect(config);
    });
  }

  /** A command on the server: its output (the password cut out) and exit code. */
  async exec(server: Stored, command: string, timeoutMs: number, signal?: AbortSignal): Promise<{ code: number | null; output: string }> {
    const client = await this.connect(server, signal);
    try {
      return await new Promise((resolve, reject) => {
        client.exec(command, (err, stream) => {
          if (err) return reject(err);
          let out = "";
          const add = (b: Buffer) => {
            if (out.length < OUTPUT * 2) out += b.toString("utf8");
          };
          const timer = setTimeout(() => (stream.close(), resolve({ code: null, output: `${out}\n[stopped after ${Math.round(timeoutMs / 1000)} s]` })), timeoutMs);
          signal?.addEventListener("abort", () => (clearTimeout(timer), stream.close()), { once: true });
          stream.on("data", add).stderr.on("data", add);
          stream.on("close", (code: number | null) => (clearTimeout(timer), resolve({ code, output: out })));
        });
      });
    } finally {
      client.end();
    }
  }

  /** Moves a file over SFTP, one way or the other. */
  async copy(server: Stored, direction: "up" | "down", local: string, remote: string, signal?: AbortSignal): Promise<void> {
    const client = await this.connect(server, signal);
    try {
      await new Promise<void>((resolve, reject) => {
        client.sftp((err, sftp) => {
          if (err) return reject(err);
          const done = (e?: Error | null) => (e ? reject(e) : resolve());
          if (direction === "up") sftp.fastPut(local, remote, done);
          else {
            mkdirSync(dirname(local), { recursive: true });
            sftp.fastGet(remote, local, done);
          }
        });
      });
    } finally {
      client.end();
    }
  }
}

function view(s: Stored): SshServerView {
  const { secret, ...rest } = s;
  return { ...rest, hasPassword: !!secret };
}

/** The key file given, or the computer's own default key. */
function keyFile(given: string | null): string | null {
  if (given) return given.replace(/^~(?=$|[\\/])/, homedir());
  for (const name of ["id_ed25519", "id_ecdsa", "id_rsa"]) {
    const path = join(homedir(), ".ssh", name);
    if (existsSync(path)) return path;
  }
  return null;
}

const clip = (text: string, secret: string | null) => {
  const safe = secret ? text.split(secret).join("***") : text;
  return safe.length > OUTPUT ? `${safe.slice(0, OUTPUT)}\n[… ${safe.length - OUTPUT} more characters]` : safe;
};

/**
 * The agent's SSH tools: the saved servers by name, a command on one (asked first unless the server is trusted), a file
 * there and back. Files on this side are inside the chat's or the project's folder.
 */
export function sshTools(servers: SshServers, ws: Workspace | null, hooks: Pick<ToolHooks, "onCall" | "askApproval">): ToolSet {
  if (servers.list().length === 0) return {};
  const pick = (name: string) => {
    const s = servers.find(name);
    if (!s) throw new Error(`No server named "${name}". Saved: ${servers.list().map((x) => x.name).join(", ")}.`);
    return s;
  };
  const run = async (name: string, input: string, work: () => Promise<string>) => {
    hooks.onCall({ callId: randomUUID(), name, input });
    try {
      return await work();
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
  const allowed = async (s: Stored, what: string, signal?: AbortSignal) =>
    s.trust === "trusted" || (await hooks.askApproval(`${s.name}: ${what}`, "ssh", signal)) !== false;
  const local = (path: string) => {
    if (!ws) throw new Error("Files need a folder connected to the chat or a project");
    return ws.resolve(path);
  };
  const names = servers.list().map((s) => `${s.name} (${s.user}@${s.host})`).join(", ");
  return {
    ssh_run: tool({
      description: `Run a shell command on another computer over SSH, by the server's saved name. Saved servers: ${names}. The sign-in is Drimvox's: never ask for or write passwords, and never use ssh, plink or putty through run_command.`,
      inputSchema: z.object({ server: z.string().min(1), command: z.string().min(1).max(20_000), timeout_seconds: z.number().int().min(1).max(1800).optional() }),
      execute: ({ server, command, timeout_seconds }, o: { abortSignal?: AbortSignal }) =>
        run("ssh_run", `${server}: ${command.slice(0, 200)}`, async () => {
          const s = pick(server);
          if (!(await allowed(s, command, o.abortSignal))) return "The user denied this command. Do not retry it.";
          const r = await servers.exec(s, command, (timeout_seconds ?? 300) * 1000, o.abortSignal);
          return `Exit code: ${r.code ?? "none"}\n${clip(r.output, servers.secretOf(s)) || "(no output)"}`;
        }),
    }),
    ssh_upload: tool({
      description: "Copy a file from the connected folder to another computer over SSH (SFTP).",
      inputSchema: z.object({ server: z.string().min(1), path: z.string().min(1).describe("The file in the folder"), remote_path: z.string().min(1) }),
      execute: ({ server, path, remote_path }, o: { abortSignal?: AbortSignal }) =>
        run("ssh_upload", `${server}: ${path} → ${remote_path}`, async () => {
          const s = pick(server);
          if (!(await allowed(s, `upload ${path} → ${remote_path}`, o.abortSignal))) return "The user denied this. Do not retry it.";
          await servers.copy(s, "up", local(path), remote_path, o.abortSignal);
          return `Copied ${path} to ${s.name}:${remote_path}.`;
        }),
    }),
    ssh_download: tool({
      description: "Copy a file from another computer over SSH (SFTP) into the connected folder.",
      inputSchema: z.object({ server: z.string().min(1), remote_path: z.string().min(1), path: z.string().min(1).describe("Where to put it in the folder") }),
      execute: ({ server, remote_path, path }, o: { abortSignal?: AbortSignal }) =>
        run("ssh_download", `${server}: ${remote_path} → ${path}`, async () => {
          const s = pick(server);
          await servers.copy(s, "down", local(path), remote_path, o.abortSignal);
          return `Copied ${s.name}:${remote_path} to ${path}.`;
        }),
    }),
  };
}
