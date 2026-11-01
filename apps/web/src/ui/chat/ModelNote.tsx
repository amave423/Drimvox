import type { ModelInfo } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { useApp } from "../../context";
import { formatPrice } from "../../lib/format";
import type { ModelChoice } from "../../lib/lastModel";
import { loadModels } from "../../lib/models";

/** The chosen model as its provider lists it: context size, price and abilities; null until known. */
export function useModelInfo(choice: ModelChoice | null): ModelInfo | null {
  const { api } = useApp();
  const [model, setModel] = useState<ModelInfo | null>(null);
  useEffect(() => {
    let live = true;
    setModel(null);
    if (!choice) return;
    void loadModels(api, choice.providerId).then((r) => {
      if (live && "models" in r) setModel(r.models.find((m) => m.id === choice.model) ?? null);
    });
    return () => {
      live = false;
    };
  }, [api, choice?.providerId, choice?.model]);
  return model;
}

/** The margin's lines about the chosen model: its name and provider, price and abilities. */
export function ModelNote({ choice, model }: { choice: ModelChoice; model: ModelInfo }) {
  const { t, providers } = useApp();
  const provider = providers.find((p) => p.id === choice.providerId);
  const billing = provider?.billing;
  const free = model.priceIn === 0 && model.priceOut === 0;
  const cliDefault = model.id === "default" && billing === "subscription";
  return (
    <>
      <p className="margin-model">
        {cliDefault ? t("model.cliDefault") : model.name} {provider && <span className="muted">{provider.name}</span>}
      </p>
      {cliDefault && <p>{model.resolved ? t("model.cliDefaultNow", { model: model.resolved }) : t("model.cliDefaultHint")}</p>}
      {free && <p className="muted">{billing === "subscription" ? t("model.subscriptionNote") : billing === "credits" ? t("model.creditsNote") : t("model.free")}</p>}
      {/* An amount and its sign, and the sign and its word, stay on one line (seen: "1200" and "₽ выход" apart). */}
      {!free && model.priceIn !== null && model.priceOut !== null && (
        <p className="mono margin-price">{t("model.price", { in: keep(formatPrice(model.priceIn)), out: keep(formatPrice(model.priceOut)) }).replace(/ (вход|выход|input|output)/g, `${NBSP}$1`)}</p>
      )}
      {model.priceIn === null && <p className="muted">{t("model.priceUnknown")}</p>}
      {model.priceEstimated && <p className="muted">{t("model.priceEstimated")}</p>}
      {(model.tools || model.vision) && <p className="muted">{[model.tools && t("model.tools"), model.vision && t("model.vision")].filter(Boolean).join(" ")}</p>}
    </>
  );
}

const NBSP = " ";
const keep = (amount: string) => amount.replace(/ /g, NBSP);
