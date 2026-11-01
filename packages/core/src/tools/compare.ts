import { tool, type ToolSet } from "ai";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { z } from "zod";
import type { ToolHooks } from "../agent/tools";
import type { BrowserDriver } from "../browser/driver";
import type { Workspace } from "../agent/workspace";
import { resize } from "./images";

/** Mermaid, pinned, loaded by the page that draws a diagram. */
const MERMAID = "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js";

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
  ws?: Workspace,
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
    ...(ws
      ? {
          page_match_design: tool({
            description:
              "Compare the page shown in the browser with a design picture in the folder (a PNG exported from Figma or a mock-up): the design is scaled to the page's width, then how much differs and where, a difference picture, and what a model that sees says differs (spacing, sizes, colours, missing parts).",
            inputSchema: z.object({ design: z.string().min(1).describe("The design's PNG in the folder"), width: z.number().int().min(320).max(1920).optional().describe("The page's width to compare at: the design's own width by default") }),
            execute: ({ design, width: w }, o: { abortSignal?: AbortSignal }) =>
              run("page_match_design", design, async () => {
                const mock = PNG.sync.read(readFileSync(ws.resolve(design)));
                const at = w ?? Math.min(1920, Math.max(320, mock.width));
                const page = PNG.sync.read(await shoot(at));
                const scaled = mock.width === page.width ? mock : resize(mock, page.width, Math.round((mock.height * page.width) / mock.width));
                const height = Math.min(scaled.height, page.height);
                const crop = (img: PNG) => {
                  const out = new PNG({ width: page.width, height });
                  PNG.bitblt(img, out, 0, 0, page.width, height, 0, 0);
                  return out;
                };
                const a = crop(scaled);
                const b = crop(page);
                const diff = new PNG({ width: page.width, height });
                const changed = pixelmatch(a.data, b.data, diff.data, page.width, height, { threshold: 0.15 });
                mkdirSync(dir, { recursive: true });
                const diffFile = join(dir, `design-${Date.now()}-diff.png`);
                writeFileSync(diffFile, PNG.sync.write(diff));
                // Where it differs most: the page in eight bands, top to bottom.
                const bands = Array.from({ length: 8 }, () => 0);
                for (let y = 0; y < height; y++) {
                  for (let x = 0; x < page.width; x += 2) {
                    const i = (y * page.width + x) * 4;
                    if (diff.data[i] === 255 && diff.data[i + 1] === 0) bands[Math.min(7, Math.floor((y / height) * 8))]!++;
                  }
                }
                const worst = bands.map((n, i) => ({ n, i })).sort((x, y) => y.n - x.n).filter((x) => x.n > 0).slice(0, 3).map((x) => `${Math.round((x.i / 8) * height)}–${Math.round(((x.i + 1) / 8) * height)} px`);
                const heights = Math.abs(scaled.height - page.height) > 20 ? ` The page is ${page.height} px tall, the design ${scaled.height} px at this width.` : "";
                const summary = `${((changed / (page.width * height)) * 100).toFixed(1)}% differs from the design at ${page.width} px.${worst.length ? ` Most in: ${worst.join(", ")} from the top.` : ""}${heights}`;
                if (!see) return summary;
                const said = await see(PNG.sync.write(diff), "This is a difference picture between a design and the built web page: red marks pixels that differ. Say briefly which parts differ and how (spacing, sizes, colours, missing or extra parts).", o.abortSignal).catch(() => "");
                return said ? `${summary}\n${said}` : summary;
              }),
          }),
          render_diagram: tool({
            description:
              "Draw a diagram from Mermaid code (flowchart, sequence, class, ER, gantt, state…) and save it in the folder as .svg or .png — for the README, a report or docs.",
            inputSchema: z.object({ code: z.string().min(1).max(50_000).describe("Mermaid code, such as: flowchart LR; A-->B"), output: z.string().min(1).describe("Where to save, inside the folder: .svg or .png") }),
            execute: ({ code, output }) =>
              run("render_diagram", output, async () => {
                const page = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#fff"><pre class="mermaid">${code.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre><script src="${MERMAID}"></script><script>mermaid.initialize({ startOnLoad: false, theme: "default" }); mermaid.run().then(() => (document.body.dataset.done = "1")).catch((e) => (document.body.dataset.error = String(e && e.message || e)));</script></body></html>`;
                const before = driver.state().active;
                await driver.newTab(`data:text/html;base64,${Buffer.from(page).toString("base64")}`);
                const tab = driver.state().active;
                try {
                  let state: { done?: string; error?: string } = {};
                  for (let i = 0; i < 80 && !state.done && !state.error; i++) {
                    await new Promise((r) => setTimeout(r, 250));
                    const r = (await driver.command("Runtime.evaluate", { expression: "({ done: document.body.dataset.done, error: document.body.dataset.error })", returnByValue: true }).catch(() => null)) as { result?: { value?: typeof state } } | null;
                    state = r?.result?.value ?? {};
                  }
                  if (state.error) throw new Error(`Mermaid could not draw it: ${state.error}`);
                  if (!state.done) throw new Error("The diagram did not draw in time (it needs the internet for Mermaid the first time).");
                  const target = ws.resolve(output);
                  mkdirSync(dirname(target), { recursive: true });
                  if (extname(target).toLowerCase() === ".svg") {
                    const svg = (await driver.command("Runtime.evaluate", { expression: "document.querySelector('.mermaid svg').outerHTML", returnByValue: true })) as { result: { value: string } };
                    writeFileSync(target, svg.result.value);
                  } else {
                    const box = (await driver.command("Runtime.evaluate", { expression: "(() => { const r = document.querySelector('.mermaid svg').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()", returnByValue: true })) as { result: { value: [number, number, number, number] } };
                    const [x, y, w, h] = box.result.value;
                    const shot = (await driver.command("Page.captureScreenshot", { format: "png", clip: { x, y, width: Math.ceil(w), height: Math.ceil(h), scale: 2 }, captureBeyondViewport: true })) as { data: string };
                    writeFileSync(target, Buffer.from(shot.data, "base64"));
                  }
                  return `Saved ${output}.`;
                } finally {
                  // Back to the page the agent was on: its tab is shown again, the diagram's is gone.
                  if (tab && tab !== before) await driver.close(tab).catch(() => {});
                  if (before && driver.state().active !== before) await driver.select(before).catch(() => {});
                }
              }),
          }),
        }
      : {}),
  };
}
