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

export const taskCreateSchema = z
  .object({
    task: z.string().trim().min(1).max(50_000),
    providerId: z.string().min(1),
    model: z.string().min(1).max(200),
  })
  .strict();

export const taskFeedbackSchema = z
  .object({
    note: z.string().trim().max(20_000).optional(),
    comments: z
      .array(z.object({ path: z.string().min(1), line: z.number().int().min(1), text: z.string().trim().min(1).max(5000) }))
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
  createdAt: number;
  updatedAt: number;
}

export type TaskEventKind = "user" | "text" | "tool_call" | "tool_result" | "approval" | "status";

export interface TaskEvent {
  seq: number;
  kind: TaskEventKind;
  data: any;
  createdAt: number;
}

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
