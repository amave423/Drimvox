import type { HfRepo, HfVariant, LocalFit, LocalPick, LocalPull, LocalStatus } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { ok } from "../../api";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";
import { PullControl, type PullActions } from "./PullControl";

interface Props {
  status: LocalStatus;
  actions: PullActions;
}

/** What to download: Drimvox's picks sized for this computer, and a search on Hugging Face. */
export function LocalCatalogView({ status, actions }: Props) {
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
  const pullOf = (model: string) => status.pulls.find((p) => p.model === model);

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
            <PullControl model={p.model} sizeBytes={p.sizeBytes} installed={p.installed} pull={pullOf(p.model)} actions={actions} />
          </li>
        ))}
      </ul>
      <HfSearch status={status} actions={actions} pullOf={pullOf} />
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

function HfSearch({ status, actions, pullOf }: Props & { pullOf(model: string): LocalPull | undefined }) {
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
          <li key={r.repo} className={`local-repo${r.unsupported ? " is-unsupported" : ""}`}>
            <button
              type="button"
              className="local-repo-head"
              disabled={!!r.unsupported}
              aria-expanded={r.unsupported ? undefined : open === r.repo}
              onClick={() => setOpen(open === r.repo ? null : r.repo)}
            >
              <span className="mono">{r.repo}</span>
              {r.unfiltered && (
                <span className="local-unfiltered" title={t("local.unfilteredHint")}>
                  {t("local.unfiltered")}
                </span>
              )}
              <span className="muted">
                {r.params ? `${t("local.params", { n: compact.format(r.params) })} · ` : ""}
                {t("local.downloads", { n: compact.format(r.downloads) })}
              </span>
              {r.unsupported && <span className="local-why">{t(`local.unsupported.${r.unsupported}`)}</span>}
            </button>
            {open === r.repo && <Variants repo={r.repo} status={status} actions={actions} pullOf={pullOf} />}
          </li>
        ))}
      </ul>
    </>
  );
}

function Variants({ repo, status, actions, pullOf }: { repo: string; status: LocalStatus; actions: PullActions; pullOf(model: string): LocalPull | undefined }) {
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
          <PullControl model={v.model} sizeBytes={v.sizeBytes} installed={v.installed} pull={pullOf(v.model)} actions={actions} />
        </li>
      ))}
    </ul>
  );
}
