import type { ModelInfo, ProjectPlan } from "@drimvox/shared";
import { tool, type ToolSet } from "ai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runAgent, type RunInput } from "../agent/run";
import { todayLine } from "../now";
import type { Connection } from "../providers/repo";
import { parseSkill, type Skill } from "../skills/skills";

/** What the reviewer may spend looking: reading, searching, a request or a test of its own. */
const REVIEW_STEPS = 40;
/** Skills meant for this review: the reviewer follows them, they are not left to the coder's memory. */
const SECURITY_SKILL = /secur|vulnerab|owasp|audit|pentest|threat|безопасн|уязвим/i;

export interface ReviewIssue {
  severity: "critical" | "high" | "medium" | "low";
  where: string;
  problem: string;
  fix: string;
}

function systemPrompt(root: string, skills: string, platform = process.platform): string {
  const shell = platform === "win32" ? "Windows PowerShell 5.1 (no && or ||: separate commands with ;)" : "sh";
  return [
    "You are the code reviewer in Drimvox. Another agent built this project; you did not, and you must not change it.",
    `The project is at: ${root}`,
    todayLine(),
    `Commands run with ${shell} in that folder.`,
    "",
    "Find what would hurt the people who use it or run it, before it reaches them.",
    "",
    "First work out what kind of project this is and where harm can come from in it: who uses it, what it trusts (user",
    "input, files, the network, other services), what it can reach (data of several people, money, files and commands of",
    "the computer it runs on, keys of outside services). Then look where that harm would happen. For example:",
    "- a service with accounts: who may read and change what, through every way in (pages and API, real-time channels,",
    "  downloads and uploads, invitations, password reset, admin parts); one person's data reachable by another;",
    "- a desktop program, a script or a command-line tool: files it deletes or overwrites, commands built from input,",
    "  paths that leave the folder they should stay in;",
    "- a bot, an integration or anything with payments: keys in the code or the logs, requests from the outside service",
    "  taken without checking they are real;",
    "- a mobile app: tokens and personal data stored in the open, traffic without encryption;",
    "- a library: dangerous defaults, untrusted input taken as trusted;",
    "- anywhere: injection (SQL, commands, HTML and scripts in user text), secrets in the code, known vulnerable",
    "  dependencies (run the ecosystem's own audit when there is one: npm audit, pip-audit, cargo audit, …);",
    "- and what the user asked for explicitly about safety and rights, and whether it truly holds.",
    "A project with little to protect (a static page, a game without accounts) needs a short look: say so and report no",
    "issues rather than invent them.",
    "",
    "Prove what you suspect when you can: read the code that decides, run the project's tests, start it and send a request",
    "(stop what you started). Report only real problems with the place in the code and a concrete fix; style is not your",
    "business. Leave the project as you found it: delete anything you created only to check.",
    "Finish by calling report_review once.",
    skills ? `\nThe user's own instructions for this review (skills), follow them:\n${skills}` : "",
  ].join("\n");
}

function reviewTools(onReport: (r: { issues: ReviewIssue[]; summary: string }) => void): ToolSet {
  return {
    report_review: tool({
      description: "Give the review: every real problem found, most severe first, with where it is and how to fix it.",
      inputSchema: z.object({
        issues: z
          .array(
            z.object({
              severity: z.enum(["critical", "high", "medium", "low"]),
              where: z.string().min(1).max(500),
              problem: z.string().min(1).max(2000),
              fix: z.string().min(1).max(2000),
            }),
          )
          .max(30),
        summary: z.string().min(1).max(2000),
      }),
      execute: async (r) => {
        onReport(r);
        return "Review recorded.";
      },
    }),
  };
}

export interface CodeReviewInput {
  conn: Connection;
  model: string;
  price: ModelInfo | undefined;
  folder: string;
  plan: ProjectPlan | null;
  skills: Skill[];
  /** Background processes, as the coder has them, to start the project and send it a request. */
  ownTools: ToolSet;
  signal: AbortSignal;
  idleTimeoutMs: number;
  hooks: RunInput["hooks"];
  onSpend(usd: number): void;
}

/** The text of the shared and project skills meant for a security review. */
function securitySkills(skills: Skill[]): string {
  return skills
    .filter((s) => SECURITY_SKILL.test(`${s.name} ${s.description}`))
    .map((s) => {
      try {
        return `## ${s.name}\n${parseSkill(readFileSync(join(s.dir, "SKILL.md"), "utf8"), s.name).body}`;
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * A second pair of eyes on the code before the work is done (asked for, after a live run: a team board let anyone listen
 * to any board over WebSocket, and the coder's own tests never looked there). The working model again, in a conversation
 * of its own with only this to do: it reads and runs, does not edit, and returns the problems; null when it found none
 * worth fixing or could not finish. What harm means depends on the project, so it works that out first.
 */
export async function reviewProjectCode(i: CodeReviewInput): Promise<ReviewIssue[] | null> {
  let report: { issues: ReviewIssue[]; summary: string } | null = null;
  const messages: RunInput["messages"] = [
    {
      role: "user",
      content: [
        "Review this project before it goes to the user.",
        i.plan ? `\nWhat was asked:\n${i.plan.context}` : "",
        i.plan?.decisions?.length ? `\nDecisions taken:\n${i.plan.decisions.map((d) => `- ${d.what}: ${d.why}`).join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];
  for (let attempt = 0; attempt < 2 && !report; attempt++) {
    if (attempt > 0) messages.push({ role: "user", content: "You have not given the review. Call report_review now." });
    const outcome = await runAgent({
      conn: i.conn,
      model: i.model,
      price: i.price,
      worktree: i.folder,
      messages,
      mode: "review",
      extraTools: reviewTools((r) => (report = r)),
      ownTools: i.ownTools,
      stopTools: ["report_review"],
      ...(attempt > 0 ? { only: "report_review" } : {}),
      maxSteps: REVIEW_STEPS,
      system: systemPrompt(i.folder, securitySkills(i.skills)),
      spentUsd: 0,
      budgetUsd: Number.POSITIVE_INFINITY,
      signal: i.signal,
      idleTimeoutMs: i.idleTimeoutMs,
      hooks: i.hooks,
      onText: () => {},
      onStep: (step) => {
        messages.push(...step.messages);
        i.onSpend(step.costUsd);
      },
    });
    // Stopped, out of money or failed: no review rather than none forced; the work goes on as it is.
    if (outcome.kind === "stopped" || outcome.kind === "budget" || outcome.kind === "error") break;
  }
  const given = report as { issues: ReviewIssue[]; summary: string } | null;
  if (!given) return null;
  const worth = given.issues.filter((x) => x.severity !== "low");
  return worth.length ? worth : null;
}

/** What goes back to the coder: the problems to fix, each proven closed. */
export function reviewWorkMessage(issues: ReviewIssue[]): string {
  return [
    "A code reviewer read the project before it goes to the user and found these problems:",
    "",
    ...issues.map((x, n) => `${n + 1}. [${x.severity}] ${x.where}\n   Problem: ${x.problem}\n   Fix: ${x.fix}`),
    "",
    "Fix every one of them, add a test that proves each is closed, run all the checks, then call finish_work again.",
  ].join("\n");
}
