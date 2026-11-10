import type { ChatQuestionView } from "@drimvox/shared";
import { randomUUID } from "node:crypto";

interface Pending {
  chatId: string;
  card: ChatQuestionView;
  settle(answers: string[] | null): void;
}

/**
 * The agent's questions to the user, as OpenCode's question tool (asked for: no separate interview and plan switches;
 * the agent asks when it must, with answers to pick). The run waits on the card; the answer comes as a separate request
 * or as the user's next message. Stop or a closed run counts as no answer.
 */
export class ChatQuestions {
  private readonly pending = new Map<string, Pending>();

  ask(chatId: string, questions: ChatQuestionView["questions"], signal?: AbortSignal): Promise<string[] | null> {
    const id = randomUUID();
    return new Promise((resolve) => {
      const onAbort = () => settle(null);
      const settle = (answers: string[] | null) => {
        if (!this.pending.delete(id)) return;
        signal?.removeEventListener("abort", onAbort);
        resolve(answers);
      };
      this.pending.set(id, { chatId, card: { id, questions }, settle });
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** The questions a chat waits on now. */
  open(chatId: string): ChatQuestionView[] {
    return [...this.pending.values()].filter((p) => p.chatId === chatId).map((p) => p.card);
  }

  /** One answer per question; false when no such question waits. */
  answer(chatId: string, id: string, answers: string[]): boolean {
    const p = this.pending.get(id);
    if (!p || p.chatId !== chatId) return false;
    p.settle(answers);
    return true;
  }

  /** The user wrote a message instead of picking: it answers every question the chat waits on. */
  answerWith(chatId: string, text: string): boolean {
    const waiting = [...this.pending.values()].filter((p) => p.chatId === chatId);
    for (const p of waiting) p.settle(p.card.questions.map(() => text));
    return waiting.length > 0;
  }
}
