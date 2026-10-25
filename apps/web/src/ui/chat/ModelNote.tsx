import type { ModelInfo } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { useApp } from "../../context";
import { formatPrice, formatTokens } from "../../lib/format";
import type { ModelChoice } from "../../lib/lastModel";
import { loadModels } from "../../lib/models";

/** Margin note about the chosen model: context size, price and abilities. */
export function ModelNote({ choice }: { choice: ModelChoice }) {
  const { api, t, settings, providers } = useApp();
  const billing = providers.find((p) => p.id === choice.providerId)?.billing;
  const [model, setModel] = useState<ModelInfo | null>(null);

  useEffect(() => {
    let live = true;
    setModel(null);
    void loadModels(api, choice.providerId).then((r) => {
      if (live && "models" in r) setModel(r.models.find((m) => m.id === choice.model) ?? null);
    });
    return () => {
      live = false;
    };
  }, [api, choice.providerId, choice.model]);

  if (!model) return null;
  const free = model.priceIn === 0 && model.priceOut === 0;
  return (
    <div className="note">
      <strong>{model.id === "default" && billing === "subscription" ? t("model.cliDefault") : model.name}</strong>
      {model.id === "default" && billing === "subscription" && (
        <p>{model.resolved ? t("model.cliDefaultNow", { model: model.resolved }) : t("model.cliDefaultHint")}</p>
      )}
      {model.contextLength && <p>{t("model.context", { value: formatTokens(model.contextLength, settings.locale) })}</p>}
      {free && <p>{billing === "subscription" ? t("model.subscriptionNote") : billing === "credits" ? t("model.creditsNote") : t("model.free")}</p>}
      {/* An amount and its sign, and the sign and its word, stay on one line (seen: "1200" and "₽ выход" apart). */}
      {!free && model.priceIn !== null && model.priceOut !== null && (
        <p>{t("model.price", { in: keep(formatPrice(model.priceIn)), out: keep(formatPrice(model.priceOut)) }).replace(/ (вход|выход|input|output)/g, `${NBSP}$1`)}</p>
      )}
      {model.priceIn === null && <p>{t("model.priceUnknown")}</p>}
      {model.priceEstimated && <p className="muted">{t("model.priceEstimated")}</p>}
      {model.tools && <p>{t("model.tools")}</p>}
      {model.vision && <p>{t("model.vision")}</p>}
    </div>
  );
}

const NBSP = "\u00a0";
const keep = (amount: string) => amount.replace(/ /g, NBSP);
