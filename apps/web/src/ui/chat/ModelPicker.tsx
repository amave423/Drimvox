import { estimateCost, type ChatKind, type MediaModel, type ModelInfo, type PhotoInput, type ProviderView } from "@drimvox/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../context";
import { useFlip } from "../../lib/flip";
import { formatPrice, formatTokens, formatUsd } from "../../lib/format";
import type { ModelChoice } from "../../lib/lastModel";
import { loadMediaModel, loadMediaModels } from "../../lib/media";
import { checkFree, forgetModels, freeFirst, isFree, loadModels, storedModels, type ModelsResult } from "../../lib/models";
import { ErrorNote } from "../ErrorNote";

const LIMIT = 200;
/** The panel's one height with the providers' column, whatever the provider chosen has. */
const PANEL_H = 460;
/** The tab of starred models, across providers, in the row of providers. */
const FAVORITES = "favorites";

interface PickerProps {
  value: ModelChoice | null;
  onChange(choice: ModelChoice): void;
  /** "above" opens the list upwards, for a picker at the bottom of the screen. */
  placement?: "below" | "above";
  /** Which kinds of models to offer; more than one shows tabs. Text only by default. */
  kinds?: ChatKind[];
  /** Only models that see pictures (for checking screenshots). */
  vision?: boolean;
  /** Only models that hear sound (dictation), and only the providers that have one. */
  audio?: boolean;
  /** A photo waits to be sent: picture and video models that take one come first, the others cannot be chosen. */
  photos?: boolean;
}

type Listed = { id: string; name: string; info: ModelInfo | null; photoInput?: PhotoInput | null; providerId?: string };

