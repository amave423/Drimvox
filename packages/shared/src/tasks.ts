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
  })
  .strict();

export const taskAnswersSchema = z
  .object({
    answers: z.array(z.object({ id: z.string().min(1), answer: z.string().trim().min(1).max(5000) })).max(20).default([]),
    skip: z.boolean().default(false),
  })
  .strict();

const checkCommand = z.string().trim().min(1).max(500);
export const specApproveSchema = z
  .object({ spec: z.string().trim().min(1).max(100_000), checks: z.array(checkCommand).max(20) })
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
export type TaskPhase = "interview" | "spec" | "tests" | "code";

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
export const approvalAnswerSchema = z.object({ allow: z.boolean() }).strict();

export type TaskFeedback = z.infer<typeof taskFeedbackSchema>;

export type TaskStatus =
  | "running"
  | "waiting"
  | "review"
  | "done_empty"
  | "failed"
  | "stopped"
  | "accepted"
  | "discarded";

/** Why a task waits, failed or stopped: approval, budget, steps, restart, or a provider error code. */
export type TaskReason = string;

export interface PendingApproval {
  id: string;
  command: string;
  /** push, global, outside, system, download */
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
  createdAt: number;
  updatedAt: number;
}

export type TaskEventKind =
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
  | "escalation";

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
