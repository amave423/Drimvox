import { useApp } from "../../context";
import { ConnectForm } from "./ConnectForm";
import { ProviderRow } from "./ProviderRow";

export function ProvidersSheet() {
  const { t, providers } = useApp();
  return (
    <article className="sheet">
      <div className="sheet-body">
        <h1>{t("providers.title")}</h1>
        <p className="lede">{t("providers.lede")}</p>
        {providers.length === 0 ? (
          <p className="muted">{t("providers.empty")}</p>
        ) : (
          <ul className="provider-list">
            {providers.map((p) => (
              <ProviderRow key={p.id} provider={p} />
            ))}
          </ul>
        )}
        <h2 className="sheet-h">{t("providers.add")}</h2>
        <ConnectForm />
      </div>
      <aside className="margin">
        <p className="note">{t("providers.marginTip")}</p>
      </aside>
    </article>
  );
}
