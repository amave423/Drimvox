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

  // Seen in a manual test: GLM's output limit cut a write_file in the middle of the file's text. Closed, it would write
  // half a file; such a call is a cut, not a bracket too many, and is not run.
  it("does not close a text cut in the middle: that is an answer cut by its length", () => {
    expect(balanceJson('{"path": "styles.css", "content": "body { color: red; }\\n.card { pad')).toBeNull();
  });

  it("gives up on what brackets cannot fix", () => {
    expect(balanceJson('{"id": look}')).toBeNull();
  });
});
