import { presets, type PresetId } from "@drimvox/shared";
import { useEffect, useState, type ReactNode } from "react";
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
  const own = providers.filter((p) => p.preset !== "ollama" && p.preset !== "sdcpp" && p.preset !== "whispercpp");
  // Coding plans are subscriptions too, though reached by a key.
  const subscribed = (p: (typeof own)[number]) => p.billing === "subscription" || !!presets[p.preset as PresetId]?.plan;
  const bySubscription = own.filter(subscribed);
  const byKey = own.filter((p) => !subscribed(p));
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
        <Folding id="add" title={t(tab === "key" ? "providers.add" : "providers.addSubscription")}>
          <ConnectForm key={tab} kind={tab} />
        </Folding>
        <Folding id="connected" title={t(tab === "key" ? "providers.connected" : "providers.connectedSubscriptions")}>
          {list.length === 0 ? (
            <p className="muted">{t(tab === "key" ? "providers.empty" : "providers.emptySubscriptions")}</p>
          ) : (
            <ul className="provider-list">
              {list.map((p) => (
                <ProviderRow key={p.id} provider={p} proxySet={proxySet} />
              ))}
            </ul>
          )}
        </Folding>
      </div>
      <aside className="margin">
        <p className="note">{t("providers.marginTip")}</p>
      </aside>
    </article>
  );
}

/** A part of the page folded away with a click on its heading, remembered on this device (asked for: the providers took the page). */
function Folding({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const key = `drimvox.providers.folded.${id}`;
  const [folded, setFolded] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  const toggle = () => {
    setFolded(!folded);
    try {
      localStorage.setItem(key, folded ? "0" : "1");
    } catch {
      // Folded for this visit only.
    }
  };
  return (
    <section className="folding">
      <h2 className="sheet-h">
        <button type="button" className="folding-head" aria-expanded={!folded} onClick={toggle}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
          {title}
        </button>
      </h2>
      {!folded && children}
    </section>
  );
}
