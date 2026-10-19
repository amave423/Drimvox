import type { SettingsPatch } from "@artel/shared";
import type { ReactNode } from "react";
import { useApp } from "../context";
import type { MessageKey } from "../i18n";
import { ModelPicker } from "./chat/ModelPicker";

type Ref = { providerId: string; model: string } | null;

function ModelSetting(p: { title: MessageKey; hint: ReactNode; value: Ref; image?: boolean; vision?: boolean; onChange(v: Ref): void }) {
  const { t } = useApp();
  return (
    <div className="model-setting">
      <h3>{t(p.title)}</h3>
      <p className="muted">{p.hint}</p>
      <div className="actions">
        <ModelPicker
          value={p.value && (p.image ? { ...p.value, kind: "image" } : p.value)}
          kinds={p.image ? ["image"] : undefined}
          vision={p.vision}
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
 * The model that looks at the agent's screenshots of pages, for project work (docs/specs/project-work.md). A task's
 * agent checks its own work, so there is no reviewer to choose any more; it needs eyes only when its model has none.
 */
export function ProjectModels({ save }: { save(patch: SettingsPatch): void }) {
  const { t, settings } = useApp();
  return (
    <section aria-labelledby="project-models-h">
      <h2 className="sheet-h" id="project-models-h">
        {t("settings.projectModels")}
      </h2>
      {/* Only models that see pictures: a model without eyes cannot judge a screenshot. */}
      <ModelSetting title="settings.visionModel" vision hint={t("settings.visionModelHint")} value={settings.visionModel} onChange={(visionModel) => save({ visionModel })} />
    </section>
  );
}
