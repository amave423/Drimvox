import type { ChecklistItem } from "@drimvox/shared";
import { tool, type ToolSet } from "ai";
import { z } from "zod";

export interface WorkToolHooks {
  checklist(): ChecklistItem[];
  setChecklist(items: ChecklistItem[]): void;
  /** A question the user sees at once; the agent goes on with its assumption. */
  ask(question: string, assumption: string): void;
  /** The work is done: the report ends the run. */
  finish(report: string, start: { command: string; url: string } | null): void;
  /** Before it is done, once: Drimvox's look at the result; notes for a round of polish, or null to finish. */
  review(start: { command: string; url: string } | null): Promise<string | null>;
  /** Before it is done, once: another model reads the code for security and access problems; the fixes to make, or null. */
  codeReview?(): Promise<string | null>;
  /** Before it is done, once: the skills the agent has not opened, which may be meant for this moment; null when none. */
  skillsLeft?(): string | null;
  onCall(name: string, input: string): void;
}

/** Trimmed to a length, with an ellipsis where it was cut. */
const clip = (text: string, max: number) => (text.trim().length > max ? `${text.trim().slice(0, max - 1).trimEnd()}…` : text.trim());

/** The agent's own tools for a project's run (docs/specs/project-work.md): its checklist, questions without waiting, the end. */
export function workTools(h: WorkToolHooks): ToolSet {
  return {
    update_checklist: tool({
      description:
        "Replace your checklist of the work with its new state: every item, short (a few words), with done marked. The user sees it next to the conversation. Mark items done as soon as they are, add items you discover, keep it under 30. Keep the items you have as they are: do not rename, merge or drop them, so the user can follow the progress.",
      // Generous limits, trimmed when kept: a long item should not lose the whole checklist (seen live with the plan).
      inputSchema: z.object({
        items: z.array(z.object({ text: z.string().max(2000), done: z.boolean() })).min(1).max(100),
      }),
      execute: async ({ items }) => {
        const clean = items
          .map((i) => ({ text: clip(i.text, 200), done: i.done }))
          .filter((i) => i.text)
          .slice(0, 40);
        h.setChecklist(clean);
        h.onCall("update_checklist", `${clean.filter((i) => i.done).length}/${clean.length}`);
        const open = clean.filter((i) => !i.done);
        return open.length ? `Checklist saved. Open: ${open.map((i) => i.text).join("; ")}.` : "Checklist saved: everything is done. Check the result once more, then call finish_work.";
      },
    }),
    ask_user: tool({
      description:
        "Ask the user something you cannot decide well yourself, without waiting: say what you assume meanwhile and go on with it. The user may answer later in the conversation; then follow the answer.",
      inputSchema: z.object({ question: z.string().min(1).max(5000), assumption: z.string().min(1).max(5000) }),
      execute: async ({ question, assumption }) => {
        h.ask(clip(question, 1000), clip(assumption, 1000));
        h.onCall("ask_user", question.trim());
        return "The user sees the question. Do not wait: go on with your assumption.";
      },
    }),
    finish_work: tool({
      description:
        "Call when the whole work is done and checked for real: every checklist item is done, the project starts, the pages look right and the main scenarios work. The report goes to the user.",
      inputSchema: z.object({
        report: z.string().min(1).max(40_000).describe("In the user's language: what is done, how to start it, what is worth knowing"),
        start: z
          .object({
            command: z.string().min(1).max(2000).describe("The one command that starts the result in the project's folder, such as npm run dev"),
            url: z.string().url().max(2000).describe("Where to open it once started, such as http://localhost:5173/"),
          })
          .optional()
          .describe("When the result is something to open (a site, a server): Drimvox starts it for the user"),
      }),
      execute: async ({ report, start }) => {
        const open = h.checklist().filter((i) => !i.done);
        if (open.length) return `These checklist items are not done: ${open.map((i) => i.text).join("; ")}. Finish them, or update the checklist if they are not needed, then call finish_work again.`;
        // Seen live: three skills were switched on and only one was ever opened, at the very start.
        const skills = h.skillsLeft?.();
        if (skills) return skills;
        // Seen live: a team board let anyone listen to any board over WebSocket; the coder's own tests never looked there.
        const fixes = await h.codeReview?.();
        if (fixes) return fixes;
        const site = start ? { command: clip(start.command, 500), url: start.url.trim() } : null;
        const polish = await h.review(site);
        if (polish) return polish;
        h.finish(clip(report, 8000), site);
        h.onCall("finish_work", "");
        return "Done. The user sees the report: stop now, write nothing more.";
      },
    }),
  };
}
