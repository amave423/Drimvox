import type { LocalImagesStatus, LocalPull, LocalStatus } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { ok } from "../api";
import { useApp } from "../context";
import { useTimeLeft } from "./local/PullControl";

/** Said by a sheet that started a download, so the bottom bar shows it at once. */
export const DOWNLOADS_CHANGED = "drimvox-downloads";
export const downloadsChanged = () => window.dispatchEvent(new Event(DOWNLOADS_CHANGED));

/** Asked this often while something downloads, and rarely otherwise: a download may start from another window. */
const BUSY_MS = 2000;
const IDLE_MS = 15_000;

interface Download {
  name: string;
  pull: LocalPull;
}

/** The downloads going on now, from the local models' and pictures' states. */
export function activeDownloads(local: LocalStatus | null, images: LocalImagesStatus | null): Download[] {
  const going = (p: LocalPull | null | undefined): p is LocalPull => !!p && !p.done && !p.paused && !p.error;
  return [
    ...(local?.pulls ?? []).filter(going).map((pull) => ({ name: pull.model, pull })),
    ...(images?.models ?? []).filter((m) => going(m.pull)).map((m) => ({ name: m.name, pull: m.pull! })),
    ...(going(images?.enginePull) ? [{ name: "stable-diffusion.cpp", pull: images!.enginePull! }] : []),
  ];
}

/**
 * A local model downloading, in the bottom bar wherever the user is (seen: leaving the local models' sheet hid how
 * far it got). A click opens that sheet.
 */
export function DownloadNote() {
  const { api, t, navigate } = useApp();
  const left = useTimeLeft();
  const [downloads, setDownloads] = useState<Download[]>([]);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const [local, images] = await Promise.all([
        api.local.$get().then((r) => ok<LocalStatus>(r)).catch(() => null),
        api.local.images.$get().then((r) => ok<LocalImagesStatus>(r)).catch(() => null),
      ]);
      if (stop) return;
      const now = activeDownloads(local, images);
      setDownloads(now);
      // One timer even when a tick was asked for while another was on its way.
      clearTimeout(timer);
      timer = setTimeout(() => void tick(), now.length ? BUSY_MS : IDLE_MS);
    };
    const now = () => {
      clearTimeout(timer);
      void tick();
    };
    void tick();
    window.addEventListener(DOWNLOADS_CHANGED, now);
    return () => {
      stop = true;
      clearTimeout(timer);
      window.removeEventListener(DOWNLOADS_CHANGED, now);
    };
  }, [api]);

  if (!downloads.length) return null;
  const first = downloads[0]!;
  const share = first.pull.total > 0 ? Math.min(100, Math.round((first.pull.completed / first.pull.total) * 100)) : 0;
  const time = left(first.pull);
  return (
    <button type="button" className="download-note" onClick={() => navigate({ kind: "local" })}>
      <progress max={100} value={share} aria-hidden />
      <span>
        {t("bottom.downloading", { name: first.name, share })}
        {time ? ` · ${time}` : ""}
        {downloads.length > 1 ? ` ${t("bottom.downloadingMore", { n: downloads.length - 1 })}` : ""}
      </span>
    </button>
  );
}
