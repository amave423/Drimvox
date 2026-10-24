import { useEffect, useState } from "react";
import { useApp } from "../context";

/**
 * Where updating stands, in the settings of the desktop app (seen: an old version never updated and nothing said why):
 * the version, the last answer from GitHub or what went wrong, and a way to ask now.
 */
export function UpdatesSection() {
  const { t, status, settings } = useApp();
  const [update, setUpdate] = useState<UpdateState | null>(null);
  useEffect(() => {
    const bridge = window.drimvox;
    if (!bridge?.updateState) return;
    void bridge.updateState().then((s) => s && setUpdate(s));
    return bridge.onUpdate(setUpdate);
  }, []);
  if (!window.drimvox) return null;

  const when = (ms: number) => new Date(ms).toLocaleTimeString(settings.locale === "ru" ? "ru-RU" : "en-GB", { hour: "2-digit", minute: "2-digit" });
  const state = update?.state ?? "off";
  const text =
    state === "off"
      ? t("updates.off")
      : state === "idle"
        ? t("updates.idle")
        : state === "checking"
          ? t("updates.checking")
          : state === "latest"
            ? t("updates.latest", { at: when(update!.checkedAt ?? Date.now()) })
            : state === "error"
              ? t("updates.error", { at: when(update!.checkedAt ?? Date.now()) })
              : state === "downloading"
                ? t("update.downloading", { version: update!.version, percent: update!.percent ?? 0 })
                : state === "ready"
                  ? t("update.ready", { version: update!.version })
                  : t("update.manual", { version: update!.version });

  return (
    <section aria-labelledby="updates-h">
      <h2 className="sheet-h" id="updates-h">
        {t("updates.title")}
      </h2>
      <p>
        {t("updates.version", { version: status.version })} <span className={state === "error" ? "is-pencil-text" : "muted"}>{text}</span>
      </p>
      {state === "error" && update?.message && (
        <p className="error-note">
          <span className="mono">{update.message}</span>
          <br />
          {t("updates.log")}
        </p>
      )}
      <div className="actions">
        {state === "ready" ? (
          <button className="btn is-primary" onClick={() => window.drimvox?.installUpdate()}>
            {t("update.restart")}
          </button>
        ) : (
          <button className="btn" disabled={state === "off" || state === "checking" || state === "downloading"} onClick={() => window.drimvox?.checkUpdates()}>
            {t("updates.check")}
          </button>
        )}
        {state === "manual" && update?.url && (
          <a className="btn" href={update.url} target="_blank" rel="noreferrer">
            {t("update.get")}
          </a>
        )}
      </div>
    </section>
  );
}
