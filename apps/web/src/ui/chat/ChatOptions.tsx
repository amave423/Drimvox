import { useEffect, useRef, useState, type ReactNode } from "react";
import { useApp } from "../../context";

export interface OptionRow {
  label: string;
  control: ReactNode;
}

function SlidersIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </svg>
  );
}

/**
 * The chat's options in one place: the internet, thinking, the folder (seen: four pills under the message box looked
 * crowded). The button names what differs from the usual, so a connected folder is never hidden.
 */
export function ChatOptions({ rows, changed, narrow = false }: { rows: OptionRow[]; changed: string[]; narrow?: boolean }) {
  const { t } = useApp();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="picker chat-options" ref={root}>
      <button
        type="button"
        className={`picker-button${changed.length ? " is-on" : ""}`}
        aria-expanded={open}
        aria-label={changed.length ? `${t("options.label")}: ${changed.join(", ")}` : t("options.label")}
        title={t("options.hint")}
        onClick={() => setOpen(!open)}
      >
        <SlidersIcon />
        <span className="options-text">{changed.length ? changed.join(" · ") : t("options.label")}</span>
        <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className={`picker-panel is-above options-panel${narrow ? " is-narrow" : ""}`} role="dialog" aria-label={t("options.label")}>
          {rows.map((r) => (
            <div key={r.label} className="options-row">
              <span className="muted">{r.label}</span>
              {r.control}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
