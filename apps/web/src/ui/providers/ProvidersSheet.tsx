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
  const bySubscription = providers.filter((p) => p.billing === "subscription");
  const byKey = providers.filter((p) => p.billing !== "subscription");
  return (
    <article className="sheet">
      <div className="sheet-body">
        <h1>{t("providers.title")}</h1>
        <p className="lede">{t("providers.lede")}</p>
        {byKey.length === 0 ? (
          <p className="muted">{t("providers.empty")}</p>
        ) : (
          <ul className="provider-list">
            {byKey.map((p) => (
              <ProviderRow key={p.id} provider={p} proxySet={proxySet} />
            ))}
          </ul>
        )}
        <h2 className="sheet-h">{t("providers.add")}</h2>
        <ConnectForm kind="key" />

        {/* Programs that run on the user's subscription: no key, no money, their own limits (seen: mixed with the keys they were hard to find). */}
        <section className="subscriptions" aria-labelledby="subscriptions-h">
          <h2 className="sheet-h" id="subscriptions-h">
            {t("providers.subscriptions")}
          </h2>
          <p className="muted">{t("providers.subscriptionsLede")}</p>
          {bySubscription.length > 0 && (
            <ul className="provider-list">
              {bySubscription.map((p) => (
                <ProviderRow key={p.id} provider={p} proxySet={proxySet} />
              ))}
            </ul>
          )}
          <ConnectForm kind="subscription" />
        </section>
      </div>
      <aside className="margin">
        <p className="note">{t("providers.marginTip")}</p>
      </aside>
    </article>
  );
}
