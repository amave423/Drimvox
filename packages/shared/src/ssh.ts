import { z } from "zod";

/**
 * Other computers the agent may work on over SSH (docs/specs/ssh.md): saved once with their sign-in, which never reaches
 * the model; the agent runs commands and moves files by the server's name.
 */
export const sshServerSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    host: z.string().trim().min(1).max(255),
    port: z.number().int().min(1).max(65535).default(22),
    user: z.string().trim().min(1).max(120),
    /** key: a private key file (the computer's own ~/.ssh keys when none is given); password: a password kept encrypted. */
    auth: z.enum(["key", "password"]),
    password: z.string().max(1000).optional(),
    keyPath: z.string().trim().max(1000).optional(),
    /** ask: every command waits for the user's yes; trusted: commands run without asking. */
    trust: z.enum(["ask", "trusted"]).default("ask"),
  })
  .strict();
export type SshServerInput = z.infer<typeof sshServerSchema>;

export interface SshServerView {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  auth: "key" | "password";
  keyPath: string | null;
  hasPassword: boolean;
  trust: "ask" | "trusted";
  /** The server's key as first seen; a different one later is refused (someone in between). */
  fingerprint: string | null;
}
