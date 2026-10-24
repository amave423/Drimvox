// CLI part of the live check (`--cli`): Claude Code, Codex and Gemini CLI that are installed and logged in answer
// in a chat and do the agent's task through the whole pipeline. Paid by the user's subscriptions, not by keys.
import type { ModelInfo, PresetId, ProviderView } from "@drimvox/shared";
import { checkAgent } from "./live-agent";

type Api = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
type Ask = (providerId: string, model: string, content: string) => Promise<{ status: string; content: string; inputTokens: number | null; error: unknown }>;

const CLIS: PresetId[] = ["claude-code", "codex", "gemini-cli"];

/** Returns [checked, failures]. A CLI that is not installed is skipped; one that is not logged in fails. */
export async function checkClis(api: Api, ask: Ask, log: (...p: unknown[]) => void, only?: string): Promise<[number, number]> {
  let checked = 0;
  let failures = 0;
  for (const preset of CLIS.filter((p) => !only || p === only)) {
    log(`\n=== ${preset} ===`);
    const provider = (await api("POST", "/providers", { preset })).body as ProviderView;
    const models = await api("GET", `/providers/${provider.id}/models`);
    if (models.status !== 200) {
      log("skipped:", models.body?.error);
      continue;
    }
    checked++;
    log(`models: ${(models.body as ModelInfo[]).map((m) => m.id).join(", ")}`);
    const answer = await ask(provider.id, "default", "Ответь одним словом: столица Франции?");
    log("chat:", { status: answer.status, text: answer.content.slice(0, 200), inputTokens: answer.inputTokens, error: answer.error });
    if (answer.status !== "done") {
      failures++;
      continue;
    }
    if (!(await checkAgent(api, provider.id, "default", log))) failures++;
  }
  return [checked, failures];
}
