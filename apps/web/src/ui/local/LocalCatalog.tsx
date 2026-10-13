import type { HfRepo, HfVariant, LocalFit, LocalPick, LocalStatus } from "@artel/shared";
import { useEffect, useState } from "react";
import { ok } from "../../api";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";
import { useSize } from "./size";

interface Props {
  status: LocalStatus;
  onPull(model: string): void;
}

/** What to download: Artel's picks sized for this computer, and a search on Hugging Face. */
export function LocalCatalogView({ status, onPull }: Props) {
  const { api, t } = useApp();
  const [picks, setPicks] = useState<LocalPick[] | null>(null);
  const [picksFailed, setPicksFailed] = useState(false);
  const installed = status.models.map((m) => m.name).join();
  useEffect(() => {
    let live = true;
    void api.local.picks
      .$get()
      .then((r) => ok<LocalPick[]>(r))
      .then((list) => live && (setPicks(list), setPicksFailed(false)))
      .catch(() => live && setPicksFailed(true));
    return () => {
      live = false;
    };
  }, [api, installed]);
  const busy = (model: string) => status.pulls.some((p) => p.model === model && !p.done);

  return (
    <>
      <h2 className="sheet-h">{t("local.picks")}</h2>
      <p className="muted">{t("local.picksHint")}</p>
      {picksFailed && <p className="note is-pencil">{t("local.picksFailed")}</p>}
      {picks && picks.length === 0 && <p className="muted">{t("local.picksNone")}</p>}
      <ul className="local-cards">
        {picks?.map((p) => (
          <li key={p.model} className="local-card">
            <div className="local-card-head">
              <span className="mono">{p.model}</span>
              <Fit fit={p.fit} />
            </div>
            <p>{t(`local.pick.${p.family}` as MessageKey)}</p>
            <p className="local-uses">
              {p.uses.map((u) => (
                <span key={u} className="local-use">
                  {t(`local.use.${u}` as MessageKey)}
                </span>
              ))}
            </p>
            <Download model={p.model} sizeBytes={p.sizeBytes} installed={p.installed} busy={busy(p.model)} onPull={onPull} />
          </li>
        ))}
      </ul>
      <HfSearch status={status} onPull={onPull} busy={busy} />
    </>
  );
}

function Fit({ fit }: { fit: LocalFit }) {
  const { t } = useApp();
  return (
    <span className={`local-fit is-${fit}`} title={t(fit === "fast" ? "local.fastHint" : "local.slowHint")}>
      {t(fit === "fast" ? "local.fast" : "local.slow")}
    </span>
  );
}

function Download(p: { model: string; sizeBytes: number; installed: boolean; busy: boolean; onPull(model: string): void }) {
  const { t } = useApp();
  const size = useSize();
  if (p.installed) return <span className="is-ok-text">{t("local.have", { size: size(p.sizeBytes) })}</span>;
  return (
    <button type="button" className="btn" disabled={p.busy} onClick={() => p.onPull(p.model)}>
      {p.busy ? t("local.downloading") : t("local.get", { size: size(p.sizeBytes) })}
    </button>
  );
}

function HfSearch({ status, onPull, busy }: Props & { busy(model: string): boolean }) {
  const { api, t, settings } = useApp();
  const [query, setQuery] = useState("");
  const [repos, setRepos] = useState<HfRepo[] | null>(null);
  const [error, setError] = useState(false);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const compact = new Intl.NumberFormat(settings.locale === "ru" ? "ru-RU" : "en-US", { notation: "compact", maximumFractionDigits: 1 });

  async function search() {
    if (!query.trim()) return;
    setSearching(true);
    setError(false);
    setOpen(null);
    try {
      setRepos(await api.local.search.$get({ query: { q: query.trim() } }).then((r) => ok<HfRepo[]>(r)));
    } catch {
      setError(true);
      setRepos(null);
    }
    setSearching(false);
  }

  return (
    <>
      <h2 className="sheet-h">{t("local.hf")}</h2>
      <p className="muted">{t("local.hfHint")}</p>
      <form
        className="local-search"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <input className="field-input" value={query} placeholder={t("local.hfPlaceholder")} aria-label={t("local.hf")} onChange={(e) => setQuery(e.target.value)} />
        <button type="submit" className="btn" disabled={searching || !query.trim()}>
          {t("local.find")}
        </button>
      </form>
      {error && <p className="note is-pencil">{t("local.hfFailed")}</p>}
      {repos && repos.length === 0 && <p className="muted">{t("local.hfNone")}</p>}
      <ul className="local-list">
        {repos?.map((r) => (
          <li key={r.repo} className="local-repo">
            <button type="button" className="local-repo-head" aria-expanded={open === r.repo} onClick={() => setOpen(open === r.repo ? null : r.repo)}>
              <span className="mono">{r.repo}</span>
              <span className="muted">
                {r.params ? `${t("local.params", { n: compact.format(r.params) })} · ` : ""}
                {t("local.downloads", { n: compact.format(r.downloads) })}
              </span>
            </button>
            {open === r.repo && <Variants repo={r.repo} status={status} onPull={onPull} busy={busy} />}
          </li>
        ))}
      </ul>
    </>
  );
}

function Variants({ repo, status, onPull, busy }: { repo: string; status: LocalStatus; onPull(model: string): void; busy(model: string): boolean }) {
  const { api, t } = useApp();
  const [variants, setVariants] = useState<HfVariant[] | null>(null);
  const [error, setError] = useState(false);
  const installed = status.models.map((m) => m.name).join();
  useEffect(() => {
    let live = true;
    void api.local.hf
      .$get({ query: { repo } })
      .then((r) => ok<HfVariant[]>(r))
      .then((list) => live && setVariants(list))
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, [api, repo, installed]);
  if (error) return <p className="note is-pencil">{t("local.hfFailed")}</p>;
  if (!variants) return <p className="muted">{t("local.checking")}</p>;
  if (variants.length === 0) return <p className="muted">{t("local.variantsNone")}</p>;
  return (
    <ul className="local-variants">
      {variants.map((v) => (
        <li key={v.file} className="local-row">
          <span className="mono">{v.quant}</span>
          {v.recommended && <span className="option-rec">{t("local.advice")}</span>}
          <Fit fit={v.fit} />
          <Download model={v.model} sizeBytes={v.sizeBytes} installed={v.installed} busy={busy(v.model)} onPull={onPull} />
        </li>
      ))}
    </ul>
  );
}
