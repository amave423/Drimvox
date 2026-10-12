import { presets, type ModelInfo } from "@artel/shared";
import { ProviderFailure } from "../providers/errors";
import { catalogItems } from "../providers/native";
import type { Connection } from "../providers/repo";
import type { CliId } from "./kinds";
import { resolveCli } from "./resolve";

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
    pattern: /^google\/(gemini-[\d.]+-(?:pro|flash|flash-lite)(?:-preview)?)$/,
    id: (n) => n,
    fallback: ["pro", "flash", "flash-lite"],
  },
};

/** Not for writing code: pictures, speech, search and open-weight models a subscription does not include. */
const NOT_CODE = /image|audio|realtime|tts|transcribe|search|oss|embedding|chat-latest|codex-mini/i;
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
    // Artel cannot hand a CLI its screenshots, so it never looks at pages for the visual checks.
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
  if (!resolveCli(id)) throw new ProviderFailure({ code: "cli_missing", detail: presets[id].cli!.install });
  const vendor = VENDOR[id];
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
