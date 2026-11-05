import type { MessageKey } from "../i18n";
import type { ProcessView } from "@drimvox/shared";
import { useEffect, useRef, useState } from "react";
import { ok } from "../api";
import { useApp } from "../context";

/** How often the list is asked for. */
const POLL_MS = 4000;

/**
 * What runs in the background, at the top right beside the browser (asked for: to see what runs and stop what is not
 * needed; seen live: two servers on one port). Shown only while something runs.
 */
export function ProcessesButton() {
  const { api, t, settings } = useApp();
  const [list, setList] = useState<ProcessView[]>([]);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  async function load() {
    const next = await api.processes.$get().then((r) => ok<ProcessView[]>(r)).catch(() => null);
    if (next) setList(next);
  }
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [api]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  // The list as the core sees it after the stop, not as hoped: a process that outlived it stays in sight.
  async function stop(p: ProcessView) {
    await api.processes.stop.$post({ json: { key: p.key, id: p.id } }).catch(() => null);
    await new Promise((r) => setTimeout(r, 1000));
    await load();
  }

  if (!list.length && !open) return null;
  const minutes = (since: number) => Math.max(0, Math.round((Date.now() - since) / 60_000));
  return (
    <div className="processes" ref={root}>
      <button type="button" className={`topbar-browser${open ? " is-on" : ""}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        {t("processes.button", { n: list.length })}
      </button>
      {open && (
        <div className="processes-panel" role="dialog" aria-label={t("processes.title")}>
          <h3 className="margin-h">{t("processes.title")}</h3>
          {list.length === 0 && <p className="muted">{t("processes.none")}</p>}
          <ul className="processes-list">
            {list.map((p) => (
              <li key={`${p.key}/${p.id}`} className="processes-item">
                <div className="processes-text">
                  <span className="processes-owner">
                    {p.owner.name || t("chat.untitled")} <span className="muted">· {t(`processes.kind.${p.owner.kind}` as MessageKey)}</span>
                  </span>
                  <code className="mono processes-command" title={p.command}>
                    {p.command}
                  </code>
                  <span className="muted processes-time">{t("processes.since", { m: minutes(p.startedAt).toLocaleString(settings.locale) })}</span>
                </div>
                <button type="button" className="btn is-pencil is-small" onClick={() => void stop(p)}>
                  {t("processes.stop")}
                </button>
              </li>
            ))}
          </ul>
          <p className="muted processes-note">{t("processes.note")}</p>
        </div>
      )}
    </div>
  );
}
