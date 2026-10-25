import { useEffect, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { useApp } from "../context";
import { dimTitleBar } from "../theme";
import { CrossIcon } from "./SideChats";

/** Copies a picture to the clipboard as PNG, the one kind every program pastes. */
async function copyPicture(src: string): Promise<void> {
  const blob = await (await fetch(src)).blob();
  const png =
    blob.type === "image/png"
      ? blob
      : await new Promise<Blob>((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            canvas.getContext("2d")!.drawImage(img, 0, 0);
            canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("no picture"))), "image/png");
          };
          img.onerror = () => reject(new Error("no picture"));
          img.src = src;
        });
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

/** Save and copy, at the pointer, on a right click (seen: the buttons under a picture were awkward). */
function PictureMenu({ at, src, download, onClose }: { at: { x: number; y: number }; src: string; download?: string; onClose(): void }) {
  const { t } = useApp();
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
    };
  }, [onClose]);
  return createPortal(
    <div className="picture-menu" role="menu" style={{ left: at.x, top: at.y }} onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      <a className="picture-menu-item" role="menuitem" href={src} download={download ?? "picture"} onClick={onClose}>
        {t("viewer.save")}
      </a>
      <button
        type="button"
        className="picture-menu-item"
        role="menuitem"
        onClick={() => {
          void copyPicture(src).catch(() => {});
          onClose();
        }}
      >
        {t("viewer.copy")}
      </button>
    </div>,
    document.body,
  );
}

/**
 * A picture that opens over the whole window on click (seen: attached and sent pictures could not be looked at). It fits
 * the window however large it is; the cross, Escape or a click beside it closes it; a right click saves or copies it.
 */
export function ZoomableImage({ src, alt, className, download }: { src: string; alt: string; className?: string; download?: string }) {
  const { t } = useApp();
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  // The window's buttons dim with the page under the viewer.
  useEffect(() => {
    if (!open) return;
    dimTitleBar(true, "--overlay");
    return () => dimTitleBar(false, "--overlay");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Caught before anything else on the page (seen: Escape did not close it).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setMenu(null);
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: Math.min(e.clientX, window.innerWidth - 220), y: Math.min(e.clientY, window.innerHeight - 100) });
  };

  return (
    <>
      <button
        type="button"
        className="zoomable"
        aria-label={t("viewer.open", { name: alt || t("viewer.picture") })}
        onClick={() => setOpen(true)}
        onContextMenu={onContextMenu}
      >
        <img className={className} src={src} alt={alt} />
      </button>
      {open &&
        createPortal(
          <div className="lightbox" role="dialog" aria-modal="true" aria-label={alt || t("viewer.picture")} onClick={() => setOpen(false)}>
            <img src={src} alt={alt} onClick={(e) => e.stopPropagation()} onContextMenu={onContextMenu} />
            <button
              type="button"
              className="lightbox-close"
              aria-label={t("viewer.close")}
              title={t("viewer.close")}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
              }}
            >
              <CrossIcon />
            </button>
          </div>,
          document.body,
        )}
      {menu && <PictureMenu at={menu} src={src} download={download} onClose={() => setMenu(null)} />}
    </>
  );
}
