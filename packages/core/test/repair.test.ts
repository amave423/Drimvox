import { describe, expect, it } from "vitest";
import { balanceJson } from "../src/agent/repair";

// Seen live: DeepSeek's ask_questions ended with `}}}}]}`, one brace too many, and the interview was skipped.
describe("tool input with its brackets wrong", () => {
  it("drops a closing bracket that closes nothing", () => {
    expect(balanceJson('{"a": [{"b": {"c": 1}}}]}')).toBe('{"a": [{"b": {"c": 1}}]}');
  });

  it("closes what is left open at the end", () => {
    expect(JSON.parse(balanceJson('{"a": [1, 2')!)).toEqual({ a: [1, 2] });
  });

  it("leaves brackets inside strings alone", () => {
    expect(JSON.parse(balanceJson('{"t": "a } ] \\" {"}}')!)).toEqual({ t: 'a } ] " {' });
  });

  it("gives up on what brackets cannot fix", () => {
    expect(balanceJson('{"id": look}')).toBeNull();
  });
});
