import { z } from "zod";

/** A skill as the interface shows it. `path` is the folder: absolute for shared skills, in the project for others. */
export interface SkillView {
  name: string;
  description: string;
  scope: "shared" | "project";
  path: string;
}

export const skillCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    description: z.string().trim().min(1).max(500),
    instructions: z.string().trim().min(1).max(100_000),
  })
  .strict();

/** A folder with SKILL.md to copy into Drimvox's shared skills. */
export const skillImportSchema = z.object({ path: z.string().min(1).max(1000) }).strict();

/** Drimvox's own ready skills (docs/specs/catalog.md). */
export const builtinSkills = ["docx", "xlsx", "pptx", "pdf"] as const;

/** A ready skill: a folder of a GitHub repository with SKILL.md, or one of Drimvox's own. */
export const skillInstallSchema = z
  .object({
    source: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("github"),
        repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
        path: z.string().min(1).max(300),
        ref: z.string().regex(/^[\w./-]+$/).max(100).default("main"),
      }),
      z.object({ kind: z.literal("builtin"), id: z.enum(builtinSkills) }),
    ]),
  })
  .strict();
