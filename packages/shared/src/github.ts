import { z } from "zod";

/** The GitHub account Drimvox publishes with (docs/specs/github-publish.md). The token never leaves the core. */
export interface GithubStatus {
  /** The signed-in account's login; null when nobody is signed in. */
  user: string | null;
  /** Signing in: the code the user enters at GitHub's page. */
  pending: { userCode: string; verificationUri: string; expiresAt: number } | null;
  /** How the last sign-in ended when it did not work. */
  error: "denied" | "expired" | "failed" | null;
}

/** A project's link to GitHub: its `origin`, and the page when the remote is on GitHub. */
export interface GithubProject {
  remote: string | null;
  url: string | null;
}

export const githubPublishSchema = z
  .object({
    /** GitHub allows letters, digits, "-", "_" and "."; anything else it would change on its own. */
    name: z
      .string()
      .trim()
      .regex(/^[\w.-]{1,100}$/),
    private: z.boolean(),
  })
  .strict();
