import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useApp } from "../context";

/**
 * A picture that opens over the whole window on click (seen: attached and sent pictures could not be looked at):
 * Escape, the cross or a click beside it closes it.
 */
export function ZoomableImage({ src, alt, className, download }: { src: string; alt: string; className?: string; download?: string }) {
  const { t } = useApp();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button type="button" className="zoomable" aria-label={t("viewer.open", { name: alt || t("viewer.picture") })} onClick={() => setOpen(true)}>
        <img className={className} src={src} alt={alt} />
      </button>
      {open &&
        createPortal(
          <div className="lightbox" role="dialog" aria-modal="true" aria-label={alt || t("viewer.picture")} onClick={() => setOpen(false)}>
            <img src={src} alt={alt} onClick={(e) => e.stopPropagation()} />
            <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
              {alt && <span className="lightbox-name">{alt}</span>}
              {download && (
                <a className="lightbox-action" href={src} download={download}>
                  {t("media.save")}
                </a>
              )}
              <button type="button" className="lightbox-action" onClick={() => setOpen(false)}>
                {t("viewer.close")}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
