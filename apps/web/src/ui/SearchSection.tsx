import type { SearchCheck, SearchView } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { useApp } from "../context";
import { Segmented } from "./Segmented";

type Service = "tavily" | "brave";
type Status = { kind: "checking" } | { kind: "checked"; result: SearchCheck } | null;

const SIGN_UP: Record<Service, string> = { tavily: "https://app.tavily.com/", brave: "https://api-dashboard.search.brave.com/" };

/**
 * Where models search the web (docs/specs/web-search.md): the free search, often limited, or Tavily or Brave with the
 * user's key (seen live: DuckDuckGo blocked search again and again). The key never comes back from the core.
 */
export function SearchSection() {
  const { api, t } = useApp();
  const [view, setView] = useState<SearchView | null>(null);
  const [service, setService] = useState<Service>("tavily");
  const [key, setKey] = useState("");
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  useEffect(() => {
    void api.search
      .$get()
      .then((r) => r.json())
      .then((v) => {
        setView(v);
        if (v.service !== "free") setService(v.service);
      })
      .catch(() => setView({ service: "free", hasKey: false }));
  }, [api]);

  async function check() {
    setStatus({ kind: "checking" });
    const res = await api.search.check.$post({ json: {} }).catch(() => null);
    setStatus({ kind: "checked", result: res?.ok ? await res.json() : { ok: false, error: { code: "failed" } } });
  }

  async function save() {
    const res = await api.search.$put({ json: { service, key: key.trim() } }).catch(() => null);
    if (!res?.ok) return setStatus({ kind: "checked", result: { ok: false, error: { code: "failed" } } });
    setView(await res.json());
    setKey("");
    setEditing(false);
    await check();
  }

  async function remove() {
    const res = await api.search.$delete().catch(() => null);
    if (res?.ok) setView(await res.json());
    setStatus(null);
  }

  if (!view) return null;
  const keyed = view.service !== "free";
  return (
    <>
      <h2 className="sheet-h">
        {t("settings.search")}
      </h2>
      <p className="setting-about">{t("settings.searchHint")}</p>
      {keyed && !editing ? (
        <div className="actions">
          <span>{t("settings.searchUses", { name: t(`settings.search.${view.service}`) })}</span>
          <button className="link" onClick={() => void check()}>
            {t("settings.proxyCheck")}
          </button>
          <button className="link" onClick={() => setEditing(true)}>
            {t("settings.proxyChange")}
          </button>
          <button className="link is-pencil" onClick={() => void remove()}>
            {t("settings.searchFree")}
          </button>
        </div>
      ) : (
        <>
          {!keyed && <p className="muted">{t("settings.searchNow")}</p>}
          <span id="search-service-label" className="visually-hidden">
            {t("settings.searchService")}
          </span>
          <Segmented
            labelledBy="search-service-label"
            value={service}
            options={(["tavily", "brave"] as const).map((v) => ({ value: v, label: t(`settings.search.${v}`) }))}
            onChange={(v) => setService(v as Service)}
          />
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (key.trim()) void save();
            }}
          >
            <input
              className="field-input mono"
              type="password"
              value={key}
              autoComplete="off"
              spellCheck={false}
              placeholder={t("settings.searchKey")}
              aria-label={t("settings.searchKey")}
              onChange={(e) => setKey(e.target.value)}
            />
            <button className="btn" disabled={!key.trim()}>
              {t("settings.save")}
            </button>
            {keyed && (
              <button type="button" className="btn" onClick={() => setEditing(false)}>
                {t("providers.cancel")}
              </button>
            )}
          </form>
          <p className="muted">
            <a href={SIGN_UP[service]} target="_blank" rel="noreferrer">
              {t("settings.searchGetKey", { name: t(`settings.search.${service}`) })}
            </a>{" "}
            {t(`settings.searchFreeTier.${service}`)}
          </p>
        </>
      )}
      <div aria-live="polite">
        {status?.kind === "checking" && <p className="muted">{t("settings.proxyChecking")}</p>}
        {status?.kind === "checked" && status.result.ok && <p className="is-ok">{t("settings.searchOk", { ms: status.result.ms ?? 0 })}</p>}
        {status?.kind === "checked" && !status.result.ok && <p className="is-pencil-text">{t(`settings.searchError.${status.result.error?.code ?? "failed"}`)}</p>}
      </div>
    </>
  );
}
