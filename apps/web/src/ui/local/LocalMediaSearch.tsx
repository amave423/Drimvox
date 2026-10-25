import type { HfMediaFile, HfMediaRepo, LocalImagesStatus } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { ok } from "../../api";
import { useApp } from "../../context";
import { HfCard } from "./HfCard";
import { PullControl, type PullActions } from "./PullControl";

/**
 * Hugging Face, only models that make this kind (docs/specs/local-images.md): Drimvox runs one of a family it knows,
 * bringing that family's other files; the rest are shown greyed, with why.
 */
export function LocalMediaSearch({ kind, status, actions }: { kind: "image" | "video"; status: LocalImagesStatus; actions: PullActions }) {
  const { api, t, settings } = useApp();
  const [query, setQuery] = useState("");
  const [repos, setRepos] = useState<HfMediaRepo[] | null>(null);
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
      setRepos(await api.local.images.search.$get({ query: { kind, q: query.trim() } }).then((r) => ok<HfMediaRepo[]>(r)));
    } catch {
      setError(true);
      setRepos(null);
    }
    setSearching(false);
  }

  return (
    <>
      <h2 className="sheet-h">{t("local.hf")}</h2>
      <p className="muted">{t(kind === "image" ? "localImages.hfHint" : "localVideo.hfHint")}</p>
      <form
        className="local-search"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <input
          className="field-input"
          value={query}
          placeholder={t(kind === "image" ? "localImages.hfPlaceholder" : "localVideo.hfPlaceholder")}
          aria-label={t("local.hf")}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" className="btn" disabled={searching || !query.trim()}>
          {t("local.find")}
        </button>
      </form>
      {error && <p className="note is-pencil">{t("local.hfFailed")}</p>}
      {repos && repos.length === 0 && <p className="muted">{t("local.hfNone")}</p>}
      <ul className="hf-cards">
        {repos?.map((r) => (
          <HfCard
            key={r.repo}
            repo={r.repo}
            facts={t("local.downloads", { n: compact.format(r.downloads) })}
            why={r.family ? null : t("localImages.unknownFamily")}
            open={open === r.repo}
            onToggle={() => setOpen(open === r.repo ? null : r.repo)}
          >
            <Files repo={r.repo} status={status} actions={actions} />
          </HfCard>
        ))}
      </ul>
    </>
  );
}

function Files({ repo, status, actions }: { repo: string; status: LocalImagesStatus; actions: PullActions }) {
  const { api, t } = useApp();
  const [files, setFiles] = useState<HfMediaFile[] | null>(null);
  const [error, setError] = useState(false);
  const installed = status.models.filter((m) => m.installed).map((m) => m.id).join();
  useEffect(() => {
    let live = true;
    void api.local.images.hf
      .$get({ query: { repo } })
      .then((r) => ok<HfMediaFile[]>(r))
      .then((list) => live && setFiles(list))
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, [api, repo, installed]);
  if (error) return <p className="note is-pencil">{t("local.hfFailed")}</p>;
  if (!files) return <p className="muted">{t("local.checking")}</p>;
  if (files.length === 0) return <p className="muted">{t("local.variantsNone")}</p>;
  const pullOf = (model: string) => status.models.find((m) => m.id === model)?.pull ?? undefined;
  return (
    <ul className="local-variants">
      {files.map((f) => (
        <li key={f.file} className={`local-row${f.fit ? "" : " is-unsupported"}`}>
          <span className="mono">{f.quant ?? f.file}</span>
          {f.recommended && <span className="option-rec">{t("local.advice")}</span>}
          {f.fit ? (
            <span className={`local-fit is-${f.fit}`}>{t(f.fit === "fast" ? "local.fast" : "local.slow")}</span>
          ) : (
            <span className="local-why">{t("local.unsupported.too_big")}</span>
          )}
          {f.fit && <PullControl model={f.model} sizeBytes={f.sizeBytes} installed={f.installed} pull={pullOf(f.model)} actions={actions} />}
        </li>
      ))}
    </ul>
  );
}
