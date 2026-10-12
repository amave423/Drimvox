import { useEffect, useState } from "react";
import { useApp } from "../../context";
import { ConnectForm } from "./ConnectForm";
import { ProviderRow } from "./ProviderRow";

export function ProvidersSheet() {
  const { api, t, providers } = useApp();
  // Whether a proxy is set in the settings; the switch on each provider needs one.
  const [proxySet, setProxySet] = useState(false);
  useEffect(() => {
    void api.proxy
      .$get()
      .then((r) => r.json())
      .then((v) => setProxySet(!!v.url))
      .catch(() => setProxySet(false));
  }, [api]);
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
              <ProviderRow key={p.id} provider={p} proxySet={proxySet} />
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
