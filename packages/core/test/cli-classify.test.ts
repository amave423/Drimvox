import { describe, expect, it } from "vitest";
import { classify } from "../src/cli/run";

describe("a CLI's failure in plain words", () => {
  // Seen live: Gemini CLI on Windows 10 put two warnings about the terminal before the real error.
  it("leaves out the CLI's warnings about the terminal", () => {
    const error = classify(
      [
        "Warning: Windows 10 detected. Some UI features like smooth scrolling may be degraded.",
        "Warning: 256-color support not detected.",
        "Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals.",
      ].join("\n"),
    );
    expect(error.code).toBe("cli_retired");
    expect(error.detail).toMatch(/^Error authenticating/);
  });
});
