import { z } from "zod";
import type { ProjectPlan } from "./backlog";
import { modelRefSchema } from "./tasks";

/**
 * Work on a project (docs/specs/project-work.md): an interview, a plan, then one long run of the agent in the project's
 * conversation, with its own checklist, until it is done or the budget or the time runs out.
 */

/** Who does what: the interview, the plan, the work; the strong model steps in when the working one is stuck. */
export const projectModelsSchema = z
  .object({ interview: modelRefSchema, plan: modelRefSchema, work: modelRefSchema, strong: modelRefSchema.nullable().default(null) })
  .strict();
export type ProjectModels = z.infer<typeof projectModelsSchema>;

/** planning: the interview or the plan is being made; ready: the plan waits for "Go"; then the run. */
export type ProjectWorkStatus = "idle" | "planning" | "ready" | "running" | "paused" | "done" | "stopped";

/** Why the run stopped and waits: the budget or the time ran out, the model got stuck, a provider error, a restart. */
/** What a run did, for the report after the work: time, money by model, actions by kind, files, checklist. */
export interface WorkReport {
  workedMs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  byModel: { model: string; answers: number; costUsd: number }[];
  /** Actions by kind, the most frequent first. */
  actions: { name: string; count: number }[];
  files: { changed: number; added: number; removed: number };
  checklist: { done: number; total: number };
}

export type ProjectWorkReason = "budget" | "time" | "stuck" | "error" | "user" | "restart" | "month_budget";

export interface ChecklistItem {
  text: string;
  done: boolean;
}

/** A question the agent asked without waiting: what it assumes until the user answers in the conversation. */
export interface AgentQuestion {
  question: string;
  assumption: string;
  at: number;
}

/** A screenshot the agent took while checking its work. */
export interface WorkShot {
  id: string;
  url: string;
  at: number;
}

export interface ProjectWorkView {
  projectId: string;
  status: ProjectWorkStatus;
  /** The interview or the plan stopped on an error or by the user: nothing runs until it is tried again. */
  planStalled: boolean;
  reason: ProjectWorkReason | null;
  /** Details of an error that stopped the run. */
  detail: string | null;
  models: ProjectModels | null;
  /** The interview and the plan: a task of the project. */
  planTaskId: string | null;
  plan: ProjectPlan | null;
  /** The project's one long conversation. */
  chatId: string | null;
  checklist: ChecklistItem[];
  questions: AgentQuestion[];
  shots: WorkShot[];
  budgetUsd: number;
  hours: number;
  /** Spent in this project's conversation since the work started. */
  spentUsd: number;
  /** How long the agent has worked, in milliseconds. */
  workedMs: number;
  /** Tools called in the conversation since the work started. */
  actions: number;
  /** The run waits for the user's permission on a command. */
  waitingApproval: boolean;
  /** The strong model took over. */
  escalated: boolean;
  startedAt: number | null;
  /** What the agent said when it finished, shown apart from the conversation. */
  report: string | null;
  /** What it made, started by Drimvox: where to open it and whether it runs now. */
  site: { url: string; running: boolean } | null;
}

const limits = { budgetUsd: z.number().min(0.01).max(10_000), hours: z.number().min(0.1).max(200) };

/** `quick`: a small change in an existing project — no interview, the plan's model writes a short plan at once. */
export const projectPlanStartSchema = z.object({ task: z.string().trim().min(1).max(20_000), models: projectModelsSchema, quick: z.boolean().default(false) }).strict();
export const projectPlanReviseSchema = z.object({ note: z.string().trim().min(1).max(20_000) }).strict();
export const projectWorkStartSchema = z.object(limits).strict();
export const projectWorkUpdateSchema = z.object({ budgetUsd: limits.budgetUsd.optional(), hours: limits.hours.optional(), strong: modelRefSchema.nullable().optional() }).strict();
export const projectWorkMessageSchema = z.object({ content: z.string().trim().min(1).max(200_000) }).strict();
/** A message in a ready project's conversation, with the model that answers it (as in a chat). */
export const projectWorkChatSchema = z.object({ content: z.string().trim().min(1).max(200_000), model: modelRefSchema }).strict();

