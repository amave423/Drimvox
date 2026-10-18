import { CONFIRM_ABOVE_USD, type SettingsPatch } from "@artel/shared";
import type { ReactNode } from "react";
import { useApp } from "../context";
import type { MessageKey } from "../i18n";
import { formatUsd } from "../lib/format";
import { ModelPicker } from "./chat/ModelPicker";

type Ref = { providerId: string; model: string } | null;

function ModelSetting(p: { title: MessageKey; hint: ReactNode; value: Ref; image?: boolean; onChange(v: Ref): void }) {
  const { t } = useApp();
  return (
    <div className="model-setting">
      <h3>{t(p.title)}</h3>
      <p className="muted">{p.hint}</p>
      <div className="actions">
        <ModelPicker
          value={p.value && (p.image ? { ...p.value, kind: "image" } : p.value)}
          kinds={p.image ? ["image"] : undefined}
          onChange={({ providerId, model }) => p.onChange({ providerId, model })}
        />
        {p.value && (
          <button className="link" onClick={() => p.onChange(null)}>
            {t("settings.clear")}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Extra models for project work, none of them required (seen: four pickers in a row read as four things to set).
 * The reviewer is the one that matters in the task loop; the rest wait under "More".
 */
export function ProjectModels({ save }: { save(patch: SettingsPatch): void }) {
  const { t, settings } = useApp();
  return (
    <section aria-labelledby="project-models-h">
      <h2 className="sheet-h" id="project-models-h">
        {t("settings.projectModels")}
      </h2>
      <p className="muted">{t("settings.projectModelsLede")}</p>
      <ModelSetting title="settings.acceptanceModel" hint={t("settings.acceptanceModelHint")} value={settings.acceptanceModel} onChange={(acceptanceModel) => save({ acceptanceModel })} />
      <details className="more-settings">
        <summary>{t("settings.moreModels")}</summary>
        <ModelSetting
          title="settings.imageModel"
          image
          hint={t("settings.imageModelHint", { limit: formatUsd(CONFIRM_ABOVE_USD) })}
          value={settings.imageModel}
          onChange={(imageModel) => save({ imageModel })}
        />
        <ModelSetting title="settings.visionModel" hint={t("settings.visionModelHint")} value={settings.visionModel} onChange={(visionModel) => save({ visionModel })} />
        <ModelSetting title="settings.strongModel" hint={t("settings.strongModelHint")} value={settings.strongModel} onChange={(strongModel) => save({ strongModel })} />
      </details>
    </section>
  );
}
