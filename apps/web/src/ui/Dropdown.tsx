import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
  /** A second, muted line under the label. */
  hint?: ReactNode;
}

interface Props<T extends string> {
  value: T | null;
  options: DropdownOption<T>[];
  onChange(value: T): void;
  /** What the field is, for screen readers and as the visible label when `label` is shown. */
  label: string;
  placeholder?: string;
  /** A search field over the list, for long lists. */
  search?: string;
  disabled?: boolean;
}

/**
 * A choice from a list in Drimvox's own look (asked for: the browser's square lists did not fit the app): a button with the
 * chosen value, a rounded panel of options like the model picker's, the keyboard and Escape as in any list.
 */
export function Dropdown<T extends string>({ value, options, onChange, label, placeholder, search, disabled }: Props<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const chosen = options.find((o) => o.value === value);
  const shown = query.trim() ? options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase())) : options;

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, shown.findIndex((o) => o.value === value)));
    const away = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const pick = (o: DropdownOption<T> | undefined) => {
    if (!o) return;
    onChange(o.value);
    setOpen(false);
    setQuery("");
  };
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return setOpen(false);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return setOpen(true);
      setActive((a) => (a + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % Math.max(shown.length, 1));
    }
    if (e.key === "Enter" && open) {
      e.preventDefault();
      pick(shown[active]);
    }
  };

  return (
    <div className="dropdown" ref={root} onKeyDown={keys}>
      <button
        type="button"
        className="dropdown-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <span className={chosen ? undefined : "muted"}>{chosen?.label ?? placeholder ?? ""}</span>
        <span aria-hidden className="dropdown-arrow">
          ▾
        </span>
      </button>
      {open && (
        <div className="dropdown-panel">
          {search !== undefined && (
            <input className="field-input" placeholder={search} aria-label={search} value={query} autoFocus onChange={(e) => (setQuery(e.target.value), setActive(0))} />
          )}
          <ul className="dropdown-list" role="listbox" id={id} aria-label={label}>
            {shown.map((o, i) => (
              <li key={o.value} role="option" aria-selected={o.value === value} className={i === active ? "is-active" : undefined}>
                <button type="button" onClick={() => pick(o)} onMouseEnter={() => setActive(i)}>
                  <span>{o.label}</span>
                  {o.hint && <small>{o.hint}</small>}
                </button>
              </li>
            ))}
          </ul>
          {shown.length === 0 && <p className="muted dropdown-empty">{placeholder}</p>}
        </div>
      )}
    </div>
  );
}
