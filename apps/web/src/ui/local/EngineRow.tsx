import { useState } from "react";
import { useApp } from "../../context";
import { CheckIcon, CrossIcon } from "../SideChats";

/**
 * An engine Drimvox downloaded, with a way to delete it (asked for); the models stay and bring it back when used.
 * Deleting asks first with a check mark and a cross, as everywhere in the app.
 */
export function EngineRow({ name, onRemove }: { name: string; onRemove(): Promise<boolean> }) {
  const { t } = useApp();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div className="local-row local-engine">
      <span>{t("local.engineHere", { name })}</span>
      {asking ? (
        <span className="gallery-confirm">
          <button
            className="icon-button is-pencil"
            aria-label={t("local.engineRemoveConfirm", { name })}
            title={t("local.engineRemoveConfirm", { name })}
            onClick={() =>
              void onRemove().then((ok) => {
                setAsking(false);
                setBusy(!ok);
              })
            }
          >
            <CheckIcon />
          </button>
          <button className="icon-button" aria-label={t("side.deleteNo")} title={t("side.deleteNo")} onClick={() => setAsking(false)}>
            <CrossIcon />
          </button>
        </span>
      ) : (
        <button type="button" className="link is-pencil" onClick={() => setAsking(true)}>
          {t("local.engineRemove")}
        </button>
      )}
      {busy && <span className="local-why">{t("local.engineBusy")}</span>}
    </div>
  );
}
