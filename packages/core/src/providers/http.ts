import { codeForStatus, detailFromBody, describeError, ProviderFailure } from "./errors";

/** GET a provider endpoint as JSON. Failures become ProviderFailure with a UI code. */
export async function fetchJson(
  url: string,
  apiKey: string | null,
  timeoutMs = 15_000,
  headers: Record<string, string> = {},
  /** The provider's own fetch, straight or through its proxy. */
  fetchFn: typeof fetch = fetch,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: { Accept: "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...headers },
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
