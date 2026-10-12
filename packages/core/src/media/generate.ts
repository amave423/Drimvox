import type { MediaModel, MediaOptions } from "@artel/shared";
import { codeForStatus, describeError, detailFromBody, ProviderFailure } from "../providers/errors";
import type { Connection } from "../providers/repo";

const headers = (conn: Connection, json = true) => ({
  Accept: json ? "application/json" : "*/*",
  ...(json ? { "Content-Type": "application/json" } : {}),
  ...(conn.apiKey ? { Authorization: `Bearer ${conn.apiKey}` } : {}),
  ...(conn.preset === "openrouter" ? { "X-Title": "Artel" } : {}),
});

async function request(conn: Connection, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let res: Response;
  try {
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    res = await fetch(url, { ...init, signal });
  } catch (err) {
    throw new ProviderFailure(describeError(err));
  }
  if (!res.ok) {
    const detail = detailFromBody(await res.text().catch(() => ""));
    throw new ProviderFailure(detail ? { code: codeForStatus(res.status), detail } : { code: codeForStatus(res.status) });
  }
  return res;
}

async function postJson(conn: Connection, path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<any> {
  const res = await request(conn, `${conn.baseUrl}${path}`, { method: "POST", headers: headers(conn), body: JSON.stringify(body), signal }, timeoutMs);
  return res.json().catch(() => {
    throw new ProviderFailure({ code: "provider_error", detail: "Not a JSON response" });
  });
}

/** Only the options the model lists are sent: an unsupported value makes the provider refuse. */
function pick(list: string[], value: string | undefined): string | undefined {
  return value && list.includes(value) ? value : undefined;
}

export interface Generated {
  bytes: Buffer;
  mime: string;
  costUsd: number | null;
}

/** Draws one picture. Pictures take seconds to a minute; five minutes is the limit. */
export async function generateImage(conn: Connection, model: MediaModel, prompt: string, o: MediaOptions, signal?: AbortSignal): Promise<Generated> {
  const body = await postJson(
    conn,
    "/images",
    { model: model.id, prompt, n: 1, aspect_ratio: pick(model.aspectRatios, o.aspectRatio), resolution: pick(model.resolutions, o.resolution) },
    5 * 60_000,
    signal,
  );
  const first = Array.isArray(body?.data) ? body.data[0] : undefined;
  if (!first || typeof first.b64_json !== "string") throw new ProviderFailure({ code: "provider_error", detail: "No picture in the answer" });
  return { bytes: Buffer.from(first.b64_json, "base64"), mime: typeof first.media_type === "string" ? first.media_type : "image/png", costUsd: costOf(body) };
}

/** Starts a clip; the provider renders it in the background. Returns the job id. */
export async function submitVideo(conn: Connection, model: MediaModel, prompt: string, o: MediaOptions): Promise<string> {
  const duration = o.duration && model.durations.includes(o.duration) ? o.duration : model.durations[0];
  const body = await postJson(
    conn,
    "/videos",
    {
      model: model.id,
      prompt,
      duration,
      resolution: pick(model.resolutions, o.resolution),
      aspect_ratio: pick(model.aspectRatios, o.aspectRatio),
      generate_audio: model.audio ? (o.audio ?? false) : undefined,
    },
    60_000,
  );
  if (typeof body?.id !== "string") throw new ProviderFailure({ code: "provider_error", detail: "No job id in the answer" });
  return body.id;
}

export type VideoJob =
  | { state: "waiting" }
  | { state: "done"; url: string | null; costUsd: number | null }
  | { state: "failed"; detail: string };

export async function pollVideo(conn: Connection, jobId: string): Promise<VideoJob> {
  const res = await request(conn, `${conn.baseUrl}/videos/${encodeURIComponent(jobId)}`, { headers: headers(conn) }, 30_000);
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  const status = String(body.status ?? "");
  if (status === "completed") {
    const urls = Array.isArray(body.unsigned_urls) ? body.unsigned_urls : [];
    return { state: "done", url: typeof urls[0] === "string" ? urls[0] : null, costUsd: costOf(body) };
  }
  if (status === "failed" || status === "cancelled" || status === "expired") {
    return { state: "failed", detail: typeof body.error === "string" && body.error ? body.error : status };
  }
  return { state: "waiting" };
}

/** The finished clip. Its address needs the key too, despite the name "unsigned". */
export async function downloadVideo(conn: Connection, jobId: string, url: string | null): Promise<Generated> {
  const own = `${conn.baseUrl}/videos/${encodeURIComponent(jobId)}/content?index=0`;
  // The key goes only to the provider's own host, never to an address its answer names.
  const target = url && sameOrigin(url, conn.baseUrl) ? url : own;
  const res = await request(conn, target, { headers: headers(conn, false) }, 10 * 60_000);
  return { bytes: Buffer.from(await res.arrayBuffer()), mime: res.headers.get("content-type")?.split(";")[0] || "video/mp4", costUsd: null };
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function costOf(body: any): number | null {
  const cost = body?.usage?.cost;
  return typeof cost === "number" && Number.isFinite(cost) ? Number(cost.toFixed(9)) : null;
}
