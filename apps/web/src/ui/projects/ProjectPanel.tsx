import type { ProjectView, ProjectWorkView } from "@drimvox/shared";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useApp } from "../../context";
import { formatTokens } from "../../lib/format";
import { ProjectParams } from "./ProjectParams";
import { WorkTokens } from "./WorkTokens";

const HEIGHT_KEY = "drimvox.contextHeight";
/** Dragged below this, the context folds away to a small button. */
const FOLD_BELOW = 48;

function keptHeight(): number | null {
  try {
    const n = Number(localStorage.getItem(HEIGHT_KEY));
    return Number.isFinite(n) && n >= 0 && localStorage.getItem(HEIGHT_KEY) !== null ? n : null;
  } catch {
    return null;
  }
}

/**
 * The workshop's right side (asked for: no tabs; the result goes into the conversation): the context on top, the
 * project's parameters below, the edge between them dragged to share the height. The context is never taller than what
 * it holds; dragged to the top it folds away and a small button brings it back.
 */
export function ProjectPanel(p: { project: ProjectView; work: ProjectWorkView | null; open: boolean; onChanged(): void }) {
  const { api, t, settings, reloadWorks } = useApp();
  const content = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(0);
  const [height, setHeight] = useState<number | null>(keptHeight);
  const drag = useRef<{ y: number; from: number } | null>(null);
  const { work } = p;

  // How tall the context's own content is: the most it may take.
  useLayoutEffect(() => {
    const el = content.current;
    if (!el) return;
    const measure = () => setFull(el.scrollHeight);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [work?.projectId, height === 0]);
  useEffect(() => {
    try {
      if (height !== null) localStorage.setItem(HEIGHT_KEY, String(height));
    } catch {
      // Kept for this visit only.
    }
  }, [height]);

  async function fresh() {
    await api.projects[":id"].work.fresh.$post({ param: { id: p.project.id } }).catch(() => null);
    p.onChanged();
    reloadWorks();
  }

  const folded = height === 0;
  const shown = height === null ? full : Math.min(height, full);
  const set = (h: number) => setHeight(h < FOLD_BELOW ? 0 : Math.min(h, full));
  const context = work ? <WorkTokens work={work} onFresh={() => void fresh()} /> : null;

  return (
    <aside id="workshop-result" className="project-panel" aria-label={t("projectParams.panel")} aria-hidden={!p.open} inert={!p.open}>
      {!folded && (
        <section className="panel-context" aria-label={t("projectParams.context")} style={{ height: shown || undefined }}>
          <div ref={content} className="panel-context-body">
            {context ?? <p className="muted">{t("workshop.noResult")}</p>}
            <p className="mono muted panel-path">{p.project.path}</p>
          </div>
        </section>
      )}
      {!folded && (
        <div
          className="panel-split"
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("projectParams.resize")}
          tabIndex={0}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { y: e.clientY, from: shown };
          }}
          onPointerMove={(e) => drag.current && set(drag.current.from + e.clientY - drag.current.y)}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") set(shown - 40);
            else if (e.key === "ArrowDown") set(shown + 40);
            else return;
            e.preventDefault();
          }}
        />
      )}
      <section className="panel-params" aria-label={t("projectParams.title")}>
        <header className="panel-params-head">
          <h2 className="sheet-h">{t("projectParams.title")}</h2>
          {/* The folded context as a small button: how full it is, a click brings it back. */}
          {folded && (
            <button type="button" className="panel-context-chip" title={t("projectParams.showContext")} onClick={() => setHeight(null)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                <circle cx="12" cy="12" r="9" />
                <path d="M12 3a9 9 0 0 1 9 9h-9z" fill="currentColor" stroke="none" />
              </svg>
              {work?.tokens.context ? formatTokens(work.tokens.context, settings.locale) : t("projectParams.context")}
            </button>
          )}
        </header>
        <ProjectParams project={p.project} work={work} />
      </section>
    </aside>
  );
}
