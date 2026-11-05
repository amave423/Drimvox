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

  // Seen live: a reseller's answer for a model with tools could not be read, and the user saw only "provider error".
  // Seen live (Groq): a small model refused the chat's tools, and a free tier's tokens per minute were less than one request.
  it("tells a model that cannot use tools, and a request larger than the model or its free tier takes", () => {
    expect(describeError(failure(400, "`tool calling` is not supported with this model")).code).toBe("no_tools");
    expect(describeError(failure(400, "This model does not support function calling")).code).toBe("no_tools");
    expect(describeError(failure(413, "Request too large for model `openai/gpt-oss-safeguard-20b` in organization on tokens per minute (TPM): Limit 8000, Requested 9500")).code).toBe("too_large");
    expect(describeError(failure(400, "This model's maximum context length is 8192 tokens")).code).toBe("too_large");
  });

  it("tells an answer that came but could not be read", () => {
    expect(describeError(failure(200, "Failed to process successful response")).code).toBe("bad_response");
    expect(describeError(new Error("Type validation failed: Value: {}")).code).toBe("bad_response");
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
