import type { ModelInfo } from "@artel/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../context";
import { formatPrice, formatTokens } from "../../lib/format";
import type { ModelChoice } from "../../lib/lastModel";
import { loadModels, type ModelsResult } from "../../lib/models";
import { ErrorNote } from "../ErrorNote";

const LIMIT = 200;

interface PickerProps {
  value: ModelChoice | null;
  onChange(choice: ModelChoice): void;
  /** "above" opens the list upwards, for a picker at the bottom of the screen. */
  placement?: "below" | "above";
}

export function ModelPicker({ value, onChange, placement = "below" }: PickerProps) {
  const { api, t, providers } = useApp();
  const [open, setOpen] = useState(false);
  const [providerId, setProviderId] = useState(value?.providerId ?? providers[0]?.id);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<ModelsResult | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !providerId) return;
    setResult(null);
    let live = true;
    void loadModels(api, providerId).then((r) => live && setResult(r));
    return () => {
      live = false;
    };
  }, [api, open, providerId]);

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

  const shown = useMemo(() => {
    if (!result || !("models" in result)) return [];
    const q = query.trim().toLowerCase();
    const list = q ? result.models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) : result.models;
    return list.slice(0, LIMIT);
  }, [result, query]);

  const providerName = providers.find((p) => p.id === value?.providerId)?.name;
  const label = value && providerName ? `${providerName} / ${value.model}` : t("model.pick");

  return (
    <div className="picker" ref={root}>
      <button className="picker-button" aria-expanded={open} aria-haspopup="listbox" onClick={() => setOpen(!open)}>
        <span className="mono">{label}</span>
        <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className={`picker-panel${placement === "above" ? " is-above" : ""}`}>
          {providers.length > 1 && (
            <div className="picker-providers">
              {providers.map((p) => (
                <button key={p.id} className={p.id === providerId ? "is-on" : undefined} onClick={() => setProviderId(p.id)}>
                  {p.name}
                </button>
              ))}
            </div>
          )}
          <input
            className="field-input"
            placeholder={t("model.search")}
            aria-label={t("model.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          {result === null && <p className="muted">{t("model.loading")}</p>}
          {result && "error" in result && <ErrorNote error={result.error} />}
          {result && "models" in result && shown.length === 0 && <p className="muted">{t("model.nothing")}</p>}
          <ul className="picker-list" role="listbox">
            {shown.map((m) => (
              <li key={m.id} role="option" aria-selected={value?.providerId === providerId && value?.model === m.id}>
                <button
                  onClick={() => {
                    if (!providerId) return;
                    onChange({ providerId, model: m.id });
                    setOpen(false);
                  }}
                >
                  <span className="picker-name">
                    {m.name}
                    {m.name !== m.id && <small className="mono">{m.id}</small>}
                  </span>
                  <ModelFacts model={m} credits={providers.find((p) => p.id === providerId)?.billing === "credits"} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ModelFacts({ model, credits }: { model: ModelInfo; credits: boolean }) {
  const { t, settings } = useApp();
  const price =
    model.priceIn === null || model.priceOut === null
      ? "—"
      : model.priceIn === 0 && model.priceOut === 0
        ? t(credits ? "model.freeCredits" : "model.free")
        : `${model.priceEstimated ? "≈" : ""}${formatPrice(model.priceIn)} / ${formatPrice(model.priceOut)}`;
  return (
    <span className="picker-facts mono">
      <span>{price}</span>
      {model.contextLength && <span>{formatTokens(model.contextLength, settings.locale)}</span>}
    </span>
  );
}
