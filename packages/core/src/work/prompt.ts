import type { BacklogItem, ProjectPlan } from "@artel/shared";
import { designInstructions } from "../agent/design";

/** Steps one answer on a task may take: enough for a task of the list; past it, "go on" continues. */
export const WORK_STEPS = 200;

/**
 * What the agent is told in a task's conversation, besides the chat's own folder text (docs/specs/project-work.md).
 * Seen in the live run: files and page addresses in transliterated Russian, a project that did not start after it was
 * accepted (no dependencies installed), half a task done.
 */
export function workRules(plan: ProjectPlan | null): string {
  return [
    "You are doing one task of the user's project list, right in the project's folder, as a careful senior engineer would.",
    "Work in a loop: read what you need, change it, run it, look at it, check it. Use read_file and search to read code;",
    "edit_file for changes, write_file for new files. Keep files under ~400 lines: split by responsibility.",
    "Rules:",
    "- Names in code are English: files, folders, page addresses, variables, functions (calculator, /cart). Never transliterate",
    "  another language into Latin letters. Text the visitor reads stays in the user's language.",
    "- The project must start for the user with one command. Install the dependencies yourself (npm install, pip install …),",
    "  make sure the usual command (npm run dev, or what the project uses) starts without errors: run it in the background",
    "  with start_background, read its output, stop it when done. Say in the end how to run it.",
    "- Do the whole task: before you stop, go through every \"done when\" point and check it for real (run, open, look).",
    "- When there is an interface, start it and use look_at_page on a desktop width and a phone width (390).",
    "- Run the project's build and tests when it has them; fix what fails.",
    "- Never commit or push: the user accepts the task, and Artel commits it.",
    "- Keep the project's notes current with update_notes: commands, decisions, what is done.",
    "End with a short report in the user's language: each \"done when\" point and how it is met, and how to run the project.",
    ...(plan?.checks.length ? [`The project's checks: ${plan.checks.join("; ")}`] : []),
    ...(plan?.pages.length ? [`Pages: ${plan.pages.map((p) => `${p.url}${p.command ? ` (served by: ${p.command})` : ""}`).join("; ")}`] : []),
    ...(plan?.design ? [designInstructions(plan.design)] : []),
  ].join("\n");
}

/** The first message of a task's conversation: the task, its points and what the project is about. */
export function workMessage(item: BacklogItem, plan: ProjectPlan | null): string {
  return [
    item.title,
    "",
    "Готово, когда:",
    ...item.done.map((d) => `- ${d}`),
    ...(plan?.design ? ["- Выглядит по дизайн-брифу проекта на компьютере и телефоне"] : []),
    ...(plan?.context ? ["", `О проекте: ${plan.context}`] : []),
  ].join("\n");
}
