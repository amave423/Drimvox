import { z } from "zod";

/** How a requirement is proven: a check command, a look at a page, or the acceptance agent by hand. */
export const verifyKinds = ["check", "visual", "review"] as const;

/** One checkable statement about the result, numbered R1, R2… */
export const requirementSchema = z.object({
  id: z.string().trim().min(1).max(10),
  text: z.string().trim().min(1).max(2000),
  verify: z.enum(verifyKinds),
  /** The command, the page and what must be on it, or what the acceptance agent does. */
  how: z.string().trim().max(2000).default(""),
});
export type Requirement = z.infer<typeof requirementSchema>;

export const acceptanceStatuses = ["done", "partial", "missing"] as const;

export interface AcceptanceResult {
  /** The requirement's id, such as R2. */
  id: string;
  status: (typeof acceptanceStatuses)[number];
  /** What the acceptance agent saw: command output, a place in the code, a screenshot description. */
  evidence: string;
  /** What is wrong, when the requirement is not done. */
  problem: string;
}

/** The acceptance agent's verdict on one round of work. */
export interface AcceptanceReport {
  /** 1 for the first acceptance of the task, then one more after every rework. */
  round: number;
  results: AcceptanceResult[];
  summary: string;
  /** The model that accepted the work. */
  model: string;
}
