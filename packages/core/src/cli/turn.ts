/** A session belongs to one CLI and one model; another model starts a new one. */
export function sessionFor(stored: string | null, preset: string, model: string): string | null {
  if (!stored) return null;
  try {
    const s = JSON.parse(stored) as { preset?: string; model?: string; id?: string };
    return s.preset === preset && s.model === model && s.id ? s.id : null;
  } catch {
    return null;
  }
}

export const storeSession = (preset: string, model: string, id: string) => JSON.stringify({ preset, model, id });

/** Earlier turns, for a CLI that starts a new session in the middle of a conversation. */
export function transcript(messages: { role: string; content: unknown }[]): string {
  const lines = messages.flatMap((m) => {
    const text =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((p: { type?: string; text?: string }) => (p.type === "text" ? (p.text ?? "") : "")).join("")
          : "";
    if (!text.trim() || (m.role !== "user" && m.role !== "assistant")) return [];
    return [`${m.role === "user" ? "User" : "Assistant"}: ${text.trim()}`];
  });
  return lines.length ? `The conversation so far:\n\n${lines.join("\n\n")}` : "";
}
