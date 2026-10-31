import { tool, type ToolSet } from "ai";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import type { Browser } from "./browser";
import { placeScript } from "./page-scripts";
import type { ToolRun } from "./tools";

type Opts = { toolCallId: string; abortSignal?: AbortSignal };

/**
 * What the page did, kept by a script that runs before the page's own (docs/specs/agent-browser.md): its console, its
 * errors and its requests. Asked for: Chrome DevTools and Playwright built into Drimvox, so their servers can go.
 */
export const watchScript = (late: boolean) => `(() => {
  if (window.__dvx) return;
  const w = (window.__dvx = { log: [], net: [], late: ${late} });
  const cut = (v) => { try { return typeof v === "string" ? v : JSON.stringify(v); } catch { return String(v); } };
  const keep = (list, item) => { list.push(item); if (list.length > 300) list.shift(); };
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const own = console[level].bind(console);
    console[level] = (...args) => { keep(w.log, { level, text: args.map(cut).join(" ").slice(0, 2000), at: Date.now() }); own(...args); };
  }
  addEventListener("error", (e) => keep(w.log, { level: "error", text: ((e.message || "Error") + (e.filename ? " at " + e.filename + ":" + e.lineno : "")).slice(0, 2000), at: Date.now() }));
  addEventListener("unhandledrejection", (e) => keep(w.log, { level: "error", text: ("Unhandled promise rejection: " + cut(e.reason && (e.reason.stack || e.reason.message) || e.reason)).slice(0, 2000), at: Date.now() }));
  const ownFetch = window.fetch;
  if (ownFetch) window.fetch = async function (input, init) {
    const started = performance.now();
    const url = typeof input === "string" ? input : (input && input.url) || String(input);
    const method = (init && init.method) || (input && input.method) || "GET";
    try { const res = await ownFetch.apply(this, arguments); keep(w.net, { kind: "fetch", method, url, status: res.status, ms: Math.round(performance.now() - started) }); return res; }
    catch (err) { keep(w.net, { kind: "fetch", method, url, status: 0, error: String(err && err.message || err), ms: Math.round(performance.now() - started) }); throw err; }
  };
  const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) { this.__dvx = { method, url: String(url) }; return open.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    const r = this.__dvx, started = performance.now();
    if (r) this.addEventListener("loadend", () => keep(w.net, { kind: "xhr", method: r.method, url: r.url, status: this.status, ms: Math.round(performance.now() - started) }));
    return send.apply(this, arguments);
  };
})();`;

