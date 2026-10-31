import { z } from "zod";

/**
 * How the agent works with git in a project (docs/specs/project-git.md): where it writes, when it commits, how its
 * messages read, and what Drimvox does with the branch at the end.
 */
export const gitTargets = ["task-branch", "work-branch", "current", "main"] as const;
export const gitCommitModes = ["per-item", "end", "logical", "never"] as const;
export const gitMessageStyles = ["history", "en", "ru", "conventional"] as const;

export const projectGitRulesSchema = z
  .object({
    /** task-branch: drimvox/… per task; work-branch: drimvox/work for all; current: where it is; main: the main branch. */
    target: z.enum(gitTargets),
    commit: z.enum(gitCommitModes),
    messages: z.enum(gitMessageStyles),
    /** Push the agent's branch to GitHub when the work is done. */
    push: z.boolean(),
    /** Open a pull request into the base branch at the end (needs push). */
    pullRequest: z.boolean(),
    /** Writing straight into main is allowed; otherwise "main" falls back to a branch of its own. */
    allowMain: z.boolean(),
  })
  .strict();
export type ProjectGitRules = z.infer<typeof projectGitRulesSchema>;

export const defaultGitRules: ProjectGitRules = { target: "task-branch", commit: "per-item", messages: "history", push: true, pullRequest: true, allowMain: false };

/** Where the project's git is now: the agent's branch and the one it came from, its commits, the pull request. */
export interface ProjectGitState {
  /** The branch checked out now; null without git or on a detached head. */
  branch: string | null;
  /** The branch the agent's work goes back into, when it works in a branch of its own. */
  base: string | null;
  /** Commits on the branch that the base does not have. */
  ahead: number;
  /** The project has a GitHub remote and Drimvox is signed in to GitHub. */
  github: boolean;
  pullRequest: { number: number; url: string } | null;
}
