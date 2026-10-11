import { codeForStatus, detailFromBody, describeError, ProviderFailure } from "./errors";

/** GET a provider endpoint as JSON. Failures become ProviderFailure with a UI code. */
export async function fetchJson(url: string, apiKey: string | null, timeoutMs = 15_000): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ProviderFailure(describeError(err));
  }
  const text = await res.text();
  if (!res.ok) {
    const detail = detailFromBody(text);
    throw new ProviderFailure(detail ? { code: codeForStatus(res.status), detail } : { code: codeForStatus(res.status) });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderFailure({ code: "provider_error", detail: "Not a JSON response" });
  }
}
