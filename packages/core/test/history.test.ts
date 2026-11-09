import { describe, expect, it } from "vitest";
import { toModelMessages } from "../src/chats/history";
import type { AttachmentRepo } from "../src/chats/attachment-repo";

const files = {} as AttachmentRepo;

// Seen live: a long chat about a VPN server, its answers kept as text only ("I check the logs. Here are the facts…"); the
// model went on writing such answers with no tool called, inventing what it "checked".
describe("the conversation as the model gets it", () => {
  it("tells under an old answer which tools it called, and that their results are gone", () => {
    const [user, answer, plain] = toModelMessages(
      [
        { role: "user", content: "Проверь сервер" },
        { role: "assistant", content: "Проверил: squid не установлен.", actions: { ssh_run: 13, run_command: 6 } },
        { role: "assistant", content: "Привет!" },
      ],
      files,
      false,
    );
    expect(user!.content).toBe("Проверь сервер");
    expect(answer!.content).toMatch(/^Проверил: squid не установлен\.\n\n\[Drimvox: tools called in this answer: ssh_run ×13, run_command ×6\./);
    expect(answer!.content).toMatch(/call the tools again/);
    expect(plain!.content).toBe("Привет!");
  });
});
