import type { HfAudioFile, HfAudioRepo, LocalAudioStatus } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { ok } from "../../api";
import { useApp } from "../../context";
import { HfCard } from "./HfCard";
import { PullControl, type PullActions } from "./PullControl";

/**
 * Speech models on Hugging Face (asked for: the audio tab had no search): the repositories with whisper.cpp's files
 * first, the rest greyed with why; a file downloads like Drimvox's own models.
 */
export function LocalAudioSearch({ status, actions }: { status: LocalAudioStatus; actions: PullActions }) {
  const { api, t, settings } = useApp();
  const [query, setQuery] = useState("");
  const [repos, setRepos] = useState<HfAudioRepo[] | null>(null);
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
      setRepos(await api.local.audio.search.$get({ query: { q: query.trim() } }).then((r) => ok<HfAudioRepo[]>(r)));
    } catch {
      setError(true);
      setRepos(null);
    }
    setSearching(false);
  }

  return (
    <>
      <h2 className="sheet-h">{t("local.hf")}</h2>
      <p className="muted">{t("localAudio.hfHint")}</p>
      <form
        className="local-search"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <input className="field-input" value={query} placeholder={t("localAudio.hfPlaceholder")} aria-label={t("local.hf")} onChange={(e) => setQuery(e.target.value)} />
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
            why={r.runnable ? null : t("localAudio.notGgml")}
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

function Files({ repo, status, actions }: { repo: string; status: LocalAudioStatus; actions: PullActions }) {
  const { api, t } = useApp();
  const [files, setFiles] = useState<HfAudioFile[] | null>(null);
  const [error, setError] = useState(false);
  const installed = status.models.filter((m) => m.installed).map((m) => m.id).join();
  useEffect(() => {
    let live = true;
    void api.local.audio.hf
      .$get({ query: { repo } })
      .then((r) => ok<HfAudioFile[]>(r))
      .then((list) => live && setFiles(list))
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, [api, repo, installed]);
  if (error) return <p className="note is-pencil">{t("local.hfFailed")}</p>;
  if (!files) return <p className="muted">{t("local.checking")}</p>;
  if (files.length === 0) return <p className="muted">{t("localAudio.noFiles")}</p>;
  const pullOf = (model: string) => status.models.find((m) => m.id === model)?.pull ?? undefined;
  return (
    <ul className="local-variants">
      {files.map((f) => (
        <li key={f.file} className="local-row">
          <span className="mono">{f.file}</span>
          <PullControl model={f.model} sizeBytes={f.sizeBytes} installed={f.installed} pull={pullOf(f.model)} actions={actions} />
        </li>
      ))}
    </ul>
  );
}
