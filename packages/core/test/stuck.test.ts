import { describe, expect, it } from "vitest";
import { STUCK_NOTE, stuckNote } from "../src/chats/stuck";

const user = (content: string) => ({ role: "user" as const, content });
const assistant = (content: string) => ({ role: "assistant" as const, content });

// Seen live, the user's own words in a VPN chat that went on for hours: the cause, zapret on the PC, was never looked for.
describe("a chat stuck on the same failure", () => {
  it("tells the model to step back when the user keeps saying it still fails", () => {
    const turns = [
      user("vpn не работает на пк, сайты не грузят"),
      assistant("Поменял транспорт."),
      user("\"не удалось подключиться\""),
      assistant("Сделал два новых входа."),
      user("нихера короче не работает"),
    ];
    expect(stuckNote(turns)).toBe(STUCK_NOTE);
    expect(STUCK_NOTE).toContain("zapret");
  });

  it("says nothing on the first failure, or when the newest message is not one", () => {
    expect(stuckNote([user("сделай впн"), assistant("Готово."), user("не работает")])).toBeNull();
    expect(stuckNote([user("не работает"), assistant("Поправил."), user("не удалось"), assistant("Ещё раз."), user("подключился, спасибо")])).toBeNull();
  });
});
