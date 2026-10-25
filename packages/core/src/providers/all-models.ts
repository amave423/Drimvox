import type { ListedModel } from "@drimvox/shared";
import { listMediaModels } from "../media/catalog";
import { isCli } from "../cli/kinds";
import { listModels } from "./catalog";
import { fetchJson } from "./http";
import type { Connection } from "./repo";

/**
 * Every model the provider lists, with where Drimvox offers it: a chat, pictures, clips, or nowhere (asked for: to see
 * even the models the app does not support). Nothing here is filtered out.
 */
export async function allModels(conn: Connection): Promise<ListedModel[]> {
  const [text, images, videos] = await Promise.all([
    listModels(conn).catch(() => []),
    listMediaModels(conn, "image").catch(() => []),
    listMediaModels(conn, "video").catch(() => []),
  ]);
  const where = (id: string): ListedModel["offered"] =>
    text.some((m) => m.id === id) ? "text" : images.some((m) => m.id === id) ? "image" : videos.some((m) => m.id === id) ? "video" : null;
  // Programs on a subscription and local engines have no list of their own beyond what Drimvox shows.
  const raw = isCli(conn.preset) || conn.preset === "sdcpp" || conn.preset === "whispercpp" ? [] : await rawList(conn).catch(() => []);
  const seen = new Set<string>();
  const out: ListedModel[] = [];
  for (const m of [...raw, ...text, ...images, ...videos].map((m) => ({ id: m.id, name: m.name }))) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push({ id: m.id, name: m.name, offered: where(m.id) });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** The provider's own list, as it gives it. */
async function rawList(conn: Connection): Promise<{ id: string; name: string }[]> {
  if (conn.preset === "google") {
    const body = (await fetchJson(`${conn.baseUrl}/models?pageSize=1000`, null, 15_000, { "x-goog-api-key": conn.apiKey ?? "" }, conn.fetch)) as {
      models?: { name: string; displayName?: string }[];
    };
    return (body.models ?? []).map((m) => ({ id: m.name.replace(/^models\//, ""), name: m.displayName || m.name.replace(/^models\//, "") }));
  }
  if (conn.preset === "anthropic") {
    const body = (await fetchJson(`${conn.baseUrl}/models?limit=100`, null, 15_000, { "x-api-key": conn.apiKey ?? "", "anthropic-version": "2023-06-01" }, conn.fetch)) as {
      data?: { id: string; display_name?: string }[];
    };
    return (body.data ?? []).map((m) => ({ id: m.id, name: m.display_name || m.id }));
  }
  const body = (await fetchJson(`${conn.baseUrl}/models`, conn.apiKey, 15_000, {}, conn.fetch)) as { data?: unknown } | unknown[];
  const items = Array.isArray(body) ? body : Array.isArray((body as { data?: unknown }).data) ? ((body as { data: unknown[] }).data) : [];
  return items.flatMap((i) => {
    const r = i as { id?: unknown; name?: unknown };
    return typeof r.id === "string" ? [{ id: r.id.replace(/^models\//, ""), name: typeof r.name === "string" && r.name ? r.name : r.id }] : [];
  });
}
