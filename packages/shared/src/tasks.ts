import { requirementSchema, type AcceptanceReport, type Requirement } from "./quality";
import { z } from "zod";

export const projectCreateSchema = z.object({ path: z.string().trim().min(1).max(1000) }).strict();

export interface ProjectView {
  id: string;
  name: string;
  path: string;
  /** "not_repo": the folder has no git yet; Artel offers to start it. */
  gitState: "ready" | "not_repo";
  createdAt: number;
}

export const modelRefSchema = z.object({ providerId: z.string().min(1), model: z.string().min(1).max(200) });
export type ModelRef = z.infer<typeof modelRefSchema>;

/** Which steps a task goes through before the code. All on unless the user turns them off. */
export const taskStagesSchema = z
  .object({
    interview: z.boolean().default(true),
    spec: z.boolean().default(true),
    approveSpec: z.boolean().default(true),
    testsFirst: z.boolean().default(true),
  })
  .strict();
export type TaskStages = z.infer<typeof taskStagesSchema>;

export const taskCreateSchema = z
  .object({
    task: z.string().trim().min(1).max(50_000),
    providerId: z.string().min(1),
    model: z.string().min(1).max(200),
    stages: taskStagesSchema.default({ interview: true, spec: true, approveSpec: true, testsFirst: true }),
    /** Present for a team goal: the model the worker agents use. `model` then leads and plans. */
    team: modelRefSchema.optional(),
  })
  .strict();

/** A subtask as the lead agent planned it; `id` is a short slug other subtasks depend on. */
export const plannedSubtaskSchema = z.object({
  id: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(10_000),
  dependsOn: z.array(z.string()).max(8).default([]),
  /** Commands that pass once this subtask alone is done; the goal's checks pass once all are merged. */
  checks: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
});
export type PlannedSubtask = z.infer<typeof plannedSubtaskSchema>;

export const planApproveSchema = z
  .object({
    spec: z.string().trim().min(1).max(100_000),
    checks: z.array(z.string().trim().min(1).max(500)).max(20),
    subtasks: z.array(plannedSubtaskSchema).min(1).max(8),
  })
  .strict();

export const taskAnswersSchema = z
  .object({
    answers: z.array(z.object({ id: z.string().min(1), answer: z.string().trim().min(1).max(5000) })).max(20).default([]),
    skip: z.boolean().default(false),
  })
  .strict();

const checkCommand = z.string().trim().min(1).max(500);
/** A look at a page after the code is green: start the app (optional), open the address, expect what is described. */
export const visualCheckSchema = z.object({
  start: z.string().trim().min(1).max(500).optional(),
  url: z.string().trim().url().max(2000),
  expect: z.string().trim().min(1).max(2000),
});
export type VisualCheck = z.infer<typeof visualCheckSchema>;

export const specApproveSchema = z
  .object({
    spec: z.string().trim().min(1).max(100_000),
    checks: z.array(checkCommand).max(20),
    /** Left out, the proposed ones stay. */
    visualChecks: z.array(visualCheckSchema).max(10).optional(),
    /** Left out, the proposed ones stay. */
    requirements: z.array(requirementSchema).min(1).max(60).optional(),
  })
  .strict();
export const specReviseSchema = z.object({ note: z.string().trim().min(1).max(20_000) }).strict();

export interface QuestionOption {
  label: string;
  description: string;
}

export interface Question {
  id: string;
  question: string;
  options: QuestionOption[];
  /** Index of the recommended option, if the agent has one. */
  recommended: number | null;
}

/** Which step a task is on. Null for tasks that skip straight to the code. */
export type TaskPhase = "interview" | "spec" | "tests" | "code" | "orchestrate";

/** A one-agent task, a team goal, or one subtask of a goal. */
export type TaskKind = "solo" | "goal" | "subtask";

/** A subtask as the goal's board shows it. */
export interface SubtaskCard {
  /** The planned id, such as "auth-api". */
  id: string;
  /** The task that does the work. */
  taskId: string;
  title: string;
  status: TaskStatus;
  statusReason: string | null;
  phase: TaskPhase | null;
  model: string;
  costUsd: number;
  dependsOn: string[];
}

