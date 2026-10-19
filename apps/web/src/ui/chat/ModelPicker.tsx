import { estimateCost, type ChatKind, type MediaModel, type ModelInfo, type ProviderView } from "@artel/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../context";
import { formatPrice, formatTokens, formatUsd } from "../../lib/format";
import type { ModelChoice } from "../../lib/lastModel";
import { loadMediaModel, loadMediaModels } from "../../lib/media";
import { checkFree, forgetModels, freeFirst, isFree, loadModels, type ModelsResult } from "../../lib/models";
import { ErrorNote } from "../ErrorNote";

const LIMIT = 200;

interface PickerProps {
  value: ModelChoice | null;
  onChange(choice: ModelChoice): void;
  /** "above" opens the list upwards, for a picker at the bottom of the screen. */
  placement?: "below" | "above";
  /** Which kinds of models to offer; more than one shows tabs. Text only by default. */
  kinds?: ChatKind[];
  /** Only models that see pictures (for checking screenshots). */
  vision?: boolean;
}

type Listed = { id: string; name: string; info: ModelInfo | null };

export function ModelPicker({ value, onChange, placement = "below", kinds: wanted = ["text"], vision = false }: PickerProps) {
  const { api, t, providers } = useApp();
  const [open, setOpen] = useState(false);
  const [providerId, setProviderId] = useState(value?.providerId ?? providers[0]?.id);
  // Local models and programs on a subscription only talk: no tabs for pictures and video there (seen: empty tabs).
  const preset = providers.find((p) => p.id === providerId)?.preset;
  const talkOnly = preset === "ollama" || preset === "lmstudio" || providers.find((p) => p.id === providerId)?.billing === "subscription";
  // stable-diffusion.cpp on this computer only draws pictures (docs/specs/local-images.md).
  const kinds: ChatKind[] = preset === "sdcpp" ? wanted.filter((k) => k === "image") : talkOnly && wanted.includes("text") ? ["text"] : wanted;
  const [chosenKind, setKind] = useState<ChatKind>(value?.kind && wanted.includes(value.kind) ? value.kind : wanted[0]!);
  const kind = kinds.includes(chosenKind) ? chosenKind : (kinds[0] ?? "text");
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<ModelsResult | null>(null);
  const [media, setMedia] = useState<MediaModel[] | null>(null);
  const [checking, setChecking] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !providerId) return;
    setResult(null);
    setMedia(null);
    setChecking(false);
    let live = true;
    // A CLI's list shows what its default turned out to be on the last run: always the current one.
    if (providers.find((p) => p.id === providerId)?.billing === "subscription") forgetModels(providerId);
    if (kind === "text") {
      void loadModels(api, providerId).then(async (r) => {
        if (!live) return;
        setResult(r);
        const unknown = "models" in r && r.models.some((m) => (isFree(m) || m.freeTier === true) && !m.available);
        if (!unknown) return;
        setChecking(true);
        const checked = await checkFree(api, providerId, r);
        if (!live) return;
        setResult(checked);
        setChecking(false);
      });
    } else void loadMediaModels(api, providerId, kind).then((m) => live && setMedia(m));
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

  const { shown, groups, hidden } = useMemo(() => {
    const all: Listed[] =
      kind === "text"
        ? result && "models" in result
          ? result.models.map((m) => ({ id: m.id, name: m.name, info: m }))
          : []
        : (media ?? []).map((m) => ({ id: m.id, name: m.name, info: null }));
    const q = query.trim().toLowerCase();
    const found = q ? all.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) : all;
    // Models that do not answer are left out: a chat with them only fails. Checking screenshots needs eyes.
    const list = found.filter((m) => m.info?.available !== "gone" && (!vision || m.info?.vision === true));
    // Free models first, under their own heading, inside the kind they belong to; the limit cuts the paid ones, so a
    // free model far down the alphabet is not lost (seen live on OpenRouter's 470 models).
    // Google's free tier counts too: a key without billing may use those models free up to a daily limit.
    const split = kind === "text" ? freeFirst(list, (m) => !!m.info && (isFree(m.info) || m.info.freeTier === true)) : null;
    return {
      shown: list.slice(0, LIMIT),
      groups: split && { free: split.free, paid: split.paid.slice(0, Math.max(0, LIMIT - split.free.length)) },
      hidden: found.length - list.length,
    };
  }, [result, media, kind, query, vision]);
  const loading = kind === "text" ? result === null : media === null;

  const providerName = providers.find((p) => p.id === value?.providerId)?.name;
  // A CLI's "default" is whatever the program itself is set to.
  const isCliDefault = (pid: string | undefined, model: string) =>
    model === "default" && providers.find((p) => p.id === pid)?.billing === "subscription";
  const label =
    value && providerName ? `${providerName} / ${isCliDefault(value.providerId, value.model) ? t("model.cliDefault") : value.model}` : t("model.pick");

  const item = (m: Listed) => (
    <li key={m.id} role="option" aria-selected={value?.providerId === providerId && value?.model === m.id}>
      <button
        onClick={() => {
          if (!providerId) return;
          onChange({ providerId, model: m.id, kind });
          setOpen(false);
        }}
      >
        {isCliDefault(providerId, m.id) ? (
          <span className="picker-name">
            {t("model.cliDefault")}
            <small>{m.info?.resolved ? t("model.cliDefaultNow", { model: m.info.resolved }) : t("model.cliDefaultHint")}</small>
          </span>
        ) : (
          <span className="picker-name">
            {m.name}
            {m.name !== m.id && <small className="mono">{m.id}</small>}
          </span>
        )}
        {m.info && <ModelFacts model={m.info} billing={providers.find((p) => p.id === providerId)?.billing} />}
        {!m.info && kind !== "text" && providerId && <MediaPrice providerId={providerId} kind={kind} model={m.id} />}
      </button>
    </li>
  );

  return (
    <div className="picker" ref={root}>
      <button className="picker-button" aria-expanded={open} aria-haspopup="listbox" onClick={() => setOpen(!open)}>
        <span className={`picker-label${value && providerName ? " mono" : ""}`}>{label}</span>
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
          {checking && <p className="muted">{t("model.checking")}</p>}
          {hidden > 0 && <p className="muted">{t("model.hidden", { count: hidden })}</p>}
          {kind === "text" && result && "error" in result && <ErrorNote error={result.error} />}
          {!loading && shown.length === 0 && !(kind === "text" && result && "error" in result) && (
            <p className="muted">{kind !== "text" && media?.length === 0 ? t("model.noMedia") : t("model.nothing")}</p>
          )}
          <ul className="picker-list" role="listbox">
            {groups ? (
              <>
                <li role="presentation" className="picker-group">
                  {t(preset === "google" ? "model.groupFreeTier" : "model.groupFree", { count: groups.free.length })}
                </li>
                {groups.free.map(item)}
                <li role="presentation" className="picker-group">
                  {t("model.groupPaid")}
                </li>
                {groups.paid.map(item)}
              </>
            ) : (
              shown.map(item)
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

function ModelFacts({ model, billing }: { model: ModelInfo; billing: ProviderView["billing"] | undefined }) {
  const { t, settings } = useApp();
  const price =
    model.priceIn === null || model.priceOut === null
      ? "—"
      : model.priceIn === 0 && model.priceOut === 0
        ? t(billing === "subscription" ? "model.subscription" : billing === "credits" ? "model.freeCredits" : "model.free")
        : `${model.priceEstimated ? "≈" : ""}${formatPrice(model.priceIn)} / ${formatPrice(model.priceOut)}`;
  return (
    <span className="picker-facts mono">
      {model.available === "busy" && <span className="picker-busy">{t("model.busy")}</span>}
      {model.freeTier && <span className="is-ok-text">{t("model.freeTier")}</span>}
      <span>{price}</span>
      {model.contextLength && <span>{formatTokens(model.contextLength, settings.locale)}</span>}
    </span>
  );
}

/** What one picture or clip of a model costs at its usual settings (seen: the list showed no prices at all). */
function MediaPrice({ providerId, kind, model }: { providerId: string; kind: Exclude<ChatKind, "text">; model: string }) {
  const { api, t } = useApp();
  const [cost, setCost] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void loadMediaModel(api, providerId, kind, model).then((m) => live && setCost(m ? estimateCost(m, {}) : null));
    return () => {
      live = false;
    };
  }, [api, providerId, kind, model]);
  if (cost === undefined) return <span className="picker-facts mono muted">…</span>;
  return <span className="picker-facts mono">{cost === null ? "—" : t(kind === "image" ? "model.perImage" : "model.perClip", { cost: formatUsd(cost) })}</span>;
}
