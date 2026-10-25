import { randomBytes, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
  const get = (name: string) => env[`DRIMVOX_${name}`];
  const portText = get("PORT");
  const port = portText ? Number(portText) : 4317;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`DRIMVOX_PORT must be a port number, got "${portText}"`);
  const share = join(home, ".local", "share");
  return {
    dataDir: get("DATA_DIR") || join(share, "drimvox"),
    port,
    hosts: (get("HOSTS") ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
  };
}

/** "drimvox-box.tail1234.ts.net" from `tailscale status --json`; null when Tailscale is not running. */
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

/**
 * The same setup code after every restart until the password is set, so the one the installer printed keeps working
 * after a reboot. Kept next to the key, readable only by the server's user.
 */
export function loadSetupCode(dataDir: string): string {
  const file = join(dataDir, "setup-code");
  if (existsSync(file)) {
    const kept = readFileSync(file, "utf8").trim();
    if (/^\d{6}$/.test(kept)) return kept;
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const code = setupCode();
  writeFileSync(file, code, { mode: 0o600 });
  return code;
}

/** Once the password is set the code opens nothing; its file goes. */
export function forgetSetupCode(dataDir: string): void {
  try {
    unlinkSync(join(dataDir, "setup-code"));
  } catch {
    // Already gone.
  }
}