export function ModelPicker({ value, onChange, placement = "below", kinds: wanted = ["text"], vision = false, photos = false, audio = false }: PickerProps) {
  const { api, t, providers: all, settings, updateSettings } = useApp();
  // For dictation: only providers with a model that hears (seen: every provider and the picture tabs were offered).
  const [hearing, setHearing] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!audio) return;
    let live = true;
    const hears = (models: ModelInfo[] | null) => !!models?.some((m) => m.audio);
    setHearing(new Set(all.filter((p) => hears(storedModels(p.id))).map((p) => p.id)));
    void Promise.all(all.filter((p) => p.billing !== "subscription").map(async (p) => ({ id: p.id, r: await loadModels(api, p.id) }))).then(
      (rows) => live && setHearing(new Set(rows.filter((x) => "models" in x.r && hears(x.r.models)).map((x) => x.id))),
    );
    return () => {
      live = false;
    };
  }, [audio, all, api]);
  // The speech engine on this computer only writes dictation down: it is offered for that alone.
  const providers = audio ? all.filter((p) => hearing?.has(p.id)) : all.filter((p) => p.preset !== "whispercpp");
  const favorites = settings.favoriteModels;
  const sidebar = providers.length > 1 || (favorites.length > 0 && !audio);
  // Three groups: by key, on this computer, by subscription (asked for: local models in a section of their own).
  const local = (p: ProviderView) => p.preset === "ollama" || p.preset === "lmstudio" || p.preset === "sdcpp" || p.preset === "whispercpp";
  const byKey = providers.filter((p) => p.billing !== "subscription" && !local(p));
  const onComputer = providers.filter(local);
  const bySubscription = providers.filter((p) => p.billing === "subscription");
  const [open, setOpen] = useState(false);
  const [chosenProvider, setProviderId] = useState(value?.providerId ?? providers[0]?.id);
  // A provider that is not offered (no model that hears) gives way to the first that is.
  const providerId = providers.some((p) => p.id === chosenProvider) || chosenProvider === FAVORITES ? chosenProvider : providers[0]?.id;
  // Local models and programs on a subscription only talk: no tabs for pictures and video there (seen: empty tabs).
  const preset = providers.find((p) => p.id === providerId)?.preset;
  const talkOnly = preset === "ollama" || preset === "lmstudio" || providers.find((p) => p.id === providerId)?.billing === "subscription";
  // stable-diffusion.cpp on this computer makes pictures and clips, it does not talk (docs/specs/local-images.md).
  const kinds: ChatKind[] = preset === "sdcpp" ? wanted.filter((k) => k !== "text") : talkOnly && wanted.includes("text") ? ["text"] : wanted;
  const [chosenKind, setKind] = useState<ChatKind>(value?.kind && wanted.includes(value.kind) ? value.kind : wanted[0]!);
  // Favourites are models to talk to; pictures and clips keep their own lists.
  const onFavorites = providerId === FAVORITES;
  const kind = onFavorites ? "text" : kinds.includes(chosenKind) ? chosenKind : (kinds[0] ?? "text");
  const [favoriteList, setFavoriteList] = useState<Listed[] | null>(null);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<ModelsResult | null>(null);
  const [media, setMedia] = useState<MediaModel[] | null>(null);
  const [checking, setChecking] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  // Where the list opens: where there is room. Inside the chat's options it opens over the panel instead (the CSS).
  const nested = !!root.current?.closest(".options-panel");
  const flip = useFlip(open, root, placement === "above");

  useEffect(() => {
    if (!open || !providerId || providerId === FAVORITES) return;
    // The list kept from the last time shows at once; the fresh one replaces it when it comes.
    const kept = storedModels(providerId);
    setResult(kept ? { models: kept } : null);
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

  // The starred models with what their providers say about them, from the kept lists first.
  useEffect(() => {
    if (!open || !onFavorites) return;
    let live = true;
    const known = (list: ModelInfo[] | null, f: { providerId: string; model: string }): Listed => {
      const info = list?.find((m) => m.id === f.model) ?? null;
      return { id: f.model, name: info?.name ?? f.model, info, providerId: f.providerId };
    };
    const mine = favorites.filter((f) => providers.some((p) => p.id === f.providerId));
    setFavoriteList(mine.map((f) => known(storedModels(f.providerId), f)));
    void Promise.all(mine.map(async (f) => {
      const r = await loadModels(api, f.providerId);
      return known("models" in r ? r.models : storedModels(f.providerId), f);
    })).then((list) => live && setFavoriteList(list));
    return () => {
      live = false;
    };
  }, [api, open, onFavorites, favorites, providers]);

  const isFavorite = (pid: string | undefined, model: string) => favorites.some((f) => f.providerId === pid && f.model === model);
  const toggleFavorite = (pid: string, model: string) =>
    void updateSettings({
      favoriteModels: isFavorite(pid, model) ? favorites.filter((f) => !(f.providerId === pid && f.model === model)) : [...favorites, { providerId: pid, model }],
    });

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
    const all: Listed[] = onFavorites
      ? (favoriteList ?? [])
      : kind === "text"
        ? result && "models" in result
          ? result.models.map((m) => ({ id: m.id, name: m.name, info: m }))
          : []
        : (media ?? []).map((m) => ({ id: m.id, name: m.name, info: null, photoInput: m.photos }));
    const q = query.trim().toLowerCase();
    const found = q ? all.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) : all;
    // Models that do not answer are left out: a chat with them only fails. Checking screenshots needs eyes: those known to
    // have none are left out (a custom server often does not say; seen: all its models hidden).
    const usable = found.filter((m) => m.info?.available !== "gone" && (!vision || m.info?.vision !== false) && (!audio || m.info?.audio === true));
    // With a photo attached, the models that take one first (docs/specs/media.md).
    const list = photos && kind !== "text" ? [...usable.filter((m) => m.photoInput), ...usable.filter((m) => !m.photoInput)] : usable;
    // Free models first, under their own heading, inside the kind they belong to; the limit cuts the paid ones, so a
    // free model far down the alphabet is not lost (seen live on OpenRouter's 470 models).
    // Google's free tier counts too: a key without billing may use those models free up to a daily limit.
    const split = kind === "text" && !onFavorites ? freeFirst(list, (m) => !!m.info && (isFree(m.info) || m.info.freeTier === true)) : null;
    return {
      shown: list.slice(0, LIMIT),
      groups: split && { free: split.free, paid: split.paid.slice(0, Math.max(0, LIMIT - split.free.length)) },
      hidden: found.length - list.length,
    };
  }, [result, media, kind, query, vision, photos, onFavorites, favoriteList, audio]);
  const loading = onFavorites ? favoriteList === null : kind === "text" ? result === null : media === null;

  const providerName = providers.find((p) => p.id === value?.providerId)?.name;
  // A CLI's "default" is whatever the program itself is set to.
  const isCliDefault = (pid: string | undefined, model: string) =>
    model === "default" && providers.find((p) => p.id === pid)?.billing === "subscription";
  const modelName = useModelName(value);
  const cliDefault = !!value && isCliDefault(value.providerId, value.model);
  const chosen = value && providerName ? { name: cliDefault ? t("model.cliDefault") : (modelName ?? value.model), id: cliDefault ? t("model.cliDefault") : value.model } : null;

  // A model that takes no photo cannot be chosen while one waits: it would be refused anyway.
  const refused = (m: Listed) => photos && kind !== "text" && !m.photoInput;
  const item = (m: Listed) => {
    const pid = m.providerId ?? providerId;
    return (
    <li key={`${pid}/${m.id}`} role="option" className="picker-item" aria-selected={value?.providerId === pid && value?.model === m.id} aria-disabled={refused(m) || undefined}>
      <button
        type="button"
        disabled={refused(m)}
        className={refused(m) ? "is-unsupported" : undefined}
        onClick={() => {
          if (!pid) return;
          onChange({ providerId: pid, model: m.id, kind });
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
            {/* What it does with a photo, before its name (asked for). */}
            <span className="picker-title">
              {kind !== "text" && m.photoInput && <PhotoMark photos={m.photoInput} />}
              {m.name}
            </span>
            {onFavorites && <small>{providers.find((p) => p.id === pid)?.name}</small>}
            {m.name !== m.id && <small className="mono">{m.id}</small>}
            {refused(m) && <small className="picker-why">{t("photos.cannot")}</small>}
          </span>
        )}
        {m.info && <ModelFacts model={m.info} billing={providers.find((p) => p.id === pid)?.billing} />}
        {!m.info && kind !== "text" && pid && <MediaPrice providerId={pid} kind={kind} model={m.id} />}
      </button>
      {kind === "text" && pid && (
        <button
          type="button"
          className={`picker-star${isFavorite(pid, m.id) ? " is-on" : ""}`}
          aria-pressed={isFavorite(pid, m.id)}
          aria-label={t(isFavorite(pid, m.id) ? "model.unfavorite" : "model.favorite", { model: m.name })}
          title={t(isFavorite(pid, m.id) ? "model.unfavorite" : "model.favorite", { model: m.name })}
          onClick={() => toggleFavorite(pid, m.id)}
        >
          {isFavorite(pid, m.id) ? "★" : "☆"}
        </button>
      )}
    </li>
    );
  };

  return (
    <div className="picker" ref={root}>
      {/* Not a submit button: the picker sits in the message form (seen: with a file attached, opening it sent the message). */}
      {/* The model's own name and its provider, the id only in the hint (seen: "OpenRouter / anthropic/c…" cut where it mattered). */}
      <button
        type="button"
        className="picker-button"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={chosen ? `${providerName} / ${chosen.id}${chosen.name !== chosen.id ? ` — ${chosen.name}` : ""}` : undefined}
        title={chosen ? `${providerName} / ${chosen.id}` : undefined}
        onClick={() => setOpen(!open)}
      >
        {chosen ? (
          <span className="picker-label">
            {chosen.name}
            <span className="picker-label-provider">{providerName}</span>
          </span>
        ) : (
          <span className="picker-label">{t("model.pick")}</span>
        )}
        <span aria-hidden>▾</span>
      </button>
      {open && (
        <div
          className={`picker-panel model-panel${(nested ? true : flip.above) ? " is-above" : ""}${sidebar ? " has-providers" : ""}`}
          style={nested ? undefined : { height: sidebar ? Math.min(PANEL_H, flip.maxHeight ?? PANEL_H) : undefined, maxHeight: flip.maxHeight ? Math.min(560, flip.maxHeight) : undefined }}
        >
          {audio && hearing !== null && providers.length === 0 && <p className="muted">{t("voice.noModels")}</p>}
          {/* Every provider stays in the row whichever is chosen (seen: choosing the picture engine hid the others). */}
          {/* Providers in a column of their own that scrolls, so fifty of them fit and the list beside keeps its place;
              the panel keeps one height whatever the provider has (seen: it jumped with each provider's count).
              Programs on a subscription are a group of their own. */}
          {sidebar && (
            <nav className="picker-providers" aria-label={t("model.providers")}>
              {wanted.includes("text") && !audio && (
                <button type="button" className={onFavorites ? "is-on" : undefined} onClick={() => setProviderId(FAVORITES)}>
                  {t("model.favorites")}
                </button>
              )}
              {byKey.map((p) => (
                <button type="button" key={p.id} className={p.id === providerId ? "is-on" : undefined} onClick={() => setProviderId(p.id)}>
                  {p.name}
                </button>
              ))}
              {onComputer.length > 0 && <span className="picker-providers-h">{t("model.onComputer")}</span>}
              {onComputer.map((p) => (
                <button type="button" key={p.id} className={p.id === providerId ? "is-on" : undefined} onClick={() => setProviderId(p.id)}>
                  {p.name}
                </button>
              ))}
              {bySubscription.length > 0 && <span className="picker-providers-h">{t("model.bySubscription")}</span>}
              {bySubscription.map((p) => (
                <button type="button" key={p.id} className={`is-subscription${p.id === providerId ? " is-on" : ""}`} onClick={() => setProviderId(p.id)}>
                  {p.name}
                </button>
              ))}
            </nav>
          )}
          <div className="picker-main">
          {kinds.length > 1 && !onFavorites && (
            <div className="picker-kinds" role="tablist">
              {kinds.map((k) => (
                <button type="button" key={k} role="tab" aria-selected={k === kind} className={k === kind ? "is-on" : undefined} onClick={() => setKind(k)}>
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
          {kind === "text" && !onFavorites && result && "error" in result && <ErrorNote error={result.error} />}
          {!loading && shown.length === 0 && !(kind === "text" && !onFavorites && result && "error" in result) && (
            <p className="muted">{onFavorites && !query.trim() ? t("model.noFavorites") : kind !== "text" && media?.length === 0 ? t("model.noMedia") : t("model.nothing")}</p>
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
        </div>
      )}
    </div>
  );
}

/** The chosen model's name as its provider lists it: from the kept list at once, then the fresh one. */
function useModelName(value: ModelChoice | null): string | null {
  const { api } = useApp();
  const [name, setName] = useState<string | null>(null);
  const providerId = value?.providerId;
  const model = value?.model;
  const kind = value?.kind ?? "text";
  useEffect(() => {
    if (!providerId || !model) return setName(null);
    let live = true;
    if (kind !== "text") {
      setName(null);
      void loadMediaModel(api, providerId, kind, model).then((m) => live && setName(m?.name ?? null));
    } else {
      setName(storedModels(providerId)?.find((m) => m.id === model)?.name ?? null);
      void loadModels(api, providerId).then((r) => live && "models" in r && setName(r.models.find((m) => m.id === model)?.name ?? null));
    }
    return () => {
      live = false;
    };
  }, [api, providerId, model, kind]);
  return name;
}

function ModelFacts({ model, billing }: { model: ModelInfo; billing: ProviderView["billing"] | undefined }) {
  const { t, settings } = useApp();
  const price =
    model.priceIn === null || model.priceOut === null
      ? t("model.priceNone")
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
  return <span className="picker-facts mono">{cost === null ? t("model.priceNone") : t(kind === "image" ? "model.perImage" : "model.perClip", { cost: formatUsd(cost) })}</span>;
}

/** What a model does with a photo, on its line in the list: a reference, a first frame; "needs a photo" where it must. */
function PhotoMark({ photos }: { photos: PhotoInput }) {
  const { t } = useApp();
  // A camera instead of words (seen: "из фото" made the lines long); what it means is in the hint and for screen readers.
  const name = t(photos.min > 0 ? "photos.required" : photos.use === "reference" ? "photos.reference" : "photos.firstFrame");
  const hint = t(photos.use === "reference" ? "photos.referenceHint" : "photos.firstFrameHint");
  return (
    <span className={`picker-photo${photos.min > 0 ? " is-required" : ""}`} title={`${name}: ${hint}`} role="img" aria-label={name}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
        <circle cx="12" cy="13" r="3.2" />
      </svg>
    </span>
  );
}
