import type { ProxyCheck } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { useApp } from "../context";
import { ErrorNote } from "./ErrorNote";

type Status = { kind: "checking" } | { kind: "checked"; result: ProxyCheck } | { kind: "invalid" } | null;

/** One HTTP proxy for providers that cannot be reached directly; each provider switches it on for itself. */
export function ProxySection() {
  const { api, t } = useApp();
  const [current, setCurrent] = useState<string | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<Status>(null);

  useEffect(() => {
    void api.proxy
      .$get()
      .then((r) => r.json())
      .then((v) => setCurrent(v.url))
      .catch(() => setCurrent(null));
  }, [api]);

  async function check() {
    setStatus({ kind: "checking" });
    const res = await api.proxy.check.$post().catch(() => null);
    const result: ProxyCheck = res?.ok ? await res.json() : { ok: false, error: { code: "unknown" } };
    setStatus({ kind: "checked", result });
  }

  async function save() {
    const res = await api.proxy.$put({ json: { url: draft.trim() } }).catch(() => null);
    if (!res?.ok) return setStatus({ kind: "invalid" });
    setCurrent((await res.json()).url);
    setDraft("");
    setEditing(false);
    await check();
  }

  async function remove() {
    await api.proxy.$delete().catch(() => null);
    setCurrent(null);
    setStatus(null);
  }

  const form = (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (draft.trim()) void save();
      }}
    >
      <input
        className="field-input mono"
        value={draft}
        autoComplete="off"
        spellCheck={false}
        placeholder={t("settings.proxyPlaceholder")}
        aria-label={t("settings.proxyAddress")}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button className="btn" disabled={!draft.trim()}>
        {t("settings.save")}
      </button>
      {current && (
        <button type="button" className="btn" onClick={() => setEditing(false)}>
          {t("providers.cancel")}
        </button>
      )}
    </form>
  );

  return (
    <>
      <h2 className="sheet-h">
        {t("settings.proxy")}
      </h2>
      <p className="setting-about">{t("settings.proxyHint")}</p>
      {current === undefined ? null : current && !editing ? (
        <div className="actions">
          <span className="mono proxy-address">{current}</span>
          <button className="link" onClick={() => void check()}>
            {t("settings.proxyCheck")}
          </button>
          <button className="link" onClick={() => setEditing(true)}>
            {t("settings.proxyChange")}
          </button>
          <button className="link is-pencil" onClick={() => void remove()}>
            {t("settings.proxyRemove")}
          </button>
        </div>
      ) : (
        form
      )}
      {current && <ProxySites />}
      <div aria-live="polite">
        {status?.kind === "checking" && <p className="muted">{t("settings.proxyChecking")}</p>}
        {status?.kind === "invalid" && <p className="is-pencil-text">{t("settings.proxyInvalid")}</p>}
        {status?.kind === "checked" && status.result.ok && <p className="is-ok">{t("settings.proxyOk", { ms: status.result.ms ?? 0 })}</p>}
        {status?.kind === "checked" && !status.result.ok && status.result.error && <ErrorNote error={status.result.error} />}
      </div>
    </>
  );
}

/**
 * The sites the agent's browser and page reading open through the proxy; the rest go directly (asked for: some Russian
 * sites refuse visitors through a proxy). A site that does not open directly is tried through it and added by itself.
 */
function ProxySites() {
  const { api, t } = useApp();
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  useEffect(() => {
    void api.proxy.sites
      .$get()
      .then((r) => r.json())
      .then((v) => {
        const joined = v.hosts.join("\n");
        setText(joined);
        setSaved(joined);
      })
      .catch(() => setText(""));
  }, [api]);
  async function save() {
    const hosts = (text ?? "").split(/[\s,]+/).filter(Boolean);
    const res = await api.proxy.sites.$put({ json: { hosts } }).catch(() => null);
    if (!res?.ok) return;
    const joined = (await res.json()).hosts.join("\n");
    setText(joined);
    setSaved(joined);
  }
  if (text === null) return null;
  return (
    <div className="proxy-sites">
      <label className="field">
        <span>{t("settings.proxySites")}</span>
        <textarea className="field-input mono" rows={6} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <p className="setting-about">{t("settings.proxySitesHint")}</p>
      <button className="btn" disabled={text === saved} onClick={() => void save()}>
        {t("settings.save")}
      </button>
    </div>
  );
}
