import type { StreamEvent } from "@artel/shared";
import { randomUUID } from "node:crypto";

interface Pending {
  chatId: string;
  settle(answer: boolean | "always"): void;
}

/**
 * Permission requests inside a chat answer: the answer's stream stays open, the card shows in it, and the
 * user's click arrives as a separate request. A closed stream counts as "no".
 */
export class ChatApprovals {
  private readonly pending = new Map<string, Pending>();

  ask(
    chatId: string,
    emit: (event: StreamEvent) => Promise<void>,
    call: { server: string; tool: string; input: unknown; reason?: string; purpose?: string; signal?: AbortSignal },
  ): Promise<boolean | "always"> {
    const id = randomUUID();
    return new Promise((resolve) => {
      const onAbort = () => settle(false);
      const settle = (answer: boolean | "always") => {
        if (!this.pending.delete(id)) return;
        call.signal?.removeEventListener("abort", onAbort);
        void emit({ type: "approved", id, allowed: answer !== false });
        resolve(answer);
      };
      this.pending.set(id, { chatId, settle });
      call.signal?.addEventListener("abort", onAbort, { once: true });
      void emit({
        type: "approval",
        id,
        server: call.server,
        tool: call.tool,
        input: call.input,
        ...(call.reason ? { reason: call.reason } : {}),
        ...(call.purpose ? { purpose: call.purpose } : {}),
      });
    });
  }

  answer(chatId: string, id: string, allow: boolean, always: boolean): boolean {
    const p = this.pending.get(id);
    if (!p || p.chatId !== chatId) return false;
    p.settle(allow ? (always ? "always" : true) : false);
    return true;
  }
}
