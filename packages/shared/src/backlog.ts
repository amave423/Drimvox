import type { DesignBrief } from "./design";
import type { DiffFile } from "./tasks";

/**
 * The project's old task list (docs/specs/backlog-loop.md), read only: tasks started before one long run replaced it
 * (docs/specs/project-work.md).
 */
export const backlogSizes = ["S", "M", "L"] as const;
export type BacklogSize = (typeof backlogSizes)[number];


export type BacklogStatus = "open" | "picked" | "active" | "review" | "done";

export interface BacklogItem {
  id: string;
  projectId: string;
  position: number;
  title: string;
  /** "Done when …" points: what the result must do, as the user would check it. */
  done: string[];
  size: BacklogSize;
  /** open: in the list; picked: in the current batch, waiting its turn; active: being done; review: the agent answered, the user checks; done: accepted. */
  status: BacklogStatus;
  /** The old-style task doing it (before conversations); null for new ones. */
  taskId: string | null;
  /** The conversation it is done in, once it started. */
  chatId: string | null;
}


/** What a task changed in the project's folder since it started. */
export interface WorkChanges {
  files: { path: string; status: "added" | "modified" | "deleted" }[];
  /** The same changes line by line, for the review. */
  diff: DiffFile[];
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
  /** The plan's steps, short: the run's first checklist (docs/specs/project-work.md). Absent in plans of the old task list. */
  steps?: string[];
  /** The pages or screens and what is on each, what the user can do there. */
  screens?: { name: string; contents: string }[];
  /** The technical decisions and why: the stack, where data lives, outside services. */
  decisions?: { what: string; why: string }[];
}

/** A task as the old interview listed it. */
export interface BacklogItemInput {
  title: string;
  done: string[];
  size: BacklogSize;
}
