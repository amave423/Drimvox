import type { MediaItem } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { ok } from "../api";
import { CheckIcon, CrossIcon } from "./SideChats";
import { useApp } from "../context";
import { formatUsd } from "../lib/format";
import { MediaView } from "./chat/MediaView";

/** Every picture and clip, newest first: what it was asked for, where it came from, what it cost. */
export function GallerySheet() {
  const { api, t, settings, navigate, openNewChat } = useApp();
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  async function load() {
    setItems(await api.media.$get().then((r) => ok<MediaItem[]>(r)).catch(() => []));
  }

  useEffect(() => {
    void load();
  }, []);

  async function remove(id: string) {
    await api.media[":id"].$delete({ param: { id } }).catch(() => null);
    setRemoving(null);
    await load();
  }

  const date = (ms: number) => new Date(ms).toLocaleDateString(settings.locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <article className="sheet gallery-sheet">
      <div className="sheet-body">
        <h1>{t("gallery.title")}</h1>
        <p className="lede">{t("gallery.lede")}</p>
        {/* Empty: where the pictures will stand and how to make the first (seen: one grey line on a big empty sheet). */}
        {items?.length === 0 && (
          <div className="gallery-empty">
            <div className="gallery-empty-frames" aria-hidden>
              <span />
              <span />
              <span />
            </div>
            <p className="muted">{t("gallery.empty")}</p>
            <button className="btn is-primary" onClick={openNewChat}>
              {t("gallery.makeFirst")}
            </button>
          </div>
        )}
        <ul className="gallery">
          {items?.map((item) => (
            <li key={item.id} className="gallery-card">
              <MediaView item={item} />
              <p className="gallery-prompt">{item.prompt}</p>
              <p className="gallery-meta mono muted">
                {item.model}
                <br />
                {item.costUsd === null ? t("gallery.noCost") : formatUsd(item.costUsd)} · {date(item.createdAt)}
                {item.path && (
                  <>
                    <br />
                    {item.path}
                  </>
                )}
              </p>
              <div className="gallery-actions">
                {item.chatId && (
                  <button className="link" onClick={() => navigate({ kind: "chat", chatId: item.chatId!, key: item.chatId! })}>
                    {t("gallery.openChat")}
                  </button>
                )}
                {item.taskId && (
                  <button className="link" onClick={() => navigate({ kind: "task", taskId: item.taskId! })}>
                    {t("gallery.openTask")}
                  </button>
                )}
                {removing === item.id ? (
                  // Delete it? A check mark and a cross, as for chats (asked for: not "really delete" in words).
                  <span className="gallery-confirm">
                    <button className="icon-button is-pencil" aria-label={t("gallery.removeConfirm")} title={t("gallery.removeConfirm")} onClick={() => void remove(item.id)}>
                      <CheckIcon />
                    </button>
                    <button className="icon-button" aria-label={t("side.deleteNo")} title={t("side.deleteNo")} onClick={() => setRemoving(null)}>
                      <CrossIcon />
                    </button>
                  </span>
                ) : (
                  <button className="link is-pencil" onClick={() => setRemoving(item.id)}>
                    {t("gallery.remove")}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}
