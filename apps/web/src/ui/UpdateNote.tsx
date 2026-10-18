import { useEffect, useState } from "react";
import { useApp } from "../context";

/** A newer version of the desktop app, in the bottom bar: its download, then a restart into it. */
export function UpdateNote() {
  const { t } = useApp();
  const [update, setUpdate] = useState<UpdateState | null>(null);
  useEffect(() => {
    const bridge = window.artel;
    if (!bridge?.updateState) return;
    void bridge.updateState().then((s) => s && setUpdate(s));
    return bridge.onUpdate(setUpdate);
  }, []);
  // The bottom bar speaks only of a new version; checking and failures are in the settings.
  if (!update || !["downloading", "ready", "manual"].includes(update.state)) return null;
  if (update.state === "downloading") {
    return <span className="update-note muted">{t("update.downloading", { version: update.version, percent: update.percent ?? 0 })}</span>;
  }
  if (update.state === "manual") {
    return (
      <span className="update-note">
        {t("update.manual", { version: update.version })}{" "}
        <a href={update.url} target="_blank" rel="noreferrer">
          {t("update.get")}
        </a>
      </span>
    );
  }
  return (
    <span className="update-note">
      {t("update.ready", { version: update.version })}{" "}
      <button type="button" className="link" onClick={() => window.artel?.installUpdate()}>
        {t("update.restart")}
      </button>
    </span>
  );
}
