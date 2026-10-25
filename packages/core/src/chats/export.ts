import type { ChatWithMessages } from "@drimvox/shared";

/**
 * A chat as Markdown (asked for: export a chat): the title, then each message under who wrote it, answers as the model
 * wrote them; pictures and clips are named, files listed.
 */
export function chatMarkdown(chat: Omit<ChatWithMessages, "approvals">, you: string): string {
  const lines = [`# ${chat.title ?? "Chat"}`, ""];
  for (const m of chat.messages) {
    if (m.role === "user") {
      lines.push(`## ${you}`, "", m.content);
      for (const a of m.attachments) lines.push("", `📎 ${a.name}`);
    } else {
      lines.push(`## ${m.model ?? "Model"}`, "", m.content || "");
      for (const item of m.media) lines.push("", `🖼 ${item.kind === "video" ? "video" : "picture"}: ${item.prompt}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}
