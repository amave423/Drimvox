// Media part of the live check (`--media`, `--video`): a real picture and, if asked, a real clip on the cheapest models.
import { estimateCost, isRoughEstimate, type MediaModel, type MediaOptions, type MessageView, type StreamEvent } from "@artel/shared";

type Api = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
type Send = (chatId: string, body: unknown) => Promise<StreamEvent[]>;

/** About $0.007 a picture as of 2026-10-12. */
const IMAGE_MODEL = "recraft/recraft-v4.1-flash";

/** "480p" → 480, "2k" → 2000: for picking the lowest resolution. */
const height = (r: string) => (r.toLowerCase().endsWith("k") ? parseFloat(r) * 1000 : parseInt(r, 10) || Infinity);

export async function checkMedia(api: Api, send: Send, providerId: string, withVideo: boolean, log: (...p: unknown[]) => void): Promise<boolean> {
  const images = (await api("GET", `/providers/${providerId}/media-models?kind=image`)).body as MediaModel[];
  const videos = (await api("GET", `/providers/${providerId}/media-models?kind=video`)).body as MediaModel[];
  log(`media: ${images.length} image models, ${videos.length} video models`);
  if (images.length === 0) return false;

  // A catalog with prices (RouterAI) gives the cheapest picture model; otherwise a known cheap one.
  const cheapest = images
    .filter((m) => m.pricing && !m.viaChat && !isRoughEstimate(m))
    .map((m) => ({ m, usd: estimateCost(m, {}) }))
    .filter((x): x is { m: MediaModel; usd: number } => x.usd !== null && x.usd > 0)
    .sort((a, b) => a.usd - b.usd)[0]?.m.id;
  const image = (await api("GET", `/providers/${providerId}/media-models/one?kind=image&model=${cheapest ?? IMAGE_MODEL}`)).body as MediaModel;
  const estimate = estimateCost(image, {});
  log(`image ${image.id}: estimate $`, estimate);
  const picture = await make(api, send, providerId, image, "A small red fox in a green scarf, flat vector icon", {}, estimate === null || estimate > 0.1);
  log("  picture:", { status: picture.message.status, costUsd: picture.message.costUsd, media: picture.message.media.map((m) => m.mime), error: picture.message.error });
  if (picture.message.status !== "done" || picture.message.media.length !== 1) return false;
  if ((await api("GET", `/media/${picture.message.media[0]!.id}/content`)).status !== 200) return false;
  if (!withVideo) return true;

  // The cheapest clip: shortest length, lowest resolution, no sound.
  const priced = videos
    .map((m) => {
      const options: MediaOptions = { duration: m.durations[0], resolution: [...m.resolutions].sort((a, b) => height(a) - height(b))[0], audio: false };
      return { m, options, usd: estimateCost(m, options) };
    })
    .filter((v): v is typeof v & { usd: number } => v.usd !== null)
    .sort((a, b) => a.usd - b.usd);
  const clipModel = priced[0];
  if (!clipModel) return false;
  log(`video ${clipModel.m.id}: estimate $${clipModel.usd}`, clipModel.options);
  const clip = await make(api, send, providerId, clipModel.m, "Waves rolling onto a beach at sunset, slow camera pan", clipModel.options, true);
  let last = clip.message;
  const until = Date.now() + 15 * 60_000;
  while (last.status === "streaming" && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 10_000));
    last = ((await api("GET", `/chats/${clip.chatId}`)).body as { messages: MessageView[] }).messages.at(-1)!;
  }
  log("  clip:", { status: last.status, costUsd: last.costUsd, media: last.media.map((m) => m.mime), error: last.error });
  return last.status === "done" && last.media.length === 1;
}

async function make(api: Api, send: Send, providerId: string, model: MediaModel, prompt: string, options: MediaOptions, confirm: boolean) {
  const chat = (await api("POST", "/chats", { providerId, model: model.id, kind: model.kind })).body as { id: string };
  const done = (await send(chat.id, { content: prompt, options, confirm })).find((e) => e.type === "done") as Extract<StreamEvent, { type: "done" }>;
  return { chatId: chat.id, message: done.message };
}
