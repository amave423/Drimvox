import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { describeError, detailFromBody } from "../src/providers/errors";

const failure = (status: number, message: string) =>
  new APICallError({ message, url: "https://x/v1/chat/completions", requestBodyValues: {}, statusCode: status, responseBody: JSON.stringify({ error: { message } }) });

// Seen live: free models refused for reasons of their own, and Drimvox told the user the key was wrong.
describe("describeError", () => {
  // Seen live: "Failed to process successful response" stopped a run; why it could not be read is in the cause.
  it("says why a 200 answer could not be read", () => {
    const err = new APICallError({ message: "Failed to process successful response", url: "u", requestBodyValues: {}, statusCode: 200, cause: Object.assign(new TypeError("terminated"), { cause: { code: "UND_ERR_SOCKET", message: "other side closed" } }) });
    expect(describeError(err).code).toBe("bad_response");
    expect(describeError(err).detail).toMatch(/terminated|other side closed|UND_ERR_SOCKET/);
  });

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

// Seen live: "Provider returned error" three times in an hour, the provider's own words hidden in metadata.raw.
describe("a router's error", () => {
  it("says what the provider behind the router said", () => {
    const body = { error: { message: "Provider returned error", code: 502, metadata: { raw: "upstream timeout after 60s", provider_name: "DeepInfra" } } };
    expect(detailFromBody(body)).toBe("Provider returned error (DeepInfra: upstream timeout after 60s)");
    expect(detailFromBody({ error: { message: "Provider returned error" } })).toBe("Provider returned error");
  });

  it("reads one sent inside the stream as the provider's object", () => {
    expect(describeError({ message: "Provider returned error", metadata: { raw: { error: "context length exceeded" } } })).toEqual({
      code: "too_large",
      detail: 'Provider returned error ({"error":"context length exceeded"})',
    });
  });
});
