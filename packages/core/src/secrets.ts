import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Encrypts provider keys at rest. The 32-byte key comes from the host (Electron safeStorage on desktop). */
export interface Cipher {
  encrypt(text: string): string;
  decrypt(blob: string): string;
}

const VERSION = "v1";

export function createCipher(key: Buffer): Cipher {
  if (key.length !== 32) throw new Error("Secret key must be 32 bytes");
  return {
    encrypt(text) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return [VERSION, iv, cipher.getAuthTag(), data].map((p) => (typeof p === "string" ? p : p.toString("base64"))).join(":");
    },
    decrypt(blob) {
      const [version, iv, tag, data] = blob.split(":");
      if (version !== VERSION || !iv || !tag || !data) throw new Error("Unknown secret format");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
    },
  };
}
