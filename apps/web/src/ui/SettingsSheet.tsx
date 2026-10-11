import { locales, themes, type SettingsPatch } from "@artel/shared";
import { useState } from "react";
import { useApp } from "../context";
import { Segmented } from "./Segmented";

const localeNames = { ru: "Русский", en: "English" } as const;

type SaveState = "idle" | "saved" | "failed";

export function SettingsSheet() {
  const { t, settings, updateSettings } = useApp();
  const [state, setState] = useState<SaveState>("idle");
  const [budget, setBudget] = useState(String(settings.agentBudgetUsd));

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

        <h2 className="sheet-h">{t("settings.agentBudget")}</h2>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            const value = Number(budget.replace(",", "."));
            if (value >= 0.01) void save({ agentBudgetUsd: value });
          }}
        >
          <input
            className="field-input mono budget-input"
            inputMode="decimal"
            aria-label={t("settings.agentBudget")}
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
          />
          <button className="btn" disabled={!(Number(budget.replace(",", ".")) >= 0.01)}>
            {t("settings.save")}
          </button>
        </form>
        <p className="muted">{t("settings.agentBudgetHint")}</p>
      </div>
      <aside className="margin" aria-live="polite">
        {state === "saved" && <p className="note is-ok">{t("settings.saved")}</p>}
        {state === "failed" && <p className="note is-pencil">{t("settings.saveFailed")}</p>}
      </aside>
    </article>
  );
}
