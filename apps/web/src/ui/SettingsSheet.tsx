import { currencies, locales, themes, type SettingsPatch } from "@drimvox/shared";
import { useEffect, useState, type ReactNode } from "react";
import { useApp } from "../context";
import { shownSign } from "../lib/format";
import { ProjectModels } from "./ProjectModels";
import { Segmented } from "./Segmented";
import { McpSection } from "./McpSection";
import { ProxySection } from "./ProxySection";
import { AccountSection } from "./AccountSection";
import { Toggle } from "./Toggle";
import { SkillsSection } from "./SkillsSection";
import { UpdatesSection } from "./UpdatesSection";
import { Catalog } from "./Catalog";
import { Hint } from "./Hint";
import { SearchSection } from "./SearchSection";
import { SpendingSection } from "./SpendingSection";
import { Tabs } from "./Tabs";

const localeNames = { ru: "Русский", en: "English" } as const;

type SaveState = "idle" | "saved" | "failed";

/** The settings' sections (seen: one long page of everything was hard to find one's way in). */
const PARTS = ["general", "models", "internet", "mcp", "skills"] as const;
type SettingsPart = (typeof PARTS)[number];
const PART_KEY = "drimvox.settingsPart";

/** The section opened last, in this window. */
function initialPart(): SettingsPart {
  try {
    const kept = localStorage.getItem(PART_KEY);
    if (PARTS.includes(kept as SettingsPart)) return kept as SettingsPart;
  } catch {
    // No storage (a private window): the first section.
  }
  return "general";
}

export function SettingsSheet() {
  const { t, settings, updateSettings, usdRub } = useApp();
  // Windows' Focus Assist hides every app's notifications: said here, where notifications are switched on.
  const [focusAssist, setFocusAssist] = useState(false);
  useEffect(() => {
    void window.drimvox?.focusAssist?.().then((profile) => setFocusAssist(profile === 1 || profile === 2));
  }, []);
  const [state, setState] = useState<SaveState>("idle");
  const [toolsVersion, setToolsVersion] = useState(0);
  const [part, setPartState] = useState<SettingsPart>(initialPart);
  const setPart = (p: SettingsPart) => {
    setPartState(p);
    try {
      localStorage.setItem(PART_KEY, p);
    } catch {
      // Kept for this visit only.
    }
  };
  // The budget is kept in dollars and edited in the currency on screen.
  const perUsd = settings.currency === "RUB" && usdRub > 0 ? usdRub : 1;
  const shown = (usd: number) => String(Number((usd * perUsd).toFixed(perUsd === 1 ? 2 : 0)));
  const [budget, setBudget] = useState(shown(settings.agentBudgetUsd));
  const [monthly, setMonthly] = useState(settings.monthlyBudgetUsd === null ? "" : shown(settings.monthlyBudgetUsd));
  useEffect(() => setBudget(shown(settings.agentBudgetUsd)), [perUsd]);

  async function save(patch: SettingsPatch) {
    setState((await updateSettings(patch)) ? "saved" : "failed");
  }

  const sections: Record<SettingsPart, ReactNode> = {
    general: (
      <>
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

        <h2 className="sheet-h">
          {t("settings.notifications")}
          <Hint text={t(window.drimvox ? "settings.notificationsAbout" : "settings.notificationsAboutBrowser")} />
        </h2>
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
        {window.drimvox && (
          <p>
            <button type="button" className="link" onClick={() => window.drimvox?.testNotify({ title: t("notice.test"), body: t("notice.testBody") })}>
              {t("settings.notificationsTest")}
            </button>
          </p>
        )}
        {focusAssist && <p className="note is-pencil">{t("settings.focusAssist")}</p>}

        <h2 className="sheet-h">
          {t("settings.developerTitle")}
          <Hint text={t("settings.developerHint")} />
        </h2>
        <Toggle checked={settings.developer} onChange={(developer) => void save({ developer })}>
          {t("settings.developer")}
        </Toggle>

        <UpdatesSection />
        {!window.drimvox && <AccountSection />}
      </>
    ),
    models: (
      <>
        <h2 className="sheet-h" id="currency-label">
          {t("settings.currency")}
          {usdRub > 0 && <Hint text={t("settings.currencyHint", { rate: usdRub.toFixed(2).replace(".", ",") })} />}
        </h2>
        <Segmented
          labelledBy="currency-label"
          value={settings.currency}
          options={currencies.map((v) => ({ value: v, label: t(`settings.currency.${v}`) }))}
          onChange={(currency) => save({ currency })}
        />

        <h2 className="sheet-h">
          {t(perUsd === 1 ? "settings.agentBudget" : "settings.agentBudgetRub")}
          <Hint text={t("settings.agentBudgetHint")} />
        </h2>
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

        <h2 className="sheet-h">
          {t("settings.monthlyBudget", { currency: shownSign() })}
          <Hint text={t("settings.monthlyBudgetHint")} />
        </h2>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            const value = Number(monthly.replace(",", ".")) / perUsd;
            void save({ monthlyBudgetUsd: monthly.trim() && value > 0 ? Number(value.toFixed(4)) : null });
          }}
        >
          <input
            className="field-input mono budget-input"
            inputMode="decimal"
            aria-label={t("settings.monthlyBudget", { currency: shownSign() })}
            placeholder={t("settings.monthlyBudgetNone")}
            value={monthly}
            onChange={(e) => setMonthly(e.target.value)}
          />
          <button className="btn">{t("settings.save")}</button>
        </form>

        <SpendingSection />

        <ProjectModels save={(patch) => void save(patch)} />
      </>
    ),
    internet: (
      <>
        <SearchSection />
        <ProxySection />
      </>
    ),
    // Servers and skills apart (seen: one catalog of both was hard to find one's way in); each list shows what a card switched.
    mcp: (
      <>
        <Catalog key="mcp" kind="mcp" onChanged={() => setToolsVersion((v) => v + 1)} />
        <McpSection key={`mcp-${toolsVersion}`} />
      </>
    ),
    skills: (
      <>
        <Catalog key="skill" kind="skill" onChanged={() => setToolsVersion((v) => v + 1)} />
        <SkillsSection key={`skills-${toolsVersion}`} />
      </>
    ),
  };

  return (
    <article className="sheet">
      <div className="sheet-body">
        <h1>{t("settings.title")}</h1>
        <Tabs
          value={part}
          label={t("settings.title")}
          options={PARTS.map((p) => ({ value: p, label: t(`settings.part.${p}`) }))}
          onChange={(p) => {
            setPart(p);
            setState("idle");
          }}
        />
        {sections[part]}
      </div>
      <aside className="margin" aria-live="polite">
        {state === "saved" && <p className="note is-ok">{t("settings.saved")}</p>}
        {state === "failed" && <p className="note is-pencil">{t("settings.saveFailed")}</p>}
      </aside>
    </article>
  );
}
