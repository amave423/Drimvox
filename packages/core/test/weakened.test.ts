import { describe, expect, it } from "vitest";
import { weakenedNote, weakenedTests } from "../src/work/weakened";

// Seen in a video the user sent: the agent removed a test's length check instead of fixing the code.
describe("tests weakened to pass", () => {
  it("finds a test file that lost assertions, not one whose assertions were rewritten or code that changed", () => {
    const patch = [
      "diff --git a/test/read.test.ts b/test/read.test.ts",
      "--- a/test/read.test.ts",
      "+++ b/test/read.test.ts",
      "@@ -1,4 +1,3 @@",
      "   const out = read(file);",
      "-  expect(out.length).toBe(4000);",
      "   expect(out).toContain(\"start\");",
      "diff --git a/test/other.test.ts b/test/other.test.ts",
      "--- a/test/other.test.ts",
      "+++ b/test/other.test.ts",
      "-  expect(a).toBe(1);",
      "+  expect(a).toBe(2);",
      "diff --git a/src/read.ts b/src/read.ts",
      "--- a/src/read.ts",
      "+++ b/src/read.ts",
      "-  assert(x);",
    ].join("\n");
    expect(weakenedTests(patch)).toEqual([{ file: "test/read.test.ts", removed: 1, added: 0 }]);
    expect(weakenedNote(weakenedTests(patch))).toContain("test/read.test.ts (1 fewer)");
    expect(weakenedNote([])).toBe("");
  });
});
