import { installCommand, type ModelInfo } from "@drimvox/shared";
import { ProviderFailure } from "../providers/errors";
import { catalogItems } from "../providers/native";
import type { Connection } from "../providers/repo";
import type { CliId } from "./kinds";
import { resolveCli } from "./resolve";
import { execFile } from "node:child_process";

/**
 * Which of the vendor's catalog models a CLI can be started with, and the name it takes on the command line.
 * Claude Code takes "claude-opus-4-8" for the catalog's "anthropic/claude-opus-4.8"; Codex and Gemini CLI take the name as it is.
 */
const VENDOR: Record<CliId, { pattern: RegExp; id(name: string): string; fallback: string[] }> = {
  "claude-code": {
    pattern: /^anthropic\/(claude-(?:opus|sonnet|haiku|fable)-[\d.]+)$/,
    id: (n) => n.replace(/\./g, "-"),
    fallback: ["fable", "opus", "sonnet", "haiku"],
  },
  codex: {
    pattern: /^openai\/(gpt-[\w.-]+)$/,
    id: (n) => n,
    fallback: [],
  },
  "gemini-cli": {
    // Any Gemini: names stopped following "pro" and "flash" (gemini-4-argon).
    pattern: /^google\/(gemini-[\w.-]+)$/,
    id: (n) => n,
    fallback: ["pro", "flash", "flash-lite"],
  },
  // Antigravity names its own models (`agy models`); the catalog is only the fallback.
  antigravity: {
    pattern: /^google\/(gemini-[\w.-]+)$/,
    id: (n) => n,
    fallback: [],
  },
};

/** `agy models`: one slug per line, maybe with a name after it; headers and blank lines are skipped. */
export function parseModelList(output: string): { id: string; name: string }[] {
  const found: { id: string; name: string }[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*[-*•]?\s*([a-z0-9][\w.:/-]*[\w])\s*(.*)$/i.exec(line);
    if (!m || !/[\d-]/.test(m[1]!) || m[1]!.endsWith(":") || /:\s*$/.test(line)) continue;
    if (!found.some((f) => f.id === m[1])) found.push({ id: m[1]!, name: m[2]!.replace(/^[-–—:|\s]+/, "").trim() || m[1]! });
  }
  return found;
}

function listByCli(argv: string[]): Promise<{ id: string; name: string }[]> {
  return new Promise((resolve) => {
    execFile(argv[0]!, [...argv.slice(1), "models"], { timeout: 20_000, windowsHide: true }, (err, stdout) => resolve(err ? [] : parseModelList(String(stdout))));
  });
}

/** Not for writing code: pictures, speech, search and open-weight models a subscription does not include. */
const NOT_CODE = /image|audio|realtime|tts|transcribe|search|oss|embedding|chat-latest|codex-mini|customtools|nano-banana|robotics|computer-use/i;
const NEWEST = 12;

/** The model a CLI picked by itself on its last run, per CLI; shown next to "default". */
const seen = new Map<CliId, string>();

export function rememberDefault(id: CliId, model: string): void {
  seen.set(id, model.replace(/\[.*\]$/, ""));
}

export function forgetDefaults(): void {
  seen.clear();
}

function info(id: string, name: string, resolved?: string | null): ModelInfo {
  return {
    id,
    name,
    contextLength: null,
    priceIn: 0,
    priceOut: 0,
    priceEstimated: false,
    tools: true,
    // Drimvox cannot hand a CLI its screenshots, so it never looks at pages for the visual checks.
    vision: false,
    ...(resolved !== undefined ? { resolved } : {}),
  };
}

/**
 * "Default" (whatever the CLI is set to) and the vendor's newest models by their real names, from OpenRouter's
 * public catalog. Without the catalog: the CLI's own aliases for the latest model of each family.
 */
export async function cliModels(conn: Connection & { preset: CliId }): Promise<ModelInfo[]> {
  const id = conn.preset;
  if (!resolveCli(id)) throw new ProviderFailure({ code: "cli_missing", detail: installCommand(id, process.platform)! });
  const vendor = VENDOR[id];
  if (id === "antigravity") {
    const own = await listByCli(resolveCli(id)!);
    if (own.length) {
      const last = seen.get(id);
      return [info("default", "Default", last ? (own.find((m) => m.id === last)?.name ?? last) : null), ...own.map((m) => info(m.id, m.name))];
    }
  }
  let listed: { id: string; name: string; created: number }[] = [];
  try {
    for (const item of await catalogItems(conn.fetch)) {
      const match = typeof item.id === "string" ? vendor.pattern.exec(item.id) : null;
      if (!match || NOT_CODE.test(match[1]!)) continue;
      const outputs = (item.architecture as { output_modalities?: unknown } | undefined)?.output_modalities;
      if (Array.isArray(outputs) && (outputs.length !== 1 || outputs[0] !== "text")) continue;
      const name = typeof item.name === "string" ? item.name.replace(/^[^:]+:\s*/, "") : match[1]!;
      listed.push({ id: vendor.id(match[1]!), name, created: typeof item.created === "number" ? item.created : 0 });
    }
  } catch {
    listed = [];
  }
  const last = seen.get(id);
  const resolved = last ? (listed.find((m) => m.id === last)?.name ?? last) : null;
  if (listed.length === 0) {
    return [info("default", "Default", resolved), ...vendor.fallback.map((a) => info(a, a[0]!.toUpperCase() + a.slice(1)))];
  }
  const newest = listed.sort((a, b) => b.created - a.created).slice(0, NEWEST);
  return [info("default", "Default", resolved), ...newest.map((m) => info(m.id, m.name))];
}
