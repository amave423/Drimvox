import { useEffect, useRef, useState } from "react";
import { useApp } from "../../context";

interface Props {
  value: string | null;
  onChange(folder: string | null): void;
  /** The model cannot call tools: it cannot work in a folder. */
  noTools?: boolean;
}

function FolderIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  );
}

const nameOf = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/**
 * The chat's folder (docs/specs/chat-folder.md): none by default; connected, the model reads, writes and runs commands
 * in it. On the desktop the folder comes from the system dialog; on the server it is typed as a path.
 */
export function FolderSwitch({ value, onChange, noTools = false }: Props) {
  const { t } = useApp();
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
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

  async function pick() {
    if (window.drimvox?.pickFolder) {
      const folder = await window.drimvox.pickFolder();
      if (folder) onChange(folder);
      setOpen(false);
    } else setOpen(true);
  }

  return (
    <div className="picker folder-switch" ref={root}>
      <button
        type="button"
        className={`picker-button${value ? " is-on" : ""}`}
        disabled={noTools && !value}
        title={noTools ? t("folder.noTools") : value ?? t("folder.hint")}
        aria-label={value ? t("folder.connected", { name: nameOf(value) }) : t("folder.label")}
        onClick={() => (value ? setOpen(!open) : void pick())}
      >
        <FolderIcon />
        <span className="folder-name">{value ? nameOf(value) : t("folder.label")}</span>
        <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className="picker-panel is-above folder-panel">
          {value && <p className="mono muted folder-path">{value}</p>}
          {!window.drimvox?.pickFolder && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (path.trim()) onChange(path.trim());
                setOpen(false);
              }}
            >
              <input className="field-input" placeholder={t("folder.pathPlaceholder")} aria-label={t("folder.pathPlaceholder")} value={path} onChange={(e) => setPath(e.target.value)} autoFocus />
            </form>
          )}
          <div className="actions">
            {window.drimvox?.pickFolder && (
              <button type="button" className="btn" onClick={() => void pick()}>
                {t("folder.change")}
              </button>
            )}
            {value && (
              <button
                type="button"
                className="btn is-pencil"
                onClick={() => {
                  onChange(null);
                  setOpen(false);
                }}
              >
                {t("folder.disconnect")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
