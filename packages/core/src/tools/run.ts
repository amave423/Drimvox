import { randomUUID } from "node:crypto";
import type { ToolHooks } from "../agent/tools";

/** A tool's work, shown as a call in the answer; a failure comes back to the model as "Error: …" rather than throwing. */
export function toolRunner(hooks: Pick<ToolHooks, "onCall">) {
  return async (name: string, input: string, work: () => Promise<string>): Promise<string> => {
    hooks.onCall({ callId: randomUUID(), name, input });
    try {
      return await work();
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
}
