import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import type { Database } from "../db";

const scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))));

/** Kept among the settings: only the salt and the scrypt hash, never the password. */
const PASSWORD_KEY = "auth.password";
const COST = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const SESSION_DAYS = 30;

interface Stored {
  salt: string;
  hash: string;
}

/** The server's password and sessions. Sessions are kept as hashes: a stolen database signs nobody in. */
export class AuthStore {
  constructor(private readonly db: Database) {}

  passwordSet(): boolean {
    return this.stored() !== null;
  }

  async setPassword(password: string): Promise<void> {
    const salt = randomBytes(16);
    const hash = await scrypt(password, salt, 32, COST);
    const value = JSON.stringify({ salt: salt.toString("base64"), hash: hash.toString("base64") } satisfies Stored);
    this.db.sql
      .prepare("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value")
      .run(PASSWORD_KEY, JSON.stringify(value));
  }

  async checkPassword(password: string): Promise<boolean> {
    const stored = this.stored();
    if (!stored) return false;
    const expected = Buffer.from(stored.hash, "base64");
    const given = await scrypt(password, Buffer.from(stored.salt, "base64"), expected.length, COST);
    return timingSafeEqual(given, expected);
  }

  /** A new session; the token goes into the cookie, its hash into the database. */
  openSession(): string {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.db.sql
      .prepare("insert into sessions (hash, created_at, expires_at) values (?, ?, ?)")
      .run(digest(token), now, now + SESSION_DAYS * 24 * 60 * 60_000);
    return token;
  }

  validSession(token: string | undefined): boolean {
    if (!token) return false;
    this.db.sql.prepare("delete from sessions where expires_at <= ?").run(Date.now());
    return this.db.sql.prepare("select 1 from sessions where hash = ?").get(digest(token)) !== undefined;
  }

  closeSession(token: string | undefined): void {
    if (token) this.db.sql.prepare("delete from sessions where hash = ?").run(digest(token));
  }

  /** After a password change: every other device has to sign in again. */
  closeOtherSessions(keep: string): void {
    this.db.sql.prepare("delete from sessions where hash <> ?").run(digest(keep));
  }

  private stored(): Stored | null {
    const row = this.db.sql.prepare("select value from settings where key = ?").get(PASSWORD_KEY) as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(JSON.parse(row.value) as string) as Stored;
    } catch {
      return null;
    }
  }
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
