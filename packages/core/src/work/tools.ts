import type { ChecklistItem } from "@artel/shared";
import { tool, type ToolSet } from "ai";
import { z } from "zod";

export interface WorkToolHooks {
  checklist(): ChecklistItem[];
  setChecklist(items: ChecklistItem[]): void;
  /** A question the user sees at once; the agent goes on with its assumption. */
  ask(question: string, assumption: string): void;
  /** The work is done: the report ends the run. */
  finish(report: string): void;
  onCall(name: string, input: string): void;
}

/** The agent's own tools for a project's run (docs/specs/project-work.md): its checklist, questions without waiting, the end. */
export function workTools(h: WorkToolHooks): ToolSet {
  return {
    update_checklist: tool({
      description:
        "Replace your checklist of the work with its new state: every item, short (a few words), with done marked. The user sees it next to the conversation. Mark items done as soon as they are, add items you discover, keep it under 30.",
      inputSchema: z.object({
        items: z.array(z.object({ text: z.string().min(1).max(200), done: z.boolean() })).min(1).max(40),
      }),
      execute: async ({ items }) => {
        const clean = items.map((i) => ({ text: i.text.trim(), done: i.done })).filter((i) => i.text);
        h.setChecklist(clean);
        h.onCall("update_checklist", `${clean.filter((i) => i.done).length}/${clean.length}`);
        const open = clean.filter((i) => !i.done);
        return open.length ? `Checklist saved. Open: ${open.map((i) => i.text).join("; ")}.` : "Checklist saved: everything is done. Check the result once more, then call finish_work.";
      },
    }),
    ask_user: tool({
      description:
        "Ask the user something you cannot decide well yourself, without waiting: say what you assume meanwhile and go on with it. The user may answer later in the conversation; then follow the answer.",
      inputSchema: z.object({ question: z.string().min(1).max(1000), assumption: z.string().min(1).max(1000) }),
      execute: async ({ question, assumption }) => {
        h.ask(question.trim(), assumption.trim());
        h.onCall("ask_user", question.trim());
        return "The user sees the question. Do not wait: go on with your assumption.";
      },
    }),
    finish_work: tool({
      description:
        "Call when the whole work is done and checked for real: every checklist item is done, the project starts, the pages look right and the main scenarios work. The report goes to the user.",
      inputSchema: z.object({
        report: z.string().min(1).max(8000).describe("In the user's language: what is done, how to start it, what is worth knowing"),
      }),
      execute: async ({ report }) => {
        const open = h.checklist().filter((i) => !i.done);
        if (open.length) return `These checklist items are not done: ${open.map((i) => i.text).join("; ")}. Finish them, or update the checklist if they are not needed, then call finish_work again.`;
        h.finish(report.trim());
        h.onCall("finish_work", "");
        return "Done. Write the report to the user now, in a few lines, and stop.";
      },
    }),
  };
}
