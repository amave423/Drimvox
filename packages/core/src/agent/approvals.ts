import type { PendingApproval } from "@drimvox/shared";
import { randomUUID } from "node:crypto";

/** Allowed once, "always" for this tool, "server" for every tool of its MCP server, or not. */
export type ApprovalAnswer = boolean | "always" | "server";

/** Where a running task keeps the one request it waits on. */
export interface ApprovalSlot {
  approval: (PendingApproval & { resolve(answer: ApprovalAnswer): void }) | null;
}

export interface ApprovalReport {
  /** An "approval" event: asked (allowed null), then answered. */
  event(data: { id: string; command: string; reason: string; purpose?: string; allowed: boolean | null; always?: boolean }): void;
  /** The task waits while the request is open and runs again once it is answered. */
  waiting(on: boolean): void;
}

/** Puts a request in the slot and resolves with the user's answer; an aborted task counts as "no". */
export function waitForApproval(
  slot: ApprovalSlot,
  command: string,
  reason: string,
  report: ApprovalReport,
  signal?: AbortSignal,
  purpose?: string,
): Promise<ApprovalAnswer> {
  return new Promise((resolve) => {
    const id = randomUUID();
    const onAbort = () => settle(false);
    const settle = (answer: ApprovalAnswer) => {
      slot.approval = null;
      signal?.removeEventListener("abort", onAbort);
      report.event({ id, command, reason, purpose, allowed: answer !== false, always: answer === "always" });
      report.waiting(false);
      resolve(answer);
    };
    slot.approval = { id, command, reason, ...(purpose ? { purpose } : {}), resolve: settle };
    signal?.addEventListener("abort", onAbort, { once: true });
    report.event({ id, command, reason, purpose, allowed: null });
    report.waiting(true);
  });
}
