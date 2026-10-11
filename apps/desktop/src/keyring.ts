import { safeStorage } from "electron";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface KeyFile {
  v: 1;
  /** True when `data` is encrypted by the OS (DPAPI on Windows, Keychain on macOS). */
  protected: boolean;
  data: string;
}

/**
 * Returns the 32-byte key the core uses to encrypt provider keys. It is created once and stored
 * next to the database, wrapped by the OS so copying the data folder to another machine or
 * another Windows user does not reveal the provider keys.
 */
export function loadSecretKey(dataDir: string): Buffer {
  const file = join(dataDir, "master.key");
  if (existsSync(file)) {
    const stored = JSON.parse(readFileSync(file, "utf8")) as KeyFile;
    const raw = Buffer.from(stored.data, "base64");
    const key = stored.protected ? Buffer.from(safeStorage.decryptString(raw), "base64") : raw;
    if (key.length !== 32) throw new Error("master.key is damaged");
    return key;
  }

  const key = randomBytes(32);
  const canProtect = safeStorage.isEncryptionAvailable();
  const stored: KeyFile = {
    v: 1,
    protected: canProtect,
    data: (canProtect ? safeStorage.encryptString(key.toString("base64")) : key).toString("base64"),
  };
  writeFileSync(file, JSON.stringify(stored), { mode: 0o600 });
  return key;
}
