import { z } from "zod";
import type { DesignBrief } from "./design";

/**
 * The project's task list (docs/specs/backlog-loop.md): after the interview the agent lists everything worth doing,
 * the MVP first; the user picks a few at a time, and each one is done, checked and reviewed before the next.
 */
export const backlogSizes = ["S", "M", "L"] as const;
export type BacklogSize = (typeof backlogSizes)[number];

/** How much a task weighs in a batch. */
export const SIZE_POINTS: Record<BacklogSize, number> = { S: 1, M: 2, L: 3 };
/** The most a batch may weigh: what one agent does well before the user looks. */
export const BATCH_POINTS = 3;

export type BacklogStatus = "open" | "picked" | "active" | "done";

export interface BacklogItem {
  id: string;
  projectId: string;
  position: number;
  title: string;
  /** "Done when …" points: what the result must do, as the user would check it. */
  done: string[];
  size: BacklogSize;
  /** open: in the list; picked: in the current batch, waiting its turn; active: being done or reviewed; done: accepted. */
  status: BacklogStatus;
  /** The task doing it, once it started. */
  taskId: string | null;
}

/** What the project's tasks share: decided in the interview, read by every task of the list. */
export interface ProjectPlan {
  /** What the project is and what the user wants, in a few sentences. */
  context: string;
  /** Commands that check the project (build, tests), once there is something to check. */
  checks: string[];
  /** Pages to look at, with the command that serves them. */
  pages: { url: string; command?: string }[];
  /** The look settled in the interview, when there is an interface. */
  design: DesignBrief | null;
}

const title = z.string().trim().min(1).max(160);
const donePoints = z.array(z.string().trim().min(1).max(400)).min(1).max(8);

export const backlogItemInputSchema = z.object({ title, done: donePoints, size: z.enum(backlogSizes) }).strict();
export type BacklogItemInput = z.infer<typeof backlogItemInputSchema>;

export const backlogUpdateSchema = z.object({ title: title.optional(), done: donePoints.optional(), size: z.enum(backlogSizes).optional() }).strict();

/** The order of the open tasks, top first. */
export const backlogOrderSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(200) }).strict();

/** The tasks of the next batch, in the order they are done; they may weigh BATCH_POINTS at most. */
export const backlogRunSchema = z
  .object({ ids: z.array(z.string().min(1)).min(1).max(BATCH_POINTS), providerId: z.string().min(1), model: z.string().min(1).max(200) })
  .strict();

export function pointsOf(items: Pick<BacklogItem, "size">[]): number {
  return items.reduce((sum, i) => sum + SIZE_POINTS[i.size], 0);
}
