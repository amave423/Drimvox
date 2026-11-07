import { describe, expect, it } from "vitest";
import { checksReport } from "../src/work/checks";

// Seen live: a passed build's raw output with the terminal's colour codes ended the agent's report.
describe("the checks under the report", () => {
  it("says a passed check in one line and shows a failed one's output without colour codes", () => {
    const report = checksReport(
      [
        { command: "npm run build", ok: true, tail: "\u001b[32m✓\u001b[39m 1894 modules transformed." },
        { command: "npm test", ok: false, tail: "\u001b[31mFAIL\u001b[39m сумма неверна" },
      ] as never,
      true,
    );
    expect(report).toContain("- `npm run build` — прошли");
    expect(report).not.toContain("modules transformed");
    expect(report).toContain("FAIL сумма неверна");
    expect(report).not.toContain("\u001b");
  });
});
