import { tool, type ToolSet } from "ai";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PNG } from "pngjs";
import { z } from "zod";
import type { ToolHooks } from "../agent/tools";
import type { Workspace } from "../agent/workspace";

/** A picture scaled to a size with bilinear filtering, the alpha kept. */
export function resize(src: PNG, width: number, height: number): PNG {
  const out = new PNG({ width, height });
  const sx = src.width / width;
  const sy = src.height / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.min(src.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(src.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(src.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(src.width - 1, x0 + 1);
      const wx = fx - x0;
      for (let c = 0; c < 4; c++) {
        const at = (xx: number, yy: number) => src.data[(yy * src.width + xx) * 4 + c]!;
        const v = (at(x0, y0) * (1 - wx) + at(x1, y0) * wx) * (1 - wy) + (at(x0, y1) * (1 - wx) + at(x1, y1) * wx) * wy;
        out.data[(y * width + x) * 4 + c] = Math.round(v);
      }
    }
  }
  return out;
}

/** A canvas of a size, filled with a colour (#rrggbb) or transparent, with the picture fitted in the middle at `share`. */
export function placed(logo: PNG, width: number, height: number, share: number, background: string | null): PNG {
  const out = new PNG({ width, height });
  const rgb = background ? [1, 3, 5].map((i) => parseInt(background.slice(i, i + 2), 16)) : null;
  for (let i = 0; i < width * height; i++) {
    if (rgb) [out.data[i * 4], out.data[i * 4 + 1], out.data[i * 4 + 2], out.data[i * 4 + 3]] = [rgb[0]!, rgb[1]!, rgb[2]!, 255];
  }
  const scale = Math.min((width * share) / logo.width, (height * share) / logo.height);
  const w = Math.max(1, Math.round(logo.width * scale));
  const h = Math.max(1, Math.round(logo.height * scale));
  const small = resize(logo, w, h);
  const left = Math.round((width - w) / 2);
  const top = Math.round((height - h) / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const d = ((top + y) * width + left + x) * 4;
      const a = small.data[s + 3]! / 255;
      for (let c = 0; c < 3; c++) out.data[d + c] = Math.round(small.data[s + c]! * a + out.data[d + c]! * (1 - a));
      out.data[d + 3] = Math.max(out.data[d + 3]!, small.data[s + 3]!);
    }
  }
  return out;
}

/** A .ico holding PNG pictures (every browser and Windows read these). */
export function ico(pngs: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6 + pngs.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach((p, i) => {
    const e = 6 + i * 16;
    header.writeUInt8(p.size >= 256 ? 0 : p.size, e);
    header.writeUInt8(p.size >= 256 ? 0 : p.size, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(p.data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += p.data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

/**
 * Icons and a link preview from one logo (docs/specs/tools.md, asked for): favicons of every size and an .ico, the
 * phone and app icons, a 1200×630 picture for links shared in messengers, and the tags to put in the page.
 */
export function imageTools(ws: Workspace, hooks: Pick<ToolHooks, "onCall">): ToolSet {
  return {
    icons_from_logo: tool({
      description:
        "Make a site's icons from a PNG logo in the folder (best square, at least 512 px): favicon.ico, favicon-16x16.png, favicon-32x32.png, apple-touch-icon.png, icon-192.png, icon-512.png, site.webmanifest, and og-image.png (1200×630, the logo on the background colour) for link previews. Answers with the tags for the page's <head>. For an SVG or JPG logo, convert it to PNG first.",
      inputSchema: z.object({
        logo: z.string().min(1).describe("The PNG logo in the folder"),
        out_dir: z.string().optional().describe("Where to put them, inside the folder (default: public)"),
        background: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("The colour behind the logo on the phone icon and the preview, such as #ffffff"),
        name: z.string().max(60).optional().describe("The site's name, for site.webmanifest"),
      }),
      execute: async ({ logo, out_dir, background, name }) => {
        hooks.onCall({ callId: randomUUID(), name: "icons_from_logo", input: logo });
        try {
          const src = PNG.sync.read(readFileSync(ws.resolve(logo)));
          const dir = ws.resolve(out_dir ?? "public");
          mkdirSync(dir, { recursive: true });
          const bg = background ?? "#ffffff";
          const save = (file: string, png: PNG) => {
            const data = PNG.sync.write(png);
            writeFileSync(join(dir, file), data);
            return data;
          };
          const icon = (size: number) => placed(src, size, size, 1, null);
          const ico16 = save("favicon-16x16.png", icon(16));
          const ico32 = save("favicon-32x32.png", icon(32));
          const ico48 = PNG.sync.write(icon(48));
          writeFileSync(join(dir, "favicon.ico"), ico([{ size: 16, data: ico16 }, { size: 32, data: ico32 }, { size: 48, data: ico48 }]));
          save("apple-touch-icon.png", placed(src, 180, 180, 0.8, bg));
          save("icon-192.png", icon(192));
          save("icon-512.png", icon(512));
          save("og-image.png", placed(src, 1200, 630, 0.45, bg));
          const base = `/${relative(ws.resolve("public"), dir).replace(/\\/g, "/")}`.replace(/\/$/, "").replace(/^\/\.\.?.*$/, "");
          writeFileSync(
            join(dir, "site.webmanifest"),
            JSON.stringify({ name: name ?? "", short_name: name ?? "", icons: [{ src: `${base}/icon-192.png`, sizes: "192x192", type: "image/png" }, { src: `${base}/icon-512.png`, sizes: "512x512", type: "image/png" }], theme_color: bg, background_color: bg, display: "standalone" }, null, 2),
          );
          const small = src.width < 512 || src.height < 512 ? `\nNote: the logo is ${src.width}×${src.height}; the big icons are blurry below 512 px.` : "";
          return [
            `Made in ${relative(ws.root, dir).replace(/\\/g, "/") || "."}: favicon.ico, favicon-16x16.png, favicon-32x32.png, apple-touch-icon.png, icon-192.png, icon-512.png, og-image.png, site.webmanifest.${small}`,
            "For the <head>:",
            `<link rel="icon" href="${base}/favicon.ico" sizes="any">`,
            `<link rel="icon" type="image/png" sizes="32x32" href="${base}/favicon-32x32.png">`,
            `<link rel="apple-touch-icon" href="${base}/apple-touch-icon.png">`,
            `<link rel="manifest" href="${base}/site.webmanifest">`,
            `<meta property="og:image" content="${base}/og-image.png">`,
          ].join("\n");
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
  };
}
