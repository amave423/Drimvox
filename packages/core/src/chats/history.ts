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
    if (turn.role === "assistant" || !turn.attachments?.length) return { role: turn.role, content: turn.content };
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
