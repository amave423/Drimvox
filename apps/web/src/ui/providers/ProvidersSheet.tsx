import { useEffect, useState } from "react";
import { useApp } from "../../context";
import { ConnectForm } from "./ConnectForm";
import { Tabs } from "../Tabs";
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
  // Models on this computer live in "Local models": Ollama and the picture engine are run from there (seen: Ollama in the
  // keys' list looked out of place, and opening the list woke it).
  const own = providers.filter((p) => p.preset !== "ollama" && p.preset !== "sdcpp");
  const bySubscription = own.filter((p) => p.billing === "subscription");
  const byKey = own.filter((p) => p.billing !== "subscription");
  // By key or by subscription, each on its own tab; the way to connect comes first (seen: with many providers it was
  // far down the page).
  const [tab, setTab] = useState<"key" | "subscription">("key");
  const list = tab === "key" ? byKey : bySubscription;

  return (
    <article className="sheet">
      <div className="sheet-body">
        <h1>{t("providers.title")}</h1>
        <Tabs
          value={tab}
          label={t("providers.title")}
          options={[
            { value: "key", label: t("providers.tab.key", { n: byKey.length }) },
            { value: "subscription", label: t("providers.tab.subscription", { n: bySubscription.length }) },
          ]}
          onChange={(v) => setTab(v as "key" | "subscription")}
        />
        <p className="muted providers-lede">{t(tab === "key" ? "providers.lede" : "providers.subscriptionsLede")}</p>
        <h2 className="sheet-h">{t(tab === "key" ? "providers.add" : "providers.addSubscription")}</h2>
        <ConnectForm key={tab} kind={tab} />
        <h2 className="sheet-h">{t(tab === "key" ? "providers.connected" : "providers.connectedSubscriptions")}</h2>
        {list.length === 0 ? (
          <p className="muted">{t(tab === "key" ? "providers.empty" : "providers.emptySubscriptions")}</p>
        ) : (
          <ul className="provider-list">
            {list.map((p) => (
              <ProviderRow key={p.id} provider={p} proxySet={proxySet} />
            ))}
          </ul>
        )}
      </div>
      <aside className="margin">
        <p className="note">{t("providers.marginTip")}</p>
      </aside>
    </article>
  );
}
