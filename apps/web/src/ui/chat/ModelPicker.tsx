import type { ChatKind, MediaModel, ModelInfo } from "@artel/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../context";
import { formatPrice, formatTokens } from "../../lib/format";
import type { ModelChoice } from "../../lib/lastModel";
import { loadMediaModels } from "../../lib/media";
import { loadModels, type ModelsResult } from "../../lib/models";
import { ErrorNote } from "../ErrorNote";

const LIMIT = 200;

interface PickerProps {
  value: ModelChoice | null;
  onChange(choice: ModelChoice): void;
  /** "above" opens the list upwards, for a picker at the bottom of the screen. */
  placement?: "below" | "above";
  /** Which kinds of models to offer; more than one shows tabs. Text only by default. */
  kinds?: ChatKind[];
}

type Listed = { id: string; name: string; info: ModelInfo | null };

export function ModelPicker({ value, onChange, placement = "below", kinds = ["text"] }: PickerProps) {
  const { api, t, providers } = useApp();
  const [open, setOpen] = useState(false);
  const [providerId, setProviderId] = useState(value?.providerId ?? providers[0]?.id);
  const [kind, setKind] = useState<ChatKind>(value?.kind && kinds.includes(value.kind) ? value.kind : kinds[0]!);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<ModelsResult | null>(null);
  const [media, setMedia] = useState<MediaModel[] | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !providerId) return;
    setResult(null);
    setMedia(null);
    let live = true;
    if (kind === "text") void loadModels(api, providerId).then((r) => live && setResult(r));
    else void loadMediaModels(api, providerId, kind).then((m) => live && setMedia(m));
    return () => {
      live = false;
    };
  }, [api, open, providerId, kind]);

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

  const shown = useMemo((): Listed[] => {
    const all: Listed[] =
      kind === "text"
        ? result && "models" in result
          ? result.models.map((m) => ({ id: m.id, name: m.name, info: m }))
          : []
        : (media ?? []).map((m) => ({ id: m.id, name: m.name, info: null }));
    const q = query.trim().toLowerCase();
    const list = q ? all.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) : all;
    return list.slice(0, LIMIT);
  }, [result, media, kind, query]);
  const loading = kind === "text" ? result === null : media === null;

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
          {kinds.length > 1 && (
            <div className="picker-kinds" role="tablist">
              {kinds.map((k) => (
                <button key={k} role="tab" aria-selected={k === kind} className={k === kind ? "is-on" : undefined} onClick={() => setKind(k)}>
                  {t(`model.kind.${k}`)}
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
          {loading && <p className="muted">{t("model.loading")}</p>}
          {kind === "text" && result && "error" in result && <ErrorNote error={result.error} />}
          {!loading && shown.length === 0 && !(kind === "text" && result && "error" in result) && (
            <p className="muted">{kind !== "text" && media?.length === 0 ? t("model.noMedia") : t("model.nothing")}</p>
          )}
          <ul className="picker-list" role="listbox">
            {shown.map((m) => (
              <li key={m.id} role="option" aria-selected={value?.providerId === providerId && value?.model === m.id}>
                <button
                  onClick={() => {
                    if (!providerId) return;
                    onChange({ providerId, model: m.id, kind });
                    setOpen(false);
                  }}
                >
                  <span className="picker-name">
                    {m.name}
                    {m.name !== m.id && <small className="mono">{m.id}</small>}
                  </span>
                  {m.info && <ModelFacts model={m.info} credits={providers.find((p) => p.id === providerId)?.billing === "credits"} />}
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