export const taskFeedbackSchema = z
  .object({
    note: z.string().trim().max(20_000).optional(),
    comments: z
      .array(
        z.object({
          path: z.string().min(1),
          line: z.number().int().min(1),
          /** "old": a removed line, numbered as in the original file. */
          side: z.enum(["old", "new"]).default("new"),
          text: z.string().trim().min(1).max(5000),
        }),
      )
      .max(200)
      .default([]),
  })
  .strict();

export const taskContinueSchema = z.object({ note: z.string().trim().max(20_000).optional() }).strict();
export const taskAcceptSchema = z.object({ message: z.string().trim().min(1).max(500).optional() }).strict();
export const approvalAnswerSchema = z.object({ allow: z.boolean(), always: z.boolean().default(false) }).strict();

export type TaskFeedback = z.infer<typeof taskFeedbackSchema>;

export type TaskStatus =
  | "running"
  | "waiting"
  | "review"
  | "done_empty"
  | "failed"
  | "stopped"
  | "accepted"
  | "discarded"
  /** A subtask waiting for a free slot or for the subtasks it depends on. */
  | "queued"
  /** A subtask whose work is in the goal's branch. */
  | "merged";

/** Why a task waits, failed or stopped: approval, budget, steps, restart, or a provider error code. */
export type TaskReason = string;

export interface PendingApproval {
  id: string;
  command: string;
  /** push, global, outside, system, download, media_cost, mcp */
  reason: string;
}

export interface TaskView {
  id: string;
  projectId: string;
  title: string;
  task: string;
  providerId: string | null;
  model: string;
  status: TaskStatus;
  statusReason: TaskReason | null;
  branch: string;
  budgetUsd: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  steps: number;
  summary: string | null;
  commitMessage: string | null;
  pendingApproval: PendingApproval | null;
  phase: TaskPhase | null;
  stages: TaskStages;
  spec: string | null;
  /** Shell commands that prove the work: every one must exit 0. */
  checks: string[];
  plan: string[];
  /** Open interview questions; empty once answered. */
  questions: Question[];
  /** Red check runs in a row in the current attempt round. */
  attempts: number;
  escalated: boolean;
  kind: TaskKind;
  /** For a subtask: its goal. */
  parentId: string | null;
  /** For a goal: the worker model. */
  team: ModelRef | null;
  /** For a goal: the subtasks as planned (and as the user edited them). */
  plannedSubtasks: PlannedSubtask[];
  /** Pages Artel looks at, through a model that sees pictures, once the checks are green. */
  visualChecks: VisualCheck[];
  /** For a goal: the subtasks at work. */
  subtasks: SubtaskCard[];
  /** What must be true of the result, numbered; the acceptance agent checks each one. */
  requirements: Requirement[];
  /** Choices the agent made on its own, so the user can see them. */
  decisions: string[];
  /** The latest acceptance verdict, once the work has been accepted at least once. */
  acceptance: AcceptanceReport | null;
  createdAt: number;
  updatedAt: number;
}

export type TaskEventKind =
  | "answer"
  | "screenshot"
  | "user"
  | "text"
  | "tool_call"
  | "tool_result"
  | "approval"
  | "status"
  | "phase"
  | "questions"
  | "answers"
  | "spec"
  | "check"
  | "escalation"
  | "plan"
  | "subtask"
  | "acceptance";

export interface TaskEvent {
  seq: number;
  kind: TaskEventKind;
  data: any;
  createdAt: number;
}

/** Messages of GET /api/tasks/:id/stream: the task's current state or a new event. */
export type TaskUpdate = { type: "event"; event: TaskEvent } | { type: "task"; task: TaskView };

export interface DiffLine {
  kind: "context" | "add" | "del";
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: "added" | "deleted" | "modified" | "renamed";
  binary: boolean;
  added: number;
  removed: number;
  hunks: DiffHunk[];
}
