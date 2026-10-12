import type { MediaKind, MediaModel } from "@artel/shared";
import { useEffect, useState } from "react";
import type { Api } from "../api";

const lists = new Map<string, Promise<MediaModel[]>>();
const details = new Map<string, Promise<MediaModel | null>>();

/** Image or video models of a provider; empty for providers without a media API. Never rejects. */
export function loadMediaModels(api: Api, providerId: string, kind: MediaKind): Promise<MediaModel[]> {
  const key = `${providerId}|${kind}`;
  let hit = lists.get(key);
  if (!hit) {
    hit = api.providers[":id"]["media-models"]
      .$get({ param: { id: providerId }, query: { kind } })
      .then(async (r) => (r.ok ? ((await r.json()) as MediaModel[]) : []))
      .catch(() => []);
    lists.set(key, hit);
  }
  return hit;
}

/** One model with its prices, for the estimate. */
export function loadMediaModel(api: Api, providerId: string, kind: MediaKind, model: string): Promise<MediaModel | null> {
  const key = `${providerId}|${kind}|${model}`;
  let hit = details.get(key);
  if (!hit) {
    hit = api.providers[":id"]["media-models"].one
      .$get({ param: { id: providerId }, query: { kind, model } })
      .then(async (r) => (r.ok ? ((await r.json()) as MediaModel) : null))
      .catch(() => null);
    details.set(key, hit);
    void hit.then((m) => m === null && details.delete(key));
  }
  return hit;
}

const blobs = new Map<string, Promise<string | null>>();

/**
 * Files come from the core with the token, which an <img> cannot send; they are fetched and shown
 * as blob URLs. Each file is fetched once per session.
 */
export function useAuthorizedUrl(url: string | null, token: string): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return setSrc(null);
    let live = true;
    let hit = blobs.get(url);
    if (!hit) {
      hit = fetch(url, { headers: { Authorization: `Bearer ${token}` } })
        .then(async (r) => (r.ok ? URL.createObjectURL(await r.blob()) : null))
        .catch(() => null);
      blobs.set(url, hit);
      void hit.then((s) => s === null && blobs.delete(url));
    }
    void hit.then((s) => live && setSrc(s));
    return () => {
      live = false;
    };
  }, [url, token]);
  return src;
}

export const mediaUrl = (id: string) => `/api/media/${id}/content`;

/** A name for "Save as": the start of the prompt and the right extension. */
export function fileName(prompt: string, mime: string): string {
  const ext = mime.split("/")[1]?.replace("jpeg", "jpg").replace("svg+xml", "svg") ?? "bin";
  const base = prompt.trim().slice(0, 40).replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "artel";
  return `${base}.${ext}`;
}
