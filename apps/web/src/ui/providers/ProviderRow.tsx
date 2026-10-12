import type { Balance, ProviderView } from "@artel/shared";
import { useEffect, useState } from "react";
import { useApp } from "../../context";
import { formatUsd } from "../../lib/format";
import { forgetModels, loadModels, type ModelsResult } from "../../lib/models";
import { ErrorNote } from "../ErrorNote";
import { Toggle } from "../Toggle";
import { presetName } from "./presetName";

type Mode = "idle" | "replaceKey" | "confirmRemove";

function formatBalance(b: Balance, locale: string): string {
  if (b.currency === "USD") return formatUsd(b.amount);
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: b.currency }).format(b.amount);
  } catch {
    return `${b.amount} ${b.currency}`;
  }
}

export function ProviderRow({ provider, proxySet }: { provider: ProviderView; proxySet: boolean }) {
  const { api, t, settings, reloadProviders, reloadChats } = useApp();
  const [check, setCheck] = useState<ModelsResult | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [mode, setMode] = useState<Mode>("idle");
  const [newKey, setNewKey] = useState("");
  const [busy, setBusy] = useState(false);

  async function runCheck(fresh: boolean) {
    setCheck(null);
    const result = await loadModels(api, provider.id, fresh);
    setCheck(result);
    if ("models" in result && provider.billing === "paid") {
      const res = await api.providers[":id"].balance.$get({ param: { id: provider.id } }).catch(() => null);
      const body = res?.ok ? ((await res.json()) as { balance: Balance | null }) : null;
      setBalance(body?.balance ?? null);
    }
  }

  // Checked once per row; key changes re-check explicitly in saveKey.
  useEffect(() => {
    void runCheck(false);
  }, [provider.id]);

  async function saveKey() {
    setBusy(true);
    const res = await api.providers[":id"].$patch({ param: { id: provider.id }, json: { apiKey: newKey } }).catch(() => null);
    setBusy(false);
    if (!res?.ok) return;
    setNewKey("");
    setMode("idle");
    forgetModels(provider.id);
    await reloadProviders();
    void runCheck(true);
  }

  async function switchProxy(useProxy: boolean) {
    const res = await api.providers[":id"].$patch({ param: { id: provider.id }, json: { useProxy } }).catch(() => null);
    if (!res?.ok) return;
    forgetModels(provider.id);
    await reloadProviders();
    void runCheck(true);
  }

  async function remove() {
    setBusy(true);
    await api.providers[":id"].$delete({ param: { id: provider.id } }).catch(() => null);
    forgetModels(provider.id);
    await Promise.all([reloadProviders(), reloadChats()]);
  }

  return (
    <li className="provider">
      <div className="provider-head">
        <h3>{provider.name}</h3>
        <span className="muted">{presetName(t, provider.preset)}</span>
      </div>

      <div className="provider-status" aria-live="polite">
        {check === null && <span className="muted">{t("providers.checking")}</span>}
        {check && "models" in check && (
          <span className="facts">
            <span className="is-ok">✓ {t("providers.models", { count: check.models.length })}</span>
            {balance && <span>{t("providers.balance", { amount: formatBalance(balance, settings.locale) })}</span>}
            {provider.billing === "credits" && <span>{t("providers.billing.credits")}</span>}
            {provider.billing === "free" && <span>{t("providers.billing.free")}</span>}
            {provider.billing === "subscription" && <span>{t("providers.billing.subscription")}</span>}
          </span>
        )}
        {check && "error" in check && <ErrorNote error={check.error} />}
      </div>

      <div className="provider-proxy">
        <Toggle checked={provider.useProxy} disabled={!proxySet && !provider.useProxy} onChange={(on) => void switchProxy(on)}>
          {t("providers.useProxy")}
        </Toggle>
        {!proxySet && <span className="muted">{t("providers.proxyNotSet")}</span>}
      </div>

      {mode === "replaceKey" && (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (newKey.trim()) void saveKey();
          }}
        >
          <input
            className="field-input mono"
            type="password"
            autoComplete="off"
            placeholder={t("providers.newKey")}
            aria-label={t("providers.newKey")}
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            autoFocus
          />
          <button className="btn is-primary" disabled={busy || !newKey.trim()}>
            {t("providers.saveKey")}
          </button>
          <button type="button" className="btn" onClick={() => setMode("idle")}>
            {t("providers.cancel")}
          </button>
        </form>
      )}

      {mode === "confirmRemove" && (
        <div className="inline-form">
          <span>{t("providers.removeConfirm", { name: provider.name })}</span>
          <button className="btn is-pencil" disabled={busy} onClick={() => void remove()}>
            {t("providers.remove")}
          </button>
          <button className="btn" onClick={() => setMode("idle")}>
            {t("providers.cancel")}
          </button>
        </div>
      )}

      {mode === "idle" && (
        <div className="provider-actions">
          <button className="link" onClick={() => void runCheck(true)}>
            {t("providers.recheck")}
          </button>
          {(provider.billing === "paid" || provider.billing === "credits") && (
            <button className="link" onClick={() => setMode("replaceKey")}>
              {t("providers.replaceKey")}
            </button>
          )}
          <button className="link is-pencil" onClick={() => setMode("confirmRemove")}>
            {t("providers.remove")}
          </button>
        </div>
      )}
    </li>
  );
}