const NETWORK: Record<string, { offline: boolean; latency: number; downloadThroughput: number; uploadThroughput: number } | null> = {
  none: null,
  offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  "slow-3g": { offline: false, latency: 400, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8 },
  "fast-3g": { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
};
const DEVICE: Record<string, { width: number; height: number; scale: number; mobile: boolean } | null> = {
  desktop: null,
  phone: { width: 390, height: 844, scale: 3, mobile: true },
  tablet: { width: 820, height: 1180, scale: 2, mobile: true },
};

const PERF_SCRIPT = `new Promise((done) => {
  const nav = performance.getEntriesByType("navigation")[0] || {};
  const res = performance.getEntriesByType("resource");
  let lcp = 0, cls = 0;
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) lcp = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) cls += e.value; }).observe({ type: "layout-shift", buffered: true }); } catch {}
  setTimeout(() => done(JSON.stringify({
    ttfb: Math.round(nav.responseStart || 0), dom: Math.round(nav.domContentLoadedEventEnd || 0), load: Math.round(nav.loadEventEnd || 0),
    lcp: Math.round(lcp), cls: Math.round(cls * 1000) / 1000,
    requests: res.length + 1, bytes: Math.round(res.reduce((s, r) => s + (r.transferSize || 0), 0) + (nav.transferSize || 0)),
    heavy: res.map((r) => ({ url: r.name, bytes: r.transferSize || 0, ms: Math.round(r.duration) })).sort((a, b) => b.bytes - a.bytes).slice(0, 5),
    slow: res.map((r) => ({ url: r.name, ms: Math.round(r.duration) })).sort((a, b) => b.ms - a.ms).slice(0, 5),
    nodes: document.getElementsByTagName("*").length,
  })), 1200);
})`;

const AUDIT_SCRIPT = `JSON.stringify((() => {
  const name = (el) => (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").trim();
  const where = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : "");
  const out = [];
  for (const img of document.querySelectorAll("img")) if (!img.hasAttribute("alt")) out.push("Image without alt: " + (img.getAttribute("src") || "").slice(0, 120));
  for (const b of document.querySelectorAll("button, [role=button], a[href]")) if (!name(b) && !b.querySelector("img[alt]:not([alt=''])")) out.push("Control without a name: " + where(b));
  for (const i of document.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea")) {
    const labelled = i.labels && i.labels.length || i.getAttribute("aria-label") || i.getAttribute("aria-labelledby") || i.getAttribute("placeholder");
    if (!labelled) out.push("Field without a label: " + where(i));
  }
  if (!document.documentElement.lang) out.push("The page has no lang attribute");
  if (!document.title.trim()) out.push("The page has no title");
  const heads = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => Number(h.tagName[1]));
  if (!heads.includes(1)) out.push("No h1 heading");
  heads.forEach((n, i) => { if (i && n - heads[i - 1] > 1) out.push("Heading level skipped: h" + heads[i - 1] + " → h" + n); });
  const small = [...document.querySelectorAll("button, a[href], input, select")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24); });
  if (small.length) out.push(small.length + " controls smaller than 24×24 px (hard to tap), e.g. " + where(small[0]));
  return out.slice(0, 60);
})())`;

/**
 * Chrome DevTools and Playwright, built in (asked for): the console and errors, requests, a script in the page, a file
 * into a form, the page as a PDF, a phone or a slow network, speed and accessibility, hovering and waiting.
 */
export function devtoolsTools(browser: Browser, o: { folder?: string }, run: ToolRun, read: (signal?: AbortSignal) => Promise<string>): ToolSet {
  const d = browser.driver;

  async function evaluate(expression: string): Promise<unknown> {
    const r = (await d.command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "The script failed");
    return r.result?.value;
  }

  /** A path inside the project's folder; anything outside it is refused. */
  function inFolder(path: string): string {
    if (!o.folder) throw new Error("Files need a project folder");
    const full = isAbsolute(path) ? path : resolve(o.folder, path);
    const rel = relative(o.folder, full);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Only files inside the project folder");
    return full;
  }

  const ref = z.number().int().min(1).describe("The control's number from the last read, as in [3 button …]");
  const files: ToolSet = o.folder
    ? {
        browser_upload: tool({
          description: "Put files from the project folder into a file field of the page (an <input type=file>) by its number, then read the page.",
          inputSchema: z.object({ ref, paths: z.array(z.string().min(1).max(1000)).min(1).max(10).describe("Paths inside the project folder") }),
          execute: ({ ref: n, paths }, x: Opts) =>
            run(x.toolCallId, "browser_upload", paths.join(", "), async () => {
              const full = paths.map(inFolder);
              for (const f of full) if (!existsSync(f)) throw new Error(`No such file: ${f}`);
              const found = (await d.command("Runtime.evaluate", { expression: `(() => { const el = (window.__drimvoxRefs || [])[${n - 1}]; return el && el.tagName === "INPUT" && el.type === "file" ? el : null; })()` })) as {
                result?: { objectId?: string };
              };
              const objectId = found.result?.objectId;
              if (!objectId) throw new Error(`Control ${n} is not a file field; call browser_read for fresh numbers.`);
              await d.command("DOM.setFileInputFiles", { files: full, objectId });
              return read(x.abortSignal);
            }),
        }),
        browser_pdf: tool({
          description: "Save the page shown in the browser as a PDF file inside the project folder.",
          inputSchema: z.object({ path: z.string().min(1).max(1000).describe("Where to save it, inside the project folder, such as docs/page.pdf") }),
          execute: ({ path }, x: Opts) =>
            run(x.toolCallId, "browser_pdf", path, async () => {
              const full = inFolder(path.endsWith(".pdf") ? path : `${path}.pdf`);
              const pdf = (await d.command("Page.printToPDF", { printBackground: true })) as { data: string };
              mkdirSync(dirname(full), { recursive: true });
              writeFileSync(full, Buffer.from(pdf.data, "base64"));
              return `Saved ${relative(o.folder!, full).replace(/\\/g, "/")} (${Math.round((pdf.data.length * 3) / 4 / 1024)} KB).`;
            }),
        }),
      }
    : {};

  return {
    browser_console: tool({
      description:
        "The page's console and its errors since it opened (scripts that failed, unhandled promise rejections, warnings). Use it when a page does not work as it should.",
      inputSchema: z.object({ errors_only: z.boolean().optional() }),
      execute: ({ errors_only }, x: Opts) =>
        run(x.toolCallId, "browser_console", errors_only ? "errors" : "", async () => {
          const w = (await evaluate("window.__dvx ? { log: window.__dvx.log, late: window.__dvx.late } : null")) as { log: { level: string; text: string }[]; late: boolean } | null;
          if (!w) return "The console is not watched on this page yet: open it again with browser_open and look again.";
          const shown = errors_only ? w.log.filter((l) => l.level === "error" || l.level === "warn") : w.log;
          // The first page of a tab is watched from its first read: what it said while loading shows once it loads again.
          const late = w.late ? "\n\n(This page was watched only after it loaded: open it again with browser_open to see what it said while loading.)" : "";
          return (shown.length ? shown.map((l) => `[${l.level}] ${l.text}`).join("\n").slice(0, 12_000) : "The console is empty.") + late;
        }),
    }),
    browser_network: tool({
      description: "The page's requests: the scripts' fetch and XHR calls with their status and time, and every file it loaded. failed_only shows the ones that failed.",
      inputSchema: z.object({ failed_only: z.boolean().optional() }),
      execute: ({ failed_only }, x: Opts) =>
        run(x.toolCallId, "browser_network", failed_only ? "failed" : "", async () => {
          const calls = ((await evaluate("window.__dvx ? window.__dvx.net : []")) ?? []) as { kind: string; method: string; url: string; status: number; ms: number; error?: string }[];
          const resources = (await evaluate(
            "JSON.stringify(performance.getEntriesByType('resource').map((r) => ({ url: r.name, type: r.initiatorType, status: r.responseStatus || 0, ms: Math.round(r.duration), bytes: r.transferSize || 0 })))",
          )) as string;
          const loaded = JSON.parse(resources) as { url: string; type: string; status: number; ms: number; bytes: number }[];
          const bad = (s: number) => s === 0 || s >= 400;
          const callLines = calls.filter((c) => !failed_only || bad(c.status)).map((c) => `${c.method} ${c.url} → ${c.status || c.error || "failed"} (${c.ms} ms)`);
          const fileLines = loaded.filter((f) => !failed_only || (f.status && bad(f.status))).map((f) => `${f.type} ${f.url}${f.status ? ` → ${f.status}` : ""} (${f.ms} ms, ${Math.round(f.bytes / 1024)} KB)`);
          const text = [callLines.length ? `Calls:\n${callLines.join("\n")}` : "", fileLines.length ? `Loaded:\n${fileLines.join("\n")}` : ""].filter(Boolean).join("\n\n");
          return text.slice(0, 12_000) || (failed_only ? "No request failed." : "No requests.");
        }),
    }),
    browser_eval: tool({
      description: "Run JavaScript in the page and get its result as JSON (an expression, or an async function body with return). For what reading and clicking cannot do: storage, cookies, a value deep in the page.",
      inputSchema: z.object({ script: z.string().min(1).max(20_000) }),
      execute: ({ script }, x: Opts) =>
        run(x.toolCallId, "browser_eval", script.slice(0, 200), async () => {
          const body = /\breturn\b/.test(script) ? `(async () => { ${script} })()` : script;
          const value = await evaluate(`Promise.resolve(${body}).then((v) => { try { return JSON.stringify(v === undefined ? null : v); } catch { return String(v); } })`);
          return String(value ?? "null").slice(0, 12_000);
        }),
    }),
    browser_emulate: tool({
      description:
        "Make the browser behave as another device until reset: a phone or a tablet (touch, its screen), a slow or no network, a slower processor, a dark or light colour scheme. Then read the page.",
      inputSchema: z.object({
        device: z.enum(["phone", "tablet", "desktop"]).optional(),
        network: z.enum(["none", "fast-3g", "slow-3g", "offline"]).optional().describe("none: the real network"),
        cpu_slowdown: z.number().int().min(1).max(8).optional().describe("1: real speed, 4: a mid phone"),
        color_scheme: z.enum(["dark", "light", "system"]).optional(),
      }),
      execute: ({ device, network, cpu_slowdown, color_scheme }, x: Opts) =>
        run(x.toolCallId, "browser_emulate", [device, network, cpu_slowdown && `cpu×${cpu_slowdown}`, color_scheme].filter(Boolean).join(", "), async () => {
          if (device) {
            const dev = DEVICE[device];
            if (dev) {
              await d.command("Emulation.setDeviceMetricsOverride", { width: dev.width, height: dev.height, deviceScaleFactor: dev.scale, mobile: dev.mobile });
              await d.command("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
            } else {
              await d.command("Emulation.clearDeviceMetricsOverride");
              await d.command("Emulation.setTouchEmulationEnabled", { enabled: false });
              await d.restoreSize?.().catch(() => {});
            }
          }
          if (network) {
            await d.command("Network.enable");
            const net = NETWORK[network];
            await d.command("Network.emulateNetworkConditions", net ?? { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
          }
          if (cpu_slowdown) await d.command("Emulation.setCPUThrottlingRate", { rate: cpu_slowdown });
          if (color_scheme) await d.command("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: color_scheme === "system" ? "" : color_scheme }] });
          return read(x.abortSignal);
        }),
    }),
    browser_performance: tool({
      description:
        "Measure how fast the page loads: it is loaded again, then the time to the first byte, to the content, the largest content (LCP), layout shifts (CLS), the requests and the heaviest and slowest files. Use browser_emulate first to measure as a phone on a slow network.",
      inputSchema: z.object({}),
      execute: (_input, x: Opts) =>
        run(x.toolCallId, "browser_performance", "", async () => {
          await d.reload();
          await new Promise((r) => setTimeout(r, 400));
          for (let i = 0; i < 60; i++) {
            if ((await evaluate("document.readyState").catch(() => null)) === "complete") break;
            await new Promise((r) => setTimeout(r, 250));
          }
          const p = JSON.parse(String(await evaluate(PERF_SCRIPT))) as {
            ttfb: number; dom: number; load: number; lcp: number; cls: number; requests: number; bytes: number; nodes: number;
            heavy: { url: string; bytes: number }[]; slow: { url: string; ms: number }[];
          };
          await d.command("Performance.enable").catch(() => {});
          const metrics = (await d.command("Performance.getMetrics").catch(() => null)) as { metrics?: { name: string; value: number }[] } | null;
          const heap = metrics?.metrics?.find((m) => m.name === "JSHeapUsedSize")?.value;
          const mark = (v: number, good: number, poor: number) => (v <= good ? "good" : v <= poor ? "needs work" : "poor");
          return [
            `First byte: ${p.ttfb} ms · content ready: ${p.dom} ms · loaded: ${p.load} ms`,
            `Largest content (LCP): ${p.lcp} ms (${mark(p.lcp, 2500, 4000)}) · layout shifts (CLS): ${p.cls} (${mark(p.cls, 0.1, 0.25)})`,
            `Requests: ${p.requests} · transferred: ${Math.round(p.bytes / 1024)} KB · elements: ${p.nodes}${heap ? ` · script memory: ${Math.round(heap / 1024 / 1024)} MB` : ""}`,
            `Heaviest: ${p.heavy.map((h) => `${h.url} (${Math.round(h.bytes / 1024)} KB)`).join("; ") || "—"}`,
            `Slowest: ${p.slow.map((s) => `${s.url} (${s.ms} ms)`).join("; ") || "—"}`,
          ].join("\n");
        }),
    }),
    browser_audit: tool({
      description: "Check the page for common accessibility problems: images without alt text, controls and fields without names, headings out of order, tiny tap targets, no language or title.",
      inputSchema: z.object({}),
      execute: (_input, x: Opts) =>
        run(x.toolCallId, "browser_audit", "", async () => {
          const found = JSON.parse(String(await evaluate(AUDIT_SCRIPT))) as string[];
          return found.length ? found.map((f) => `- ${f}`).join("\n") : "No common accessibility problems found.";
        }),
    }),
    browser_hover: tool({
      description: "Move the pointer over a control by its number (menus and hints that open on hover), then read the page.",
      inputSchema: z.object({ ref }),
      execute: ({ ref: n }, x: Opts) =>
        run(x.toolCallId, "browser_hover", String(n), async () => {
          const at = JSON.parse(String(await evaluate(placeScript(n)))) as { x?: number; y?: number; error?: string };
          if (at.error) throw new Error(`There is no visible control ${n} now; call browser_read for fresh numbers.`);
          await d.command("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y, button: "none", buttons: 0 });
          return read(x.abortSignal);
        }),
    }),
    browser_wait: tool({
      description: "Wait until a text appears on the page (or disappears, with gone), 30 seconds at most, then read the page.",
      inputSchema: z.object({ text: z.string().min(1).max(300), gone: z.boolean().optional(), seconds: z.number().int().min(1).max(30).optional() }),
      execute: ({ text, gone, seconds }, x: Opts) =>
        run(x.toolCallId, "browser_wait", text, async () => {
          const until = Date.now() + (seconds ?? 30) * 1000;
          for (;;) {
            const has = (await evaluate(`(document.body ? document.body.innerText : "").includes(${JSON.stringify(text)})`).catch(() => false)) as boolean;
            if (has !== !!gone) return read(x.abortSignal);
            if (Date.now() > until || x.abortSignal?.aborted) throw new Error(`"${text}" did not ${gone ? "go away" : "appear"} in ${seconds ?? 30} s.`);
            await new Promise((r) => setTimeout(r, 500));
          }
        }),
    }),
    ...files,
  };
}
