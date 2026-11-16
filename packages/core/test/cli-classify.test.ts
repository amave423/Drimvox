import { describe, expect, it } from "vitest";
import { blameProxy, classify } from "../src/cli/run";

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

  // Seen live: Antigravity refused the account itself with a VPN and a proxy on: Google ties an account to a country.
  it("tells the account's country from the place it is used from", () => {
    const error = classify("Eligibility check failed: Your current account is not eligible for Antigravity, because it is not currently available in your location.");
    expect(error.code).toBe("account_region");
    expect(classify("User location is not supported for the API use.").code).toBe("region");
  });

  // Seen live: Codex signed in with ChatGPT, its provider set to the proxy, the proxy down: "workspace routing discovery
  // failed" and nothing else, shown as "the provider returned an error".
  it("tells a lost connection from the provider's error", () => {
    expect(classify("workspace routing discovery failed").code).toBe("unreachable");
    expect(classify("stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)").code).toBe("unreachable");
    expect(classify("The model is not supported").code).toBe("provider_error");
  });

  it("blames the proxy for a lost connection only when the CLI goes through one", () => {
    expect(blameProxy({ code: "unreachable", detail: "x" }, true)).toEqual({ code: "proxy_down", detail: "x" });
    // Silence may be a model thinking long: not blamed on the proxy.
    expect(blameProxy({ code: "timeout" }, true)).toEqual({ code: "timeout" });
    expect(blameProxy({ code: "unreachable" }, false)).toEqual({ code: "unreachable" });
    expect(blameProxy({ code: "cli_login" }, true)).toEqual({ code: "cli_login" });
    expect(blameProxy(null, true)).toBeNull();
  });
});
