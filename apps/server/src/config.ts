import { randomBytes, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ServerConfig {
  /** Database, agents' copies of projects, pictures, the key file. */
  dataDir: string;
  /** Listens on 127.0.0.1 only; `tailscale serve` brings it to the tailnet over HTTPS. */
  port: number;
  /** Extra names the server answers to, besides localhost and the Tailscale name. */
  hosts: string[];
}

export function readConfig(env: Record<string, string | undefined>, home: string): ServerConfig {
  const port = env.ARTEL_PORT ? Number(env.ARTEL_PORT) : 4317;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`ARTEL_PORT must be a port number, got "${env.ARTEL_PORT}"`);
  return {
    dataDir: env.ARTEL_DATA_DIR || join(home, ".local", "share", "artel"),
    port,
    hosts: (env.ARTEL_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
  };
}

/** "artel-box.tail1234.ts.net" from `tailscale status --json`; null when Tailscale is not running. */
export function tailscaleName(statusJson: string): string | null {
  try {
    const status = JSON.parse(statusJson) as { BackendState?: string; Self?: { DNSName?: string } };
    const name = status.Self?.DNSName?.replace(/\.$/, "");
    return status.BackendState === "Running" && name ? name : null;
  } catch {
    return null;
  }
}

/**
 * The 32-byte key that encrypts provider keys, in `secret.key` readable only by the server's user.
 * Created on the first start; the server needs nobody to unlock it after a reboot.
 */
export function loadSecretKey(dataDir: string): Buffer {
  const file = join(dataDir, "secret.key");
  if (existsSync(file)) {
    const key = readFileSync(file);
    if (key.length !== 32) throw new Error(`${file} is damaged`);
    return key;
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  writeFileSync(file, key, { mode: 0o600 });
  return key;
}

/** The code that lets the first browser set the password; written to the server's log. */
export function setupCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}
