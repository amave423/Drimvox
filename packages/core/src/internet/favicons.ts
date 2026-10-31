import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { hostOf } from "./blocked";
import { isPublicAddress } from "./web";

const MAX_BYTES = 200_000;
/** A site without a mark is asked again after a day, not on every chat opened. */
const MISS_MS = 24 * 60 * 60_000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

const TYPES: Record<string, string> = { png: "image/png", ico: "image/x-icon", svg: "image/svg+xml", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** What a picture's first bytes say it is; null for something that is not a picture (an error page). */
export function pictureType(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes[0] === 0 && bytes[1] === 0 && (bytes[2] === 1 || bytes[2] === 2) && bytes[3] === 0) return "ico";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  if (bytes.subarray(0, 4).toString() === "GIF8") return "gif";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "webp";
  if (/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(bytes.subarray(0, 300).toString())) return "svg";
  return null;
}

/** The icon a page names in its head (`<link rel="icon" href>`), as an absolute address; null when it names none. */
export function iconInPage(html: string, base: string): string | null {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\brel=["']?[^"'>]*\bicon\b/i.test(tag) || /mask-icon/i.test(tag)) continue;
    const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    try {
      return new URL(href.replace(/&amp;/g, "&"), base).toString();
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * The marks of the sites links point to (asked for: every link, not only the few drawn into the app). Each site is
 * asked for its own icon — no third-party icon service learns what the chat is about — and kept on disk.
 */
export class Favicons {
  private readonly pending = new Map<string, Promise<{ bytes: Buffer; type: string } | null>>();

  constructor(
    private readonly dir: string,
    private readonly fetchFor: (host: string) => typeof fetch = () => fetch,
    /** The addresses a name points at; tests give their own. */
    private readonly resolve: (host: string) => Promise<string[]> = (host) =>
      Promise.race([lookup(host, { all: true }).then((a) => a.map((x) => x.address)), new Promise<string[]>((r) => setTimeout(() => r([]), 3000))]).catch(() => []),
  ) {}

  async get(url: string): Promise<{ bytes: Buffer; type: string } | null> {
    const host = hostOf(url);
    if (!host || !isPublicAddress(`https://${host}/`)) return null;
    const known = this.cached(host);
    if (known !== undefined) return known;
    let run = this.pending.get(host);
    if (!run) {
      run = this.fetchIcon(host).finally(() => this.pending.delete(host));
      this.pending.set(host, run);
    }
    return run;
  }

  /** From the disk: the icon, null for a site known to have none lately, undefined when not asked yet. */
  private cached(host: string): { bytes: Buffer; type: string } | null | undefined {
    for (const ext of Object.keys(TYPES)) {
      const path = join(this.dir, `${host}.${ext}`);
      if (existsSync(path)) return { bytes: readFileSync(path), type: TYPES[ext]! };
    }
    const miss = join(this.dir, `${host}.none`);
    if (existsSync(miss) && Date.now() - statSync(miss).mtimeMs < MISS_MS) return null;
    return undefined;
  }

  private async fetchIcon(host: string): Promise<{ bytes: Buffer; type: string } | null> {
    if (!isIP(host)) {
      // A public name may still point at this computer's network.
      const addresses = await this.resolve(host);
      if (addresses.some((a) => !isPublicAddress(`http://${a.includes(":") ? `[${a}]` : a}/`))) return null;
    }
    const f = this.fetchFor(host);
    const tryIcon = async (url: string) => {
      const res = await f(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000), redirect: "follow" }).catch(() => null);
      if (!res?.ok) return null;
      const bytes = Buffer.from(await res.arrayBuffer());
      const type = bytes.length <= MAX_BYTES ? pictureType(bytes) : null;
      return type ? { bytes, type } : null;
    };
    let found = await tryIcon(`https://${host}/favicon.ico`);
    if (!found) {
      // The page itself names its icon.
      const res = await f(`https://${host}/`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000), redirect: "follow" }).catch(() => null);
      const html = res?.ok ? (await res.text().catch(() => "")).slice(0, 200_000) : "";
      const named = html ? iconInPage(html, res!.url || `https://${host}/`) : null;
      if (named && isPublicAddress(named)) found = await tryIcon(named);
    }
    mkdirSync(this.dir, { recursive: true });
    if (!found) {
      writeFileSync(join(this.dir, `${host}.none`), "");
      return null;
    }
    writeFileSync(join(this.dir, `${host}.${found.type}`), found.bytes);
    return { bytes: found.bytes, type: TYPES[found.type]! };
  }
}
