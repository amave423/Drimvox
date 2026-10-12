import type { ModelInfo } from "@artel/shared";
import { useEffect, useState } from "react";
import { useApp } from "../../context";
import { formatPrice, formatTokens } from "../../lib/format";
import type { ModelChoice } from "../../lib/lastModel";
import { loadModels } from "../../lib/models";

/** Margin note about the chosen model: context size, price and abilities. */
export function ModelNote({ choice }: { choice: ModelChoice }) {
  const { api, t, settings, providers } = useApp();
  const credits = providers.find((p) => p.id === choice.providerId)?.billing === "credits";
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
      <strong>{model.name}</strong>
      {model.contextLength && <p>{t("model.context", { value: formatTokens(model.contextLength, settings.locale) })}</p>}
      {free && <p>{credits ? t("model.creditsNote") : t("model.free")}</p>}
      {!free && model.priceIn !== null && model.priceOut !== null && (
        <p>{t("model.price", { in: formatPrice(model.priceIn), out: formatPrice(model.priceOut) })}</p>
      )}
      {model.priceIn === null && <p>{t("model.priceUnknown")}</p>}
      {model.priceEstimated && <p className="muted">{t("model.priceEstimated")}</p>}
      {model.tools && <p>{t("model.tools")}</p>}
      {model.vision && <p>{t("model.vision")}</p>}
    </div>
  );
}
