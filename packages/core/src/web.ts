import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { Handler } from "hono";

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** The UI loads nothing from the network: fonts are bundled, the API is same-origin. */
const csp =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; " +
  "img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

/** Serves the built UI. Paths without an extension are app routes and get index.html. */
export function webHandler(root: string): Handler {
  const base = resolve(root);
  const index = join(base, "index.html");

  return async (c) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.notFound();
    }
    const target = resolve(base, `.${path}`);
    const inside = target.startsWith(base + sep);
    const isFile = inside && existsSync(target) && statSync(target).isFile();

    let file = target;
    if (!isFile) {
      if (extname(path)) return c.notFound();
      file = index;
    }
    const body = await readFile(file);
    const headers: Record<string, string> = {
      "Content-Type": contentTypes[extname(file)] ?? "application/octet-stream",
      "Cache-Control": file === index ? "no-cache" : "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    };
    if (file === index) headers["Content-Security-Policy"] = csp;
    return c.body(new Uint8Array(body), 200, headers);
  };
}
