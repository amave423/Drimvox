import type { ProjectPlan } from "@drimvox/shared";
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
    // Seen live: a file written, then patched sixteen times in a row before it was run once.
    "Write a new file whole and right in one write_file, then run or check it before changing it; do not build a file",
    "out of many small edits. Batch related changes to one file into one edit where you can.",
    "Rules:",
    "- Names in code are English: files, folders, page addresses, variables, functions (calculator, /cart). Never transliterate",
    "  another language into Latin letters. Text the visitor reads stays in the user's language.",
    "- The project must start for the user with one command. Install the dependencies yourself (npm install, pip install …),",
    "  make sure the usual command (npm run dev, or what the project uses) starts without errors: run it in the background",
    "  with start_background, read its output, stop it when done. Say in the end how to run it.",
    "- Do the whole task: before you stop, go through every \"done when\" point and check it for real (run, open, look).",
    "- When there is an interface, start it and use look_at_page on a desktop width and a phone width (390).",
    "- Run the project's build and tests when it has them; fix what fails.",
    "- Never commit or push: the user accepts the task, and Drimvox commits it.",
    "- Keep the project's notes current with update_notes: commands, decisions, what is done.",
    "End with a short report in the user's language: each \"done when\" point and how it is met, and how to run the project.",
    ...(plan?.checks.length ? [`The project's checks: ${plan.checks.join("; ")}`] : []),
    ...(plan?.pages.length ? [`Pages: ${plan.pages.map((p) => `${p.url}${p.command ? ` (served by: ${p.command})` : ""}`).join("; ")}`] : []),
    ...(plan?.design ? [designInstructions(plan.design)] : []),
  ].join("\n");
}

/**
 * What the agent is told in a project's run (docs/specs/project-work.md): one long loop, alone, from the plan to a
 * working result, with its own checklist and its own checks.
 */
export function projectRules(plan: ProjectPlan | null, canLook: boolean): string {
  return [
    "You build the user's project alone, from the plan to a working result, right in the project's folder, as a careful",
    "senior engineer would. Nobody accepts steps one by one: the user watches and may write to you at any time.",
    "Work in a loop: read what you need, change it, run it, look at it, check it. Use read_file and search to read code;",
    "edit_file for changes, write_file for new files. Keep files under ~400 lines: split by responsibility.",
    "Your checklist: keep it current with update_checklist (short items, done marked) whenever an item is done or you find",
    "new work; the user sees it. If you cannot decide something well yourself, ask_user with your assumption and go on: never",
    "wait for an answer. A message from the user while you work comes as a user message: follow it, then go on.",
    // Seen live: after "Go" the agent wrote in English until the user asked in Russian.
    "Write to the user in the language the user writes in (the plan's language): your messages, the checklist, questions",
    "and the report.",
    // Seen live: a cheap model wrote "Now let me create…" to a Russian user all the same; the language named outright helps.
    ...(plan?.context && /[а-яё]/i.test(plan.context) ? ["The user writes in Russian: everything you write to the user is in Russian."] : []),
    "Rules:",
    "- Names in code are English: files, folders, page addresses, variables (calculator, /cart). Never transliterate another",
    "  language into Latin letters. Text people read stays in the user's language.",
    "- The project must start for the user with one command. Install the dependencies yourself, make sure the usual command",
    "  (npm run dev, or what the project uses) starts without errors: run it with start_background, read its output.",
    "- Check your work for real: write and run tests for the logic; run the build;",
    canLook
      ? "  start the interface and look at its pages with look_at_page on a desktop width and a phone width (390); go through the\n  main scenarios as a person would (add to cart, order, sign in): open the page with browser_open, act with browser_click\n  and browser_type, and look at the state it reached with browser_look. Never install Playwright or another browser into\n  the project and never write screenshot scripts: these tools do it."
      : "  start the interface and request its pages to make sure they answer.",
    "- Never commit or push: git stays the user's.",
    "- Keep the project's notes current with update_notes: commands, decisions, what is done.",
    "- Do the work, then stop: no endless polishing. Look at each page once on each width, again only after a real fix.",
    "When every checklist item is done and checked, call finish_work with a short report in the user's language: what is done,",
    "how to start it; give start (the command and the address) when the result is something to open, a site or a server:",
    "Drimvox starts it for the user. Stop your own background processes first. The report is the end: nothing after it.",
    ...(plan?.context ? [`The plan: ${plan.context}`] : []),
    ...(plan?.checks.length ? [`The project's checks: ${plan.checks.join("; ")}`] : []),
    ...(plan?.pages.length ? [`Pages: ${plan.pages.map((p) => `${p.url}${p.command ? ` (served by: ${p.command})` : ""}`).join("; ")}`] : []),
    ...(plan?.design ? [designInstructions(plan.design)] : []),
  ].join("\n");
}

/** The first message of a project's run: the plan the user said "Go" to. */
export function planMessage(plan: ProjectPlan): string {
  return ["Начинай работу по плану:", "", plan.context, "", ...(plan.steps ?? []).map((s, n) => `${n + 1}. ${s}`)].join("\n");
}

/** Said when the model stops without finish_work (docs/specs/project-work.md: "stuck"). */
export function nudgeMessage(open: string[]): string {
  return open.length
    ? [
        `You stopped, but the work is not finished. Open checklist items: ${open.join("; ")}.`,
        "Go on working. If something blocks you, ask_user with your assumption and go on. When everything is done and checked, call finish_work.",
      ].join("\n")
    : "Every checklist item is done. If you have not checked the result for real, do it now, then call finish_work with the report. If the user asked for more, add it to the checklist and do it.";
}
