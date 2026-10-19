import type { MediaItem } from "@artel/shared";
import { useApp } from "../../context";
import { fileName, mediaUrl, useAuthorizedUrl } from "../../lib/media";
import { ZoomableImage } from "../Lightbox";
import { VideoPlayer } from "./VideoPlayer";

/** A picture or a clip from the core, with a link to save it. */
export function MediaView({ item, compact = false }: { item: MediaItem; compact?: boolean }) {
  const { t, token } = useApp();
  const src = useAuthorizedUrl(mediaUrl(item.id), token);
  return (
    <figure className={`media${compact ? " is-compact" : ""}`}>
      {!src ? (
        <div className="media-wait" aria-busy />
      ) : item.kind === "image" ? (
        <ZoomableImage src={src} alt={item.prompt} download={fileName(item.prompt, item.mime)} />
      ) : (
        <VideoPlayer src={src} label={item.prompt} />
      )}
      {src && !compact && (
        <figcaption>
          <a className="link" href={src} download={fileName(item.prompt, item.mime)}>
            {t("media.save")}
          </a>
        </figcaption>
      )}
    </figure>
  );
}
