import { tool, type ToolSet } from "ai";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolHooks } from "../agent/tools";
import { isIP } from "node:net";
import { isPrivateIp } from "../internet/web";

/** This computer and the local network only: loading someone else's site is an attack, not a test. */
export function isOwnAddress(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host.endsWith(".localhost") || (isIP(host) !== 0 && isPrivateIp(host));
  } catch {
    return false;
  }
}

const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : 0);

/**
 * How much a site or an API holds (docs/specs/tools.md, asked for): many users at once for a while, then how many
 * answers a second, how fast (median and slowest), how many failed. Only for addresses of this computer or the local
 * network, where the project runs.
 */
export function loadTools(hooks: Pick<ToolHooks, "onCall">): ToolSet {
  return {
    load_test: tool({
      description:
        "Load-test the project's own site or API running on this computer or the local network: `users` requests at once for `seconds`, then requests per second, response times (median, 95th, 99th percentile, slowest) and errors by status. Start the project first.",
      inputSchema: z.object({
        url: z.string().url(),
        users: z.number().int().min(1).max(500).optional().describe("Requests at the same time (default 20)"),
        seconds: z.number().int().min(2).max(120).optional().describe("How long (default 10)"),
        method: z.enum(["GET", "POST"]).optional(),
        body: z.string().max(100_000).optional().describe("For POST: the JSON body"),
      }),
      execute: async ({ url, users, seconds, method, body }, o: { abortSignal?: AbortSignal }) => {
        hooks.onCall({ callId: randomUUID(), name: "load_test", input: url });
        if (!isOwnAddress(url)) return "Error: only addresses of this computer or the local network (localhost, 127.0.0.1, 192.168.…) can be load-tested.";
        const n = users ?? 20;
        const until = Date.now() + (seconds ?? 10) * 1000;
        const times: number[] = [];
        const statuses = new Map<string, number>();
        const count = (k: string) => statuses.set(k, (statuses.get(k) ?? 0) + 1);
        const started = Date.now();
        const worker = async () => {
          while (Date.now() < until && !o.abortSignal?.aborted) {
            const t = performance.now();
            try {
              const res = await fetch(url, { method: method ?? "GET", body: method === "POST" ? (body ?? "{}") : undefined, headers: method === "POST" ? { "content-type": "application/json" } : undefined, signal: AbortSignal.timeout(30_000) });
              await res.arrayBuffer();
              count(String(res.status));
            } catch (err) {
              count(/timeout/i.test(String(err)) ? "timeout" : "no answer");
            }
            times.push(performance.now() - t);
          }
        };
        await Promise.all(Array.from({ length: n }, worker));
        const took = (Date.now() - started) / 1000;
        const sorted = [...times].sort((a, b) => a - b);
        const failed = [...statuses].filter(([k]) => !/^[23]/.test(k)).reduce((s, [, v]) => s + v, 0);
        const ms = (v: number) => `${Math.round(v)} ms`;
        return [
          `${times.length} requests in ${took.toFixed(1)} s with ${n} at once: ${(times.length / took).toFixed(1)} per second.`,
          `Response time: median ${ms(pct(sorted, 50))}, 95% under ${ms(pct(sorted, 95))}, 99% under ${ms(pct(sorted, 99))}, slowest ${ms(sorted.at(-1) ?? 0)}.`,
          `Answers: ${[...statuses].map(([k, v]) => `${k} × ${v}`).join(", ") || "none"}${failed ? ` — ${((failed / Math.max(times.length, 1)) * 100).toFixed(1)}% failed` : ""}.`,
        ].join("\n");
      },
    }),
  };
}
