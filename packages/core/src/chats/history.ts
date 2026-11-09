import type { ModelMessage } from "ai";
import type { AttachmentRepo } from "./attachment-repo";
import { imageType } from "./attachments";
import type { HistoryTurn } from "./repo";

/**
 * The conversation as the model gets it (docs/specs/chat-attachments.md): a user's text and files come together, the
 * read-out text after the message and pictures as pictures, or as a note for a model that cannot see them.
 */
export function toModelMessages(turns: HistoryTurn[], files: AttachmentRepo, vision: boolean): ModelMessage[] {
  return turns.map((turn): ModelMessage => {
    if (turn.role === "assistant") return { role: "assistant", content: turn.actions ? `${turn.content}${actionsNote(turn.actions)}` : turn.content };
    if (!turn.attachments?.length) return { role: turn.role, content: turn.content };
    const notes = turn.attachments.map((a) =>
      a.kind === "text"
        ? `\n\n[Attached file ${a.name}]\n${a.text ?? ""}`
        : a.kind === "image"
          ? vision
            ? `\n\n[Attached picture ${a.name}, shown below]`
            : `\n\n[Attached picture ${a.name}: this model cannot see pictures]`
          : `\n\n[Attached file ${a.name}, ${a.size} bytes: its content cannot be read here]`,
    );
    const pictures = vision ? turn.attachments.filter((a) => a.kind === "image") : [];
    return {
      role: "user",
      content: [
        { type: "text", text: turn.content + notes.join("") },
        ...pictures.map((a) => ({ type: "image" as const, image: files.file(a.id), mediaType: imageType(a.type, a.name) })),
      ],
    };
  });
}

/**
 * What an old answer did, under its text (seen live: a chat about a VPN server, its answers kept as text only — "I check
 * the logs. Here are the facts…" — and the model went on writing such answers with no tool called, inventing what it
 * "checked"). Its results are not kept: what is true now takes a new call.
 */
function actionsNote(actions: Record<string, number>): string {
  const list = Object.entries(actions)
    .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
    .join(", ");
  return `

[Drimvox: tools called in this answer: ${list}. Their results are not kept in this conversation: to know how things are now, call the tools again.]`;
}

/** Said in every conversation with tools: what the model claims it checked, it checked with a tool now. */
export const HONEST_HINT =
  "Never say you checked, ran, opened or looked at something in this answer unless you called a tool for it in this " +
  "answer; what earlier answers found may be out of date.";
