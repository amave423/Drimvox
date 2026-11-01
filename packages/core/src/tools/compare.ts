import { tool, type ToolSet } from "ai";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { z } from "zod";
import type { ToolHooks } from "../agent/tools";
import type { BrowserDriver } from "../browser/driver";

/** Changes smaller than this share of the page count as none (anti-aliasing, a blinking caret). */
const NOISE = 0.001;

/**
 * Before and after (docs/specs/agent-browser.md, asked for): the page shown in the browser is kept as "before" under a
 * name, and later compared with how it looks now, pixel by pixel; where it changed is marked red on a picture, and a
 * model that sees says what changed.
 */
export function compareTools(
  driver: BrowserDriver,
  dir: string,
  hooks: Pick<ToolHooks, "onCall">,
  see?: (png: Buffer, question: string, signal?: AbortSignal) => Promise<string>,
): ToolSet {
  const file = (name: string, width: number, kind: "before" | "diff" | "after") => join(dir, `${name.replace(/[^\w.-]+/g, "_").slice(0, 60)}-${width}-${kind}.png`);
  const run = async (name: string, input: string, work: () => Promise<string>) => {
    hooks.onCall({ callId: randomUUID(), name, input });
    try {
      return await work();
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
  /** The whole page at a width, as a picture. */
  async function shoot(width: number): Promise<Buffer> {
    await driver.command("Emulation.setDeviceMetricsOverride", { width, height: width < 768 ? 844 : 900, deviceScaleFactor: 1, mobile: false });
    await new Promise((r) => setTimeout(r, 600));
    try {
      const size = (await driver.command("Runtime.evaluate", { expression: "[innerWidth, document.documentElement.scrollHeight]", returnByValue: true })) as { result: { value: [number, number] } };
      const [w, h] = size.result.value;
      const shot = (await driver.command("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: w, height: Math.min(h, 8000), scale: 1 }, captureBeyondViewport: true })) as { data: string };
      return Buffer.from(shot.data, "base64");
    } finally {
      await driver.command("Emulation.clearDeviceMetricsOverride").catch(() => {});
      await driver.restoreSize?.().catch(() => {});
    }
  }
  const width = z.number().int().min(320).max(1920).optional().describe("390 is a phone, 1280 a desktop (the default)");

  return {
    page_snapshot: tool({
      description: "Keep how the page shown in the browser looks now as \"before\", under a name (such as home), to compare with page_compare after a change.",
      inputSchema: z.object({ name: z.string().min(1).max(60), width }),
      execute: ({ name, width: w }) =>
        run("page_snapshot", name, async () => {
          mkdirSync(dir, { recursive: true });
          writeFileSync(file(name, w ?? 1280, "before"), await shoot(w ?? 1280));
          return `Kept "${name}" at ${w ?? 1280} px as before. After your change, call page_compare with the same name.`;
        }),
    }),
    page_compare: tool({
      description:
        "Compare the page shown in the browser now with the \"before\" kept by page_snapshot under the same name: how much changed and where, and what a model that sees says changed. Use it to catch layout that broke by accident.",
      inputSchema: z.object({ name: z.string().min(1).max(60), width }),
      execute: ({ name, width: w }, o: { abortSignal?: AbortSignal }) =>
        run("page_compare", name, async () => {
          const at = w ?? 1280;
          const beforePath = file(name, at, "before");
          if (!existsSync(beforePath)) throw new Error(`Nothing kept as "${name}" at ${at} px: call page_snapshot first.`);
          const before = PNG.sync.read(readFileSync(beforePath));
          const afterBytes = await shoot(at);
          const after = PNG.sync.read(afterBytes);
          // Pages of different heights: compared over the common part, the rest counts as changed.
          const width2 = Math.min(before.width, after.width);
          const height = Math.min(before.height, after.height);
          const crop = (img: PNG) => {
            const out = new PNG({ width: width2, height });
            PNG.bitblt(img, out, 0, 0, width2, height, 0, 0);
            return out;
          };
          const a = crop(before);
          const b = crop(after);
          const diff = new PNG({ width: width2, height });
          const changed = pixelmatch(a.data, b.data, diff.data, width2, height, { threshold: 0.1 });
          const share = changed / (width2 * height);
          writeFileSync(file(name, at, "after"), afterBytes);
          writeFileSync(file(name, at, "diff"), PNG.sync.write(diff));
          const heights = before.height !== after.height ? ` The page's height changed: ${before.height} → ${after.height} px.` : "";
          if (share < NOISE && !heights) return `No visible change at ${at} px.`;
          // Where the change is: the rows it spans, top to bottom.
          let top = -1;
          let bottom = -1;
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width2; x += 4) {
              const i = (y * width2 + x) * 4;
              if (diff.data[i] === 255 && diff.data[i + 1] === 0) {
                if (top < 0) top = y;
                bottom = y;
                break;
              }
            }
          }
          const where = top >= 0 ? ` Changed between ${top} and ${bottom} px from the top.` : "";
          const summary = `${(share * 100).toFixed(1)}% of the page changed at ${at} px.${where}${heights}`;
          if (!see) return summary;
          const said = await see(PNG.sync.write(diff), "This is a difference picture of a web page: red marks pixels that changed between before and after. Say briefly which parts of the page changed and whether it looks like a layout that broke.", o.abortSignal).catch(() => "");
          return said ? `${summary}\n${said}` : summary;
        }),
    }),
  };
}
