import { currencies, locales, themes, type SettingsPatch } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { useApp } from "../context";
import { ProjectModels } from "./ProjectModels";
import { Segmented } from "./Segmented";
import { McpSection } from "./McpSection";
import { ProxySection } from "./ProxySection";
import { AccountSection } from "./AccountSection";
import { Toggle } from "./Toggle";
import { SkillsSection } from "./SkillsSection";
import { UpdatesSection } from "./UpdatesSection";

const localeNames = { ru: "Русский", en: "English" } as const;

type SaveState = "idle" | "saved" | "failed";

export function SettingsSheet() {
  const { t, settings, updateSettings, usdRub } = useApp();
  // Windows' Focus Assist hides every app's notifications: said here, where notifications are switched on.
  const [focusAssist, setFocusAssist] = useState(false);
  useEffect(() => {
    void window.drimvox?.focusAssist?.().then((profile) => setFocusAssist(profile === 1 || profile === 2));
  }, []);
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
            if (notifications && !window.drimvox && typeof Notification !== "undefined" && Notification.permission === "default") {
              void Notification.requestPermission();
            }
            void save({ notifications });
          }}
        >
          {window.drimvox ? t("settings.notificationsOn") : t("settings.notificationsBrowser")}
        </Toggle>
        <p className="muted setting-hint">
          {t(window.drimvox ? "settings.notificationsAbout" : "settings.notificationsAboutBrowser")}
          {window.drimvox && (
            <>
              {" "}
              <button type="button" className="link" onClick={() => window.drimvox?.testNotify({ title: t("notice.test"), body: t("notice.testBody") })}>
                {t("settings.notificationsTest")}
              </button>
            </>
          )}
        </p>
        {focusAssist && <p className="note is-pencil">{t("settings.focusAssist")}</p>}

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

        <ProjectModels save={(patch) => void save(patch)} />

        <UpdatesSection />
        {!window.drimvox && <AccountSection />}
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
