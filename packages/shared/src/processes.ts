import { z } from "zod";

/** Whose a background process is: a project's agent, a project's started result, a chat with a folder, a task. */
export type ProcessOwner =
  | { kind: "project"; projectId: string; name: string }
  | { kind: "site"; projectId: string; name: string }
  | { kind: "chat"; chatId: string; name: string }
  | { kind: "task"; taskId: string; name: string }
  | { kind: "other"; name: string };

/** A command running in the background (asked for: to see what runs and stop what is not needed). */
export interface ProcessView {
  /** Whose list it is in, and its number there: what stopping it takes. */
  key: string;
  id: number;
  command: string;
  cwd: string;
  startedAt: number;
  pid: number | null;
  owner: ProcessOwner;
}

export const processStopSchema = z.object({ key: z.string().min(1).max(200), id: z.number().int().min(1) }).strict();
