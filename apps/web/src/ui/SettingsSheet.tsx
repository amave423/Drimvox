import { currencies, locales, searchEngines, themes, type SettingsPatch } from "@drimvox/shared";
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
import { Setting } from "./Setting";
import { NoticeSoundSetting, noticeLookNow } from "./NoticeSoundSetting";
import { SpeechVoiceSetting } from "./SpeechVoiceSetting";
import { SearchSection } from "./SearchSection";
import { SpendingSection } from "./SpendingSection";
import { ModelPicker } from "./chat/ModelPicker";
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
  const { t, settings, updateSettings, usdRub, status } = useApp();
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
        <h2 className="sheet-h">{t("settings.group.look")}</h2>
        <Setting id="theme-label" title={t("settings.theme")}>
          <Segmented
            labelledBy="theme-label"
            value={settings.theme}
            options={themes.map((v) => ({ value: v, label: t(`settings.theme.${v}`) }))}
            onChange={(theme) => save({ theme })}
          />
        </Setting>
        <Setting id="locale-label" title={t("settings.locale")}>
          <Segmented
            labelledBy="locale-label"
            value={settings.locale}
            options={locales.map((v) => ({ value: v, label: localeNames[v] }))}
            onChange={(locale) => save({ locale })}
          />
        </Setting>

        <h2 className="sheet-h">{t("settings.group.work")}</h2>
        <Setting id="notifications-label" title={t("settings.notifications")} about={t(window.drimvox ? "settings.notificationsAbout" : "settings.notificationsAboutBrowser")}>
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
            <button type="button" className="link" onClick={() => window.drimvox?.testNotify({ ...noticeLookNow(settings), title: t("notice.test"), body: t("notice.testBody") })}>
              {t("settings.notificationsTest")}
            </button>
          )}
        </Setting>
        <NoticeSoundSetting save={save} />
        <Setting id="developer-label" title={t("settings.developerTitle")} about={t("settings.developerHint")}>
          <Toggle checked={settings.developer} onChange={(developer) => void save({ developer })}>
            {t("settings.developer")}
          </Toggle>
        </Setting>

        <UpdatesSection />
        {!window.drimvox && <AccountSection />}
      </>
    ),
    models: (
      <>
        <h2 className="sheet-h">{t("settings.group.money")}</h2>
        <Setting id="currency-label" title={t("settings.currency")}>
          <Segmented
            labelledBy="currency-label"
            value={settings.currency}
            options={currencies.map((v) => ({ value: v, label: t(`settings.currency.${v}`) }))}
            onChange={(currency) => save({ currency })}
          />
        </Setting>
        <Setting id="agent-budget-label" title={t("settings.agentBudgetLabel")} about={t("settings.agentBudgetHint")}>
          <AmountField
            label={t(perUsd === 1 ? "settings.agentBudget" : "settings.agentBudgetRub")}
            sign={shownSign()}
            value={budget}
            onChange={setBudget}
            onSave={() => {
              const value = Number(budget.replace(",", ".")) / perUsd;
              if (value >= 0.01) void save({ agentBudgetUsd: Number(value.toFixed(4)) });
              else setBudget(shown(settings.agentBudgetUsd));
            }}
          />
        </Setting>
        <Setting id="monthly-budget-label" title={t("settings.monthlyBudgetLabel")} about={t("settings.monthlyBudgetHint")}>
          <AmountField
            label={t("settings.monthlyBudget", { currency: shownSign() })}
            sign={shownSign()}
            placeholder={t("settings.monthlyBudgetNone")}
            value={monthly}
            onChange={setMonthly}
            onSave={() => {
              const value = Number(monthly.replace(",", ".")) / perUsd;
              void save({ monthlyBudgetUsd: monthly.trim() && value > 0 ? Number(value.toFixed(4)) : null });
            }}
          />
        </Setting>

        <h2 className="sheet-h">{t("voice.title")}</h2>
        <Setting id="voice-label" title={t("voice.modelTitle")} about={t("voice.modelHint")}>
          <div className="actions">
            <ModelPicker audio value={settings.voiceModel} onChange={({ providerId, model }) => void save({ voiceModel: { providerId, model } })} />
            {settings.voiceModel && (
              <button className="link" onClick={() => void save({ voiceModel: null })}>
                {t("settings.clear")}
              </button>
            )}
          </div>
        </Setting>

        <SpeechVoiceSetting />

        <SpendingSection />

        <ProjectModels save={(patch) => void save(patch)} />
      </>
    ),
    internet: (
      <>
        <Setting id="engine-label" title={t("settings.searchEngine")} about={t("settings.searchEngineAbout")}>
          <Segmented
            labelledBy="engine-label"
            value={settings.searchEngine}
            options={searchEngines.map((v) => ({ value: v, label: t(`settings.searchEngine.${v}`) }))}
            onChange={(searchEngine) => save({ searchEngine })}
          />
        </Setting>
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
      {/* The margin says what was saved, and what stays true of the section (seen: the right half of the sheet stood empty). */}
      <aside className="margin">
        <div aria-live="polite">
          {state === "saved" && <p className="note is-ok">{t("settings.saved")}</p>}
          {state === "failed" && <p className="note is-pencil">{t("settings.saveFailed")}</p>}
        </div>
        {part === "general" && (
          <>
            <p className="note">{t("home.noteCore", { version: status.version, node: status.node })}</p>
            <p className="note">
              {t("home.noteData")}
              <br />
              <span className="mono">{status.dataDir}</span>
            </p>
          </>
        )}
        {part === "models" && usdRub > 0 && settings.currency === "RUB" && <p className="note">{t("settings.currencyHint", { rate: usdRub.toFixed(2).replace(".", ",") })}</p>}
        {part === "mcp" && <p className="note">{t("settings.marginMcp")}</p>}
        {part === "skills" && <p className="note">{t("settings.marginSkills")}</p>}
      </aside>
    </article>
  );
}

/** An amount of money: a narrow field with its currency inside, saved by Enter or on leaving it. */
function AmountField(p: { label: string; sign: string; value: string; placeholder?: string; onChange(v: string): void; onSave(): void }) {
  return (
    <form
      className="amount-field"
      onSubmit={(e) => {
        e.preventDefault();
        p.onSave();
      }}
    >
      <input
        className="field-input mono"
        inputMode="decimal"
        aria-label={p.label}
        placeholder={p.placeholder}
        value={p.value}
        onChange={(e) => p.onChange(e.target.value)}
        onBlur={p.onSave}
      />
      <span aria-hidden>{p.sign}</span>
    </form>
  );
}
