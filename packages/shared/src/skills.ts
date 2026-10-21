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
