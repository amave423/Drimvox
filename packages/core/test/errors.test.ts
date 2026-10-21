import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { describeError } from "../src/providers/errors";

const failure = (status: number, message: string) =>
  new APICallError({ message, url: "https://x/v1/chat/completions", requestBodyValues: {}, statusCode: status, responseBody: JSON.stringify({ error: { message } }) });

// Seen live: free models refused for reasons of their own, and Drimvox told the user the key was wrong.
describe("describeError", () => {
  it("tells a wrong key from a model the key may not use", () => {
    expect(describeError(failure(401, "Invalid API key")).code).toBe("bad_key");
    expect(describeError(failure(403, "inkling:free is only available on agentic harnesses")).code).toBe("forbidden");
  });

  it("tells an overloaded model from a broken one", () => {
    expect(describeError(failure(503, "Upstream error from Nvidia: Service temporarily overloaded")).code).toBe("overloaded");
    expect(describeError(failure(529, "Overloaded")).code).toBe("overloaded");
    expect(describeError(failure(500, "boom")).code).toBe("provider_error");
  });

  it("says when the provider does not serve the user's country", () => {
    expect(describeError(failure(400, "User location is not supported for the API use.")).code).toBe("region");
    expect(describeError(failure(403, "unsupported_country_region_territory")).code).toBe("region");
  });
});
