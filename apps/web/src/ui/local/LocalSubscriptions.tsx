import { subscriptionKinds, type AccountLimits, type CliProxyStatus, type SubscriptionAccount, type SubscriptionKind, type SubscriptionLogin } from "@drimvox/shared";
import { useCallback, useEffect, useState } from "react";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";
import { forgetModels } from "../../lib/models";
import { Toggle } from "../Toggle";
import { useSize } from "./size";

/** Account kinds with a name of their own; CLIProxyAPI calls Claude both "anthropic" and "claude". */
const KNOWN_KINDS = new Set(["anthropic", "claude", "codex", "antigravity", "gemini", "gemini-cli", "kimi", "xai"]);

/** What a limit's window is called: five hours, a week, or a model's own quota. */
function windowLabel(t: (k: MessageKey, v?: Record<string, string | number>) => string, window: string): string {
  if (window === "five_hour") return t("subs.window.five_hour");
  if (window === "seven_day") return t("subs.window.seven_day");
  const week = window.match(/^seven_day_(.+)$/);
  if (week) return t("subs.window.weekModel", { model: week[1]! });
  return window;
}

/** "in 2 h 15 min" until a limit starts over; nothing when the service does not say. */
function resetIn(t: (k: MessageKey, v?: Record<string, string | number>) => string, at: string | null): string {
  if (!at) return "";
  const ms = new Date(at).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return t("subs.resetNow");
  const minutes = Math.round(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return t("subs.resetDays", { days, hours });
  if (hours > 0) return t("subs.resetHours", { hours, mins });
  return t("subs.resetMins", { mins });
}

/**
 * Free access through one's own subscriptions (asked for: CLIProxyAPI on its own tab of the local models): download and
 * remove it like the other engines, switch its server on and off, keep it running after Drimvox closes or not, sign in
 * to accounts, and see each account's limits with the time they start over, as the services' own sites show them.
 */
export function LocalSubscriptions() {
  const { api, t, reloadProviders } = useApp();
  const size = useSize();
  const [status, setStatus] = useState<CliProxyStatus | null>(null);
  const [accounts, setAccounts] = useState<SubscriptionAccount[]>([]);
  const [limits, setLimits] = useState<AccountLimits[]>([]);
  const [login, setLogin] = useState<(SubscriptionLogin & { kind: SubscriptionKind }) | null>(null);
  const [pasted, setPasted] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const load = useCallback(async () => {
    const next = (await api.subscriptions.$get().then((r) => r.json()).catch(() => null)) as CliProxyStatus | null;
    setStatus(next);
    if (next?.running) {
      setAccounts(((await api.subscriptions.accounts.$get().then((r) => (r.ok ? r.json() : [])).catch(() => [])) as SubscriptionAccount[]) ?? []);
    } else setAccounts([]);
  }, [api]);

  const loadLimits = useCallback(async () => {
    setLimits(((await api.subscriptions.limits.$get().then((r) => (r.ok ? r.json() : [])).catch(() => [])) as AccountLimits[]) ?? []);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);
  // While it downloads, progress every second.
  useEffect(() => {
    if (!status?.download) return;
    const timer = setInterval(() => void load(), 1000);
    return () => clearInterval(timer);
  }, [status?.download, load]);
  // Limits when the accounts are known, and again every minute: the bars move as the accounts are used.
  useEffect(() => {
    if (!accounts.length) return setLimits([]);
    void loadLimits();
    const timer = setInterval(() => void loadLimits(), 60_000);
    return () => clearInterval(timer);
  }, [accounts.length, loadLimits]);
  // A sign-in under way: asked every two seconds whether it is done.
  useEffect(() => {
    if (!login) return;
    const timer = setInterval(async () => {
      const res = await api.subscriptions.login[":state"].$get({ param: { state: login.state } }).catch(() => null);
      const body = res?.ok ? ((await res.json()) as { status: string; error: string | null }) : null;
      if (body?.status === "ok") {
        setLogin(null);
        setPasted("");
        if (status?.providerId) forgetModels(status.providerId);
        await reloadProviders();
        await load();
      } else if (body?.status === "error") {
        setLogin(null);
        setProblem(body.error ?? t("subs.loginFailed"));
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [login, api, load, reloadProviders, status?.providerId, t]);

  async function patch(json: { running?: boolean; stopOnQuit?: boolean }) {
    setProblem(null);
    const res = await api.subscriptions.$patch({ json }).catch(() => null);
    if (!res?.ok) setProblem(t("subs.startFailed"));
    await load();
    await reloadProviders();
  }

  async function startLogin(kind: SubscriptionKind) {
    setProblem(null);
    const res = await api.subscriptions.login.$post({ json: { kind } }).catch(() => null);
    if (!res?.ok) return setProblem(t("subs.loginFailed"));
    const body = (await res.json()) as SubscriptionLogin;
    setLogin({ ...body, kind });
    // The service's own sign-in page, in the system's browser on the desktop or a new tab on the server.
    window.open(body.url, "_blank", "noopener");
  }

  async function sendPasted() {
    if (!login || !pasted.trim()) return;
    const res = await api.subscriptions.login.callback.$post({ json: { kind: login.kind, state: login.state, redirectUrl: pasted.trim() } }).catch(() => null);
    if (!res?.ok) setProblem(t("subs.pasteFailed"));
  }

  const kindName = (kind: string) => (KNOWN_KINDS.has(kind) ? t(`subs.kind.${kind}` as MessageKey) : kind);
  if (!status) return <p className="muted">{t("local.checking")}</p>;
  return (
    <section className="subs">
      <h2 className="sheet-h">{t("subs.title")}</h2>
      <p className="muted">{t("subs.hint")}</p>
      <p className="note is-pencil">{t("subs.risk")}</p>
      {!status.supported && <p className="note">{t("subs.unsupported")}</p>}

      {status.supported && !status.installed && (
        <div className="local-row local-engine">
          <span>{t("subs.engine")}</span>
          {status.download ? (
            <span className="muted">
              {status.download.total > 0 ? t("subs.downloading", { done: size(status.download.received), total: size(status.download.total) }) : t("subs.downloadStarting")}
            </span>
          ) : (
            <button type="button" className="btn" onClick={() => void api.subscriptions.install.$post().then(() => load())}>
              {t("subs.download")}
            </button>
          )}
        </div>
      )}

      {status.installed && (
        <>
          <div className="subs-switches">
            <Toggle checked={status.running} onChange={(running) => void patch({ running })}>
              {t(status.running ? "subs.serverOn" : "subs.serverOff", { port: status.port ?? 0 })}
            </Toggle>
            <Toggle checked={status.stopOnQuit} onChange={(stopOnQuit) => void patch({ stopOnQuit })}>
              {t("subs.stopOnQuit")}
            </Toggle>
            <p className="setting-about">{t(status.stopOnQuit ? "subs.stopOnQuitHint" : "subs.keepRunningHint")}</p>
          </div>

          {status.running && (
            <>
              <h3 className="subs-h">{t("subs.accounts")}</h3>
              {accounts.length === 0 && <p className="muted">{t("subs.noAccounts")}</p>}
              <ul className="local-list">
                {accounts.map((a) => (
                  <li key={a.name} className="local-row">
                    <span className="local-model-name">
                      {kindName(a.kind)}
                      {a.email && <small className="muted">{a.email}</small>}
                    </span>
                    <span className={a.status === "active" && !a.disabled ? "is-ok" : "is-pencil-text"}>{a.disabled ? t("subs.disabled") : a.status}</span>
                    <button
                      type="button"
                      className="link"
                      onClick={() => void api.subscriptions.accounts[":name"].$delete({ param: { name: a.name } }).then(() => load())}
                    >
                      {t("local.remove")}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="subs-logins" role="group" aria-label={t("subs.signIn")}>
                <span className="field-label">{t("subs.signIn")}</span>
                {subscriptionKinds.map((kind) => (
                  <button key={kind} type="button" className="btn" disabled={!!login} onClick={() => void startLogin(kind)}>
                    {kindName(kind)}
                  </button>
                ))}
              </div>
              {login && (
                <div className="note subs-login" role="status">
                  <p>{t("subs.loginOpened", { kind: kindName(login.kind) })}</p>
                  {login.userCode && (
                    <p>
                      {t("subs.userCode")} <strong className="mono">{login.userCode}</strong>
                    </p>
                  )}
                  <p>
                    <a href={login.url} target="_blank" rel="noopener noreferrer">
                      {t("subs.openAgain")}
                    </a>
                  </p>
                  {!login.userCode && (
                    <form
                      className="inline-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void sendPasted();
                      }}
                    >
                      <input className="field-input mono" value={pasted} placeholder={t("subs.pastePlaceholder")} aria-label={t("subs.paste")} onChange={(e) => setPasted(e.target.value)} />
                      <button className="btn" disabled={!pasted.trim()}>
                        {t("subs.pasteSend")}
                      </button>
                    </form>
                  )}
                  <p className="muted">{t("subs.pasteHint")}</p>
                  <button type="button" className="link" onClick={() => setLogin(null)}>
                    {t("providers.cancel")}
                  </button>
                </div>
              )}

              {limits.length > 0 && (
                <>
                  <h3 className="subs-h">{t("subs.limits")}</h3>
                  {limits.map((l) => (
                    <div key={l.account} className="subs-limits">
                      <strong>
                        {kindName(l.kind)}
                        {l.email && <small className="muted"> {l.email}</small>}
                      </strong>
                      {l.windows.length === 0 && <p className="muted">{t(l.note === "failed" ? "subs.limitsFailed" : "subs.limitsNone")}</p>}
                      {l.windows.map((w) => (
                        <div key={w.window} className="subs-limit">
                          <span className="subs-limit-name">{windowLabel(t, w.window)}</span>
                          <span className="subs-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={w.usedPercent} aria-label={windowLabel(t, w.window)}>
                            <span style={{ width: `${Math.min(100, Math.max(0, w.usedPercent))}%` }} className={w.usedPercent >= 90 ? "is-full" : undefined} />
                          </span>
                          <span className="muted subs-limit-left">
                            {t("subs.used", { percent: w.usedPercent })}
                            {w.resetsAt ? ` · ${resetIn(t, w.resetsAt)}` : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                </>
              )}
              {status.providerId && <p className="note">{t("subs.inPicker")}</p>}
            </>
          )}

          <p className="muted">{t("subs.version", { version: status.version ?? "" })}</p>
          {confirmRemove ? (
            <span className="local-actions">
              <button
                type="button"
                className="btn is-pencil"
                onClick={async () => {
                  setConfirmRemove(false);
                  await api.subscriptions.$delete().catch(() => null);
                  await load();
                  await reloadProviders();
                }}
              >
                {t("subs.removeConfirm")}
              </button>
              <button type="button" className="link" onClick={() => setConfirmRemove(false)}>
                {t("local.keep")}
              </button>
            </span>
          ) : (
            <button type="button" className="link is-pencil" onClick={() => setConfirmRemove(true)}>
              {t("subs.remove")}
            </button>
          )}
        </>
      )}
      {(status.error || problem) && <p className="error-note">{problem ?? status.error}</p>}
    </section>
  );
}
