import { CONFIRM_ABOVE_USD, currencies, locales, themes, type SettingsPatch } from "@artel/shared";
import { formatUsd } from "../lib/format";
import { useEffect, useState } from "react";
import { useApp } from "../context";
import { ModelPicker } from "./chat/ModelPicker";
import { Segmented } from "./Segmented";
import { McpSection } from "./McpSection";
import { ProxySection } from "./ProxySection";
import { AccountSection } from "./AccountSection";
import { Toggle } from "./Toggle";
import { SkillsSection } from "./SkillsSection";

const localeNames = { ru: "Русский", en: "English" } as const;

type SaveState = "idle" | "saved" | "failed";

export function SettingsSheet() {
  const { t, settings, updateSettings, usdRub } = useApp();
  const [state, setState] = useState<SaveState>("idle");
  // The budget is kept in dollars and edited in the currency on screen.
  const perUsd = settings.currency === "RUB" && usdRub > 0 ? usdRub : 1;
  const shown = (usd: number) => String(Number((usd * perUsd).toFixed(perUsd === 1 ? 2 : 0)));
  const [budget, setBudget] = useState(shown(settings.agentBudgetUsd));
  useEffect(() => setBudget(shown(settings.agentBudgetUsd)), [perUsd]);

  async function save(patch: SettingsPatch) {
    setState((await updateSettings(patch)) ? "saved" : "failed");
  }

  return (
    <article className="sheet">
      <div className="sheet-body">
        <h1>{t("settings.title")}</h1>
        <p className="lede">{t("settings.lede")}</p>

        <h2 className="sheet-h" id="theme-label">
          {t("settings.theme")}
        </h2>
        <Segmented
          labelledBy="theme-label"
          value={settings.theme}
          options={themes.map((v) => ({ value: v, label: t(`settings.theme.${v}`) }))}
          onChange={(theme) => save({ theme })}
        />

        <h2 className="sheet-h" id="locale-label">
          {t("settings.locale")}
        </h2>
        <Segmented
          labelledBy="locale-label"
          value={settings.locale}
          options={locales.map((v) => ({ value: v, label: localeNames[v] }))}
          onChange={(locale) => save({ locale })}
        />

        <h2 className="sheet-h">{t("settings.notifications")}</h2>
        <Toggle
          checked={settings.notifications}
          onChange={(notifications) => {
            // A browser asks the user once before it shows anything.
            if (notifications && !window.artel && typeof Notification !== "undefined" && Notification.permission === "default") {
              void Notification.requestPermission();
            }
            void save({ notifications });
          }}
        >
          {window.artel ? t("settings.notificationsOn") : t("settings.notificationsBrowser")}
        </Toggle>

        <h2 className="sheet-h">{t("settings.developerTitle")}</h2>
        <Toggle checked={settings.developer} onChange={(developer) => void save({ developer })}>
          {t("settings.developer")}
        </Toggle>
        <p className="muted">{t("settings.developerHint")}</p>

        <h2 className="sheet-h" id="currency-label">
          {t("settings.currency")}
        </h2>
        <Segmented
          labelledBy="currency-label"
          value={settings.currency}
          options={currencies.map((v) => ({ value: v, label: t(`settings.currency.${v}`) }))}
          onChange={(currency) => save({ currency })}
        />
        <p className="muted">{usdRub > 0 ? t("settings.currencyHint", { rate: usdRub.toFixed(2).replace(".", ",") }) : null}</p>

        <h2 className="sheet-h">{t(perUsd === 1 ? "settings.agentBudget" : "settings.agentBudgetRub")}</h2>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            const value = Number(budget.replace(",", ".")) / perUsd;
            if (value >= 0.01) void save({ agentBudgetUsd: Number(value.toFixed(4)) });
          }}
        >
          <input
            className="field-input mono budget-input"
            inputMode="decimal"
            aria-label={t("settings.agentBudget")}
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
          />
          <button className="btn" disabled={!(Number(budget.replace(",", ".")) / perUsd >= 0.01)}>
            {t("settings.save")}
          </button>
        </form>
        <p className="muted">{t("settings.agentBudgetHint")}</p>

        <h2 className="sheet-h">{t("settings.strongModel")}</h2>
        <div className="actions">
          <ModelPicker value={settings.strongModel} onChange={(strongModel) => void save({ strongModel })} />
          {settings.strongModel && (
            <button className="link" onClick={() => void save({ strongModel: null })}>
              {t("settings.clear")}
            </button>
          )}
        </div>
        <p className="muted">{t("settings.strongModelHint")}</p>

        <h2 className="sheet-h">{t("settings.acceptanceModel")}</h2>
        <div className="actions">
          <ModelPicker value={settings.acceptanceModel} onChange={({ providerId, model }) => void save({ acceptanceModel: { providerId, model } })} />
          {settings.acceptanceModel && (
            <button className="link" onClick={() => void save({ acceptanceModel: null })}>
              {t("settings.clear")}
            </button>
          )}
        </div>
        <p className="muted">{t("settings.acceptanceModelHint")}</p>

        <h2 className="sheet-h">{t("settings.imageModel")}</h2>
        <div className="actions">
          <ModelPicker
            value={settings.imageModel && { ...settings.imageModel, kind: "image" }}
            kinds={["image"]}
            onChange={({ providerId, model }) => void save({ imageModel: { providerId, model } })}
          />
          {settings.imageModel && (
            <button className="link" onClick={() => void save({ imageModel: null })}>
              {t("settings.clear")}
            </button>
          )}
        </div>
        <p className="muted">{t("settings.imageModelHint", { limit: formatUsd(CONFIRM_ABOVE_USD) })}</p>

        <h2 className="sheet-h">{t("settings.visionModel")}</h2>
        <div className="actions">
          <ModelPicker value={settings.visionModel} onChange={({ providerId, model }) => void save({ visionModel: { providerId, model } })} />
          {settings.visionModel && (
            <button className="link" onClick={() => void save({ visionModel: null })}>
              {t("settings.clear")}
            </button>
          )}
        </div>
        <p className="muted">{t("settings.visionModelHint")}</p>

        {!window.artel && <AccountSection />}
        <ProxySection />
        <McpSection />
        <SkillsSection />
      </div>
      <aside className="margin" aria-live="polite">
        {state === "saved" && <p className="note is-ok">{t("settings.saved")}</p>}
        {state === "failed" && <p className="note is-pencil">{t("settings.saveFailed")}</p>}
      </aside>
    </article>
  );
}
