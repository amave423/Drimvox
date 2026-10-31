import { z } from "zod";

/**
 * Accounts CLIProxyAPI signs in to (docs/specs/subscriptions.md): what each is called in its Management API. Their own
 * plans (Claude Pro/Max, ChatGPT, a Google account, Kimi, Grok) become one OpenAI-compatible provider in Drimvox.
 */
export const subscriptionKinds = ["anthropic", "codex", "antigravity", "kimi", "xai"] as const;
export type SubscriptionKind = (typeof subscriptionKinds)[number];

export interface CliProxyStatus {
  /** A build exists for this computer. */
  supported: boolean;
  installed: boolean;
  version: string | null;
  running: boolean;
  /** The local address the server listens on, when it runs. */
  port: number | null;
  /** Stop the server when Drimvox closes; otherwise it keeps serving other programs and Drimvox picks it up next time. */
  stopOnQuit: boolean;
  /** The download under way. */
  download: { received: number; total: number } | null;
  error: string | null;
  /** The provider in "Keys and models" that talks to it. */
  providerId: string | null;
}

export interface SubscriptionAccount {
  /** The account's file in CLIProxyAPI: what it is removed by. */
  name: string;
  kind: string;
  email: string | null;
  /** "active", "error", … as CLIProxyAPI says; disabled accounts are skipped by it. */
  status: string;
  disabled: boolean;
  authIndex: string | null;
}

/** One limit of an account: how much of it is used and when it starts over. */
export interface AccountLimitWindow {
  /** "five_hour", "seven_day", or a model's name for per-model quotas. */
  window: string;
  usedPercent: number;
  /** ISO time; null when the service does not say. */
  resetsAt: string | null;
}

export interface AccountLimits {
  account: string;
  kind: string;
  email: string | null;
  windows: AccountLimitWindow[];
  /** Why there are none: the service does not report them, or the request failed. */
  note: string | null;
}

export interface SubscriptionLogin {
  state: string;
  /** Opened in a browser to sign in. */
  url: string;
  /** Device sign-in (Kimi, Grok): the code to type on the page. */
  userCode: string | null;
}

export const cliProxyUpdateSchema = z.object({ stopOnQuit: z.boolean().optional(), running: z.boolean().optional() }).strict();
export const subscriptionLoginSchema = z.object({ kind: z.enum(subscriptionKinds) }).strict();
/** On a server the sign-in page cannot come back to localhost: the address it ended on is pasted instead. */
export const subscriptionCallbackSchema = z.object({ kind: z.enum(subscriptionKinds), state: z.string().min(1).max(500), redirectUrl: z.string().url().max(8000) }).strict();
