import type { WebMode } from "@artel/shared";
import { useEffect, useRef, useState } from "react";
import { useApp } from "../../context";

const KEY = "artel.web";

/** The internet setting of the last chat message on this device; free search by default. */
export function readWebMode(): WebMode {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === "off" || saved === "provider" ? saved : "free";
  } catch {
    return "free";
  }
}

function remember(mode: WebMode) {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // Without storage the next chat starts with free search.
  }
}

interface Props {
  value: WebMode;
  onChange(mode: WebMode): void;
  /** The provider's own paid search, where the provider has one; its name for the label. */
  providerName: string | null;
}

/** Off, Artel's free search, or the provider's paid search: a pill like the model picker, opening upwards. */
export function WebSwitch({ value, onChange, providerName }: Props) {
  const { t } = useApp();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const modes: WebMode[] = providerName ? ["off", "free", "provider"] : ["off", "free"];
  const current = modes.includes(value) ? value : "free";

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

  const name = (m: WebMode) => (m === "provider" ? t("web.provider", { name: providerName ?? "" }) : t(`web.${m}`));

  return (
    <div className="picker web-switch" ref={root}>
      <button
        type="button"
        className={`picker-button${current === "off" ? "" : " is-on"}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${t("web.label")}: ${name(current)}`}
        onClick={() => setOpen(!open)}
      >
        <span className={`web-dot is-${current}`} aria-hidden />
        <span>{name(current)}</span>
        <span aria-hidden>▾</span>
      </button>
      {open && (
        <ul className="picker-panel is-above web-panel" role="listbox" aria-label={t("web.label")}>
          {modes.map((m) => (
            <li key={m} role="option" aria-selected={m === current}>
              <button
                type="button"
                className={m === current ? "is-on" : undefined}
                onClick={() => {
                  remember(m);
                  onChange(m);
                  setOpen(false);
                }}
              >
                <span className="web-option-name">
                  <span className={`web-dot is-${m}`} aria-hidden />
                  {name(m)}
                </span>
                <small className="muted">{t(`web.hint.${m}`)}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
