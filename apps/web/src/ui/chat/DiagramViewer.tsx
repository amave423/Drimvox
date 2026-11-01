import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import { createPortal } from "react-dom";
import { useApp } from "../../context";
import { dimTitleBar } from "../../theme";
import { CrossIcon } from "../SideChats";

const MIN = 0.2;
const MAX = 8;

/** The SVG's own size, from its viewBox. */
function naturalSize(svg: string): { w: number; h: number } {
  const box = /viewBox="[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)"/.exec(svg);
  return box ? { w: Number(box[1]), h: Number(box[2]) } : { w: 800, h: 600 };
}

/** The SVG at its own size, without the width Mermaid fits to the column. */
function sized(svg: string): string {
  const { w, h } = naturalSize(svg);
  return svg.replace(/<svg([^>]*?)\sstyle="[^"]*"/, "<svg$1").replace(/<svg([^>]*?)\swidth="[^"]*"/, "<svg$1").replace("<svg", `<svg width="${w}" height="${h}"`);
}

function save(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** The diagram as a PNG at twice its size, on the page's background. */
function png(svg: string, background: string): Promise<Blob> {
  const { w, h } = naturalSize(svg);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(w * 2);
      canvas.height = Math.ceil(h * 2);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("no picture"))), "image/png");
    };
    img.onerror = () => reject(new Error("no picture"));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized(svg))}`;
  });
}

/**
 * A diagram over the whole window (seen: big diagrams came out tiny in the answer and could not be zoomed): it opens
 * fitted to the window; the wheel zooms where the pointer is, dragging moves it; it can be saved as SVG or PNG.
 */
export function DiagramViewer({ svg, onClose }: { svg: string; onClose(): void }) {
  const { t } = useApp();
  const stage = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const size = naturalSize(svg);

  const fit = () => {
    const r = stage.current?.getBoundingClientRect();
    if (!r) return;
    // Fitted, but a small diagram is not blown up past twice its size.
    const scale = Math.min(2, Math.max(MIN, Math.min((r.width - 48) / size.w, (r.height - 48) / size.h)));
    setView({ scale, x: (r.width - size.w * scale) / 2, y: (r.height - size.h * scale) / 2 });
  };
  useLayoutEffect(fit, [svg]);

  useEffect(() => {
    dimTitleBar(true, "--overlay");
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      dimTitleBar(false, "--overlay");
    };
  }, [onClose]);

  /** Zoom by a factor around a point of the stage, so what is under it stays there. */
  const zoom = (factor: number, at?: { x: number; y: number }) =>
    setView((v) => {
      const r = stage.current!.getBoundingClientRect();
      const p = at ?? { x: r.width / 2, y: r.height / 2 };
      const scale = Math.min(MAX, Math.max(MIN, v.scale * factor));
      const k = scale / v.scale;
      return { scale, x: p.x - (p.x - v.x) * k, y: p.y - (p.y - v.y) * k };
    });
  const onWheel = (e: WheelEvent) => {
    const r = stage.current!.getBoundingClientRect();
    zoom(Math.exp(-e.deltaY * 0.0015), { x: e.clientX - r.left, y: e.clientY - r.top });
  };
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (d) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
  };
  const background = getComputedStyle(document.documentElement).getPropertyValue("--sheet").trim() || "#ffffff";

  return createPortal(
    <div className="lightbox diagram-viewer" role="dialog" aria-modal="true" aria-label={t("diagram.title")} onClick={onClose}>
      <div
        ref={stage}
        className="diagram-stage"
        onClick={(e) => e.stopPropagation()}
        onWheel={onWheel}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onDoubleClick={fit}
      >
        <div className="diagram-canvas" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }} dangerouslySetInnerHTML={{ __html: sized(svg) }} />
      </div>
      <div className="diagram-tools" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="btn" aria-label={t("diagram.zoomOut")} title={t("diagram.zoomOut")} onClick={() => zoom(1 / 1.25)}>
          −
        </button>
        <span className="diagram-scale" aria-live="polite">
          {Math.round(view.scale * 100)}%
        </span>
        <button type="button" className="btn" aria-label={t("diagram.zoomIn")} title={t("diagram.zoomIn")} onClick={() => zoom(1.25)}>
          +
        </button>
        <button type="button" className="btn" onClick={fit}>
          {t("diagram.fit")}
        </button>
        <button type="button" className="btn" onClick={() => save(new Blob([sized(svg)], { type: "image/svg+xml" }), "diagram.svg")}>
          {t("diagram.saveSvg")}
        </button>
        <button type="button" className="btn" onClick={() => void png(svg, background).then((b) => save(b, "diagram.png")).catch(() => {})}>
          {t("diagram.savePng")}
        </button>
      </div>
      <button
        type="button"
        className="lightbox-close"
        aria-label={t("viewer.close")}
        title={t("viewer.close")}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <CrossIcon />
      </button>
    </div>,
    document.body,
  );
}
