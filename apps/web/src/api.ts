import type { AppType } from "@artel/core";
import { hc } from "hono/client";

/** The desktop window sends its token; a browser on the server is signed in by its session cookie instead. */
export function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function createApi(token: string | null) {
  return hc<AppType>(location.origin, { headers: authHeaders(token) }).api;
}

export type Api = ReturnType<typeof createApi>;

/** Unwraps a successful response. Error branches (e.g. validation 400) throw instead of leaking into T. */
export async function ok<T>(res: { ok: boolean; status: number; json(): Promise<unknown> }): Promise<T> {
  if (!res.ok) throw new Error(`Core answered ${res.status}`);
  return (await res.json()) as T;
}
