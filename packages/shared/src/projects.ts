import { z } from "zod";

/** "new": made from scratch; "existing": a ready project. Both are worked on as in a chat. */
export const projectKindSchema = z.enum(["new", "existing"]);
export type ProjectKind = z.infer<typeof projectKindSchema>;
export const projectCreateSchema = z.object({ path: z.string().trim().min(1).max(1000), kind: projectKindSchema.default("new") }).strict();
/** A folder looked at before it is added: whether there is anything in it, to guess a ready project. */
export const projectPeekSchema = z.object({ path: z.string().trim().min(1).max(1000) }).strict();
/** A project's own name instead of its folder's, or its kind changed later. */
/** A project's folder in its new place, after it was renamed or moved. */
export const projectMoveSchema = z.object({ path: z.string().trim().min(1).max(1000) }).strict();

export const projectRenameSchema = z
  .object({ name: z.string().trim().min(1).max(120).optional(), kind: projectKindSchema.optional() })
  .strict()
  .refine((p) => p.name !== undefined || p.kind !== undefined);

export interface ProjectView {
  id: string;
  name: string;
  path: string;
  /** "not_repo": the folder has no git yet; Drimvox offers to start it. */
  /** "missing": the folder is gone (renamed or moved where Drimvox could not find it); the user shows the new place. */
  gitState: "ready" | "not_repo" | "missing";
  kind: ProjectKind;
  createdAt: number;
}

export const modelRefSchema = z.object({ providerId: z.string().min(1), model: z.string().min(1).max(200) });
export type ModelRef = z.infer<typeof modelRefSchema>;

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
