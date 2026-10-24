import type { MediaModel, MediaOptions } from "@drimvox/shared";
import { codeForStatus, describeError, detailFromBody, ProviderFailure } from "../providers/errors";
import type { Connection } from "../providers/repo";
import { usdPer } from "../rates";
import { drawLocally } from "./local";

const headers = (conn: Connection, json = true) => ({
  Accept: json ? "application/json" : "*/*",
  ...(json ? { "Content-Type": "application/json" } : {}),
  ...(conn.apiKey ? { Authorization: `Bearer ${conn.apiKey}` } : {}),
  ...(conn.preset === "openrouter" ? { "X-Title": "Drimvox" } : {}),
});

async function request(conn: Connection, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let res: Response;
  try {
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    res = await conn.fetch(url, { ...init, signal });
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

/** A photo from the chat, for a model that takes one (docs/specs/media.md). */
export interface Photo {
  mime: string;
  data: Buffer;
}

const dataUrl = (p: Photo) => `data:${p.mime};base64,${p.data.toString("base64")}`;

export interface Generated {
  bytes: Buffer;
  mime: string;
  costUsd: number | null;
}

/** Draws one picture. Pictures take seconds to a minute; five minutes is the limit. */
export async function generateImage(conn: Connection, model: MediaModel, prompt: string, o: MediaOptions, signal?: AbortSignal, photos: Photo[] = []): Promise<Generated> {
  if (conn.preset === "sdcpp") return drawLocally(model.id, prompt, o.aspectRatio, signal);
  if (model.viaChat) return drawInChat(conn, model, prompt, o, signal, photos);
  const body = await postJson(
    conn,
    "/images",
    {
      model: model.id,
      prompt,
      n: 1,
      aspect_ratio: pick(model.aspectRatios, o.aspectRatio),
      resolution: pick(model.resolutions, o.resolution),
      ...(photos.length ? { input_references: photos.map((p) => ({ type: "image_url", image_url: { url: dataUrl(p) } })) } : {}),
    },
    5 * 60_000,
    signal,
  );
  const first = Array.isArray(body?.data) ? body.data[0] : undefined;
  if (!first || typeof first.b64_json !== "string") throw new ProviderFailure({ code: "provider_error", detail: "No picture in the answer" });
  return {
    bytes: Buffer.from(first.b64_json, "base64"),
    mime: typeof first.media_type === "string" ? first.media_type : sniff(first.b64_json),
    costUsd: await costOf(conn, body),
  };
}

/** Gemini-style models answer a chat request with text and pictures as data: URLs. */
async function drawInChat(conn: Connection, model: MediaModel, prompt: string, o: MediaOptions, signal?: AbortSignal, photos: Photo[] = []): Promise<Generated> {
  const aspect = pick(model.aspectRatios, o.aspectRatio);
  // Photos go with the words, as pictures in the message.
  const content = photos.length ? [{ type: "text", text: prompt }, ...photos.map((p) => ({ type: "image_url", image_url: { url: dataUrl(p) } }))] : prompt;
  const body = await postJson(
    conn,
    "/chat/completions",
    {
      model: model.id,
      messages: [{ role: "user", content }],
      modalities: ["image", "text"],
      ...(aspect ? { image_config: { aspect_ratio: aspect } } : {}),
    },
    5 * 60_000,
    signal,
  );
  const url = body?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  const match = typeof url === "string" ? url.match(/^data:([^;,]+);base64,(.*)$/s) : null;
  if (!match) throw new ProviderFailure({ code: "provider_error", detail: "No picture in the answer" });
  return { bytes: Buffer.from(match[2]!, "base64"), mime: match[1]!, costUsd: await costOf(conn, body) };
}

/** PNG and JPEG are told apart by their first bytes when the answer does not say. */
function sniff(b64: string): string {
  if (b64.startsWith("/9j/")) return "image/jpeg";
  if (b64.startsWith("UklGR")) return "image/webp";
  return "image/png";
}

/** Starts a clip; the provider renders it in the background. Returns the job id. */
export async function submitVideo(conn: Connection, model: MediaModel, prompt: string, o: MediaOptions, photos: Photo[] = []): Promise<string> {
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
      // The photo is the clip's first frame.
      ...(photos[0] ? { frame_images: [{ type: "image_url", image_url: { url: dataUrl(photos[0]) }, frame_type: "first_frame" }] } : {}),
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
    return { state: "done", url: typeof urls[0] === "string" ? urls[0] : null, costUsd: await costOf(conn, body) };
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

/** The provider's own cost of a request, in dollars; RouterAI reports rubles. */
async function costOf(conn: Connection, body: any): Promise<number | null> {
  const cost = body?.usage?.cost;
  if (typeof cost !== "number" || !Number.isFinite(cost)) return null;
  return Number((cost * (await usdPer(conn.currency))).toFixed(9));
}
