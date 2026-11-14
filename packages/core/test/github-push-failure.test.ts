import { describe, expect, it } from "vitest";
import { pushFailure } from "../src/github/github";

// Seen live: a revoked sign-in showed "could not read Username … terminal prompts disabled" in the git card.
describe("why a push to GitHub failed", () => {
  it("names a refused sign-in as such, to connect GitHub again", () => {
    expect(pushFailure("fatal: could not read Username for 'https://github.com': terminal prompts disabled", "gho_x").code).toBe("github_login");
    expect(pushFailure("remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/a/b.git/'", "gho_x").code).toBe("github_login");
  });

  it("keeps git's own words for other refusals, without the token", () => {
    const f = pushFailure("remote: error: File app.exe is 180 MB; this exceeds GitHub's file size limit of 100 MB (gho_secret)", "gho_secret");
    expect(f.code).toBe("push_failed");
    expect(f.message).not.toContain("gho_secret");
  });
});
