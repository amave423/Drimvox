import { thinkingLevels, type ThinkingLevel } from "@artel/shared";
import { useEffect, useRef, useState } from "react";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";

const KEY = "artel.thinking";

/** The thinking level of the last message on this device; the provider's own by default. */
export function readThinking(): ThinkingLevel {
  try {
    const saved = localStorage.getItem(KEY) as ThinkingLevel | null;
    return saved && thinkingLevels.includes(saved) ? saved : "auto";
  } catch {
    return "auto";
  }
}

function remember(level: ThinkingLevel) {
  try {
    localStorage.setItem(KEY, level);
  } catch {
    // Without storage the next chat starts with the provider's own level.
  }
}

/**
 * How much the model thinks before it answers (seen live: left to itself, a model thought for minutes and wrote no
 * answer). A pill like the internet switch, opening upwards.
 */
export function ThinkingSwitch({ value, onChange }: { value: ThinkingLevel; onChange(level: ThinkingLevel): void }) {
  const { t } = useApp();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const name = (level: ThinkingLevel) => t(`thinking.${level}` as MessageKey);

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
    <div className="picker web-switch thinking-switch" ref={root}>
      <button
        type="button"
        className={`picker-button${value === "auto" ? "" : " is-on"}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${t("thinking.label")}: ${name(value)}`}
        title={t("thinking.hint")}
        onClick={() => setOpen(!open)}
      >
        <span>{t("thinking.short", { level: name(value) })}</span>
        <span aria-hidden>▾</span>
      </button>
      {open && (
        <ul className="picker-panel is-above web-panel" role="listbox" aria-label={t("thinking.label")}>
          {thinkingLevels.map((level) => (
            <li key={level} role="option" aria-selected={level === value}>
              <button
                type="button"
                className={level === value ? "is-on" : undefined}
                onClick={() => {
                  remember(level);
                  onChange(level);
                  setOpen(false);
                }}
              >
                <span className="web-option-name">{name(level)}</span>
                <small className="muted">{t(`thinking.about.${level}` as MessageKey)}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
