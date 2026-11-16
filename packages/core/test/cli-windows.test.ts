import { describe, expect, it } from "vitest";
import { cliRules, WINDOWS_FILES_HINT } from "../src/cli/windows";

describe("a CLI agent's rules on Windows", () => {
  it("warns that PowerShell breaks non-Latin text, on Windows only", () => {
    expect(cliRules("Rules.", "win32")).toBe(`Rules.\n\n${WINDOWS_FILES_HINT}`);
    expect(WINDOWS_FILES_HINT).toMatch(/Set-Content[\s\S]*utf8/);
    expect(cliRules("Rules.", "linux")).toBe("Rules.");
    expect(cliRules("Rules.", "darwin")).toBe("Rules.");
  });
});
