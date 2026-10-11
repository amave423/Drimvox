import type { ProviderError, ProviderErrorCode } from "@artel/shared";
import { APICallError } from "ai";

/** A provider problem already translated into a code the UI understands. */
export class ProviderFailure extends Error {
  constructor(readonly info: ProviderError) {
    super(info.detail ?? info.code);
  }
}

export function codeForStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return "bad_key";
  if (status === 402) return "no_funds";
  if (status === 429) return "rate_limited";
  if (status === 404) return "model_not_found";
  return "provider_error";
}

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

export function describeError(err: unknown): ProviderError {
  if (err instanceof ProviderFailure) return err.info;
  if (APICallError.isInstance(err)) {
    if (err.statusCode === undefined) return withDetail("unreachable", causeText(err.cause) ?? err.message);
    return withDetail(codeForStatus(err.statusCode), detailFromBody(err.data ?? err.responseBody) ?? err.message);
  }
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
