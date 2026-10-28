import type { ProviderError, ProviderErrorCode } from "@drimvox/shared";
import { APICallError, RetryError } from "ai";

/** A provider problem already translated into a code the UI understands. */
export class ProviderFailure extends Error {
  constructor(readonly info: ProviderError) {
    super(info.detail ?? info.code);
  }
}

export function codeForStatus(status: number): ProviderErrorCode {
  if (status === 401) return "bad_key";
  // A key that works but may not use this model: closed to the account, or only for some apps (seen on OpenRouter).
  if (status === 403) return "forbidden";
  if (status === 502 || status === 503 || status === 529) return "overloaded";
  if (status === 402) return "no_funds";
  if (status === 429) return "rate_limited";
  if (status === 404) return "model_not_found";
  return "provider_error";
}

/** The provider does not serve the user's country (Google's Gemini API from Russia, say); a proxy helps. */
export const REGION = /location is not supported|unsupported_country|country, region,? or territory|not (currently )?available in your (location|country|region)/i;

/** Google: the model has no free tier for this key ("Quota exceeded … free_tier … limit: 0"); billing helps, waiting does not. */
const NO_FREE_TIER = /free_tier[\s\S]*limit: 0\b|limit: 0\b[\s\S]*free_tier/i;

/** Pulls the human-readable message out of an OpenAI-style error body. */
export function detailFromBody(body: unknown): string | undefined {
  let data: unknown = body;
  if (typeof body === "string") {
    try {
      data = JSON.parse(body);
    } catch {
      return clip(body);
    }
  }
  if (data && typeof data === "object") {
    const record = data as { error?: unknown; message?: unknown; detail?: unknown };
    const error = record.error;
    if (typeof error === "string") return clip(error);
    if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
      return clip((error as { message: string }).message);
    }
    if (typeof record.message === "string") return clip(record.message);
    if (typeof record.detail === "string") return clip(record.detail);
  }
  return undefined;
}

/** A provider's words for "busy for a moment", sent as an error in the stream rather than as a status. */
const BUSY = /temporarily (busy|unavailable|overloaded)|overloaded|server is busy|try again (later|in a few)|retry in a few/i;

/** The SDK's words for an answer it received but could not read. */
const UNREADABLE = /Failed to process successful response|Invalid JSON response|Type validation failed/i;

export function describeError(err: unknown): ProviderError {
  if (err instanceof ProviderFailure) return err.info;
  // After its retries the SDK wraps the provider's last answer: that answer is what to explain.
  if (RetryError.isInstance(err) && err.lastError) return describeError(err.lastError);
  if (APICallError.isInstance(err)) {
    if (err.statusCode === undefined) return withDetail("unreachable", causeText(err.cause) ?? err.message);
    const detail = detailFromBody(err.data ?? err.responseBody) ?? err.message;
    // A 200 whose body could not be read as an answer: the provider speaks another dialect for this model.
    if (err.statusCode < 300) return withDetail("bad_response", detail);
    return withDetail(REGION.test(detail) ? "region" : NO_FREE_TIER.test(detail) ? "no_free_tier" : BUSY.test(detail) ? "overloaded" : codeForStatus(err.statusCode), detail);
  }
  if (err instanceof Error && UNREADABLE.test(err.message)) return withDetail("bad_response", err.message);
  if (err instanceof Error && BUSY.test(err.message)) return withDetail("overloaded", err.message);
  if (err instanceof TypeError) return withDetail("unreachable", causeText(err.cause) ?? err.message);
  if (err instanceof Error && err.name === "TimeoutError") return withDetail("unreachable", "timeout");
  return withDetail("unknown", err instanceof Error ? err.message : String(err));
}

function withDetail(code: ProviderErrorCode, detail: string | undefined): ProviderError {
  return detail ? { code, detail: clip(detail) } : { code };
}

function causeText(cause: unknown): string | undefined {
  if (!cause || typeof cause !== "object") return undefined;
  const c = cause as { code?: unknown; message?: unknown };
  return typeof c.code === "string" ? c.code : typeof c.message === "string" ? c.message : undefined;
}

function clip(text: string): string {
  const t = text.trim();
  return t.length > 300 ? `${t.slice(0, 300)}…` : t;
}
