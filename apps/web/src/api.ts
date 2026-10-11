import type { AppType } from "@artel/core";
import { hc } from "hono/client";

export function createApi(token: string) {
  return hc<AppType>(location.origin, { headers: { Authorization: `Bearer ${token}` } }).api;
}

export type Api = ReturnType<typeof createApi>;

/** Unwraps a successful response. Error branches (e.g. validation 400) throw instead of leaking into T. */
export async function ok<T>(res: { ok: boolean; status: number; json(): Promise<unknown> }): Promise<T> {
  if (!res.ok) throw new Error(`Core answered ${res.status}`);
  return (await res.json()) as T;
}
