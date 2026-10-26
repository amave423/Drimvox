import { noticeSounds, type SettingsPatch } from "@drimvox/shared";
import { useState } from "react";
import { useApp } from "../context";
import type { MessageKey } from "../i18n";
import { playSound } from "../lib/sounds";
import { Segmented } from "./Segmented";
import { Setting } from "./Setting";

/** The look and sound of a notification the settings send: as the real ones will be. */
export function noticeLookNow(settings: { locale: "ru" | "en"; notifySound: NoticeRequest["sound"]; notifyVolume: number }): Omit<NoticeRequest, "title" | "body"> {
  return { dark: document.documentElement.dataset.theme === "dark", mode: "projects", locale: settings.locale, sound: settings.notifySound, volume: settings.notifyVolume };
}

/** The notifications' sound (asked for: Drimvox's own), heard when chosen, and its loudness. */
export function NoticeSoundSetting({ save }: { save(patch: SettingsPatch): Promise<void> }) {
  const { t, settings } = useApp();
  // The slider moves freely; the loudness is saved when it is let go.
  const [volume, setVolume] = useState(settings.notifyVolume);
  return (
    <Setting id="notice-sound-label" title={t("settings.noticeSound")} about={t("settings.noticeSoundAbout")}>
      <Segmented
        value={settings.notifySound}
        labelledBy="notice-sound-label"
        options={noticeSounds.map((s) => ({ value: s, label: t(`settings.noticeSound.${s}` as MessageKey) }))}
        onChange={(notifySound) => {
          playSound(notifySound, volume);
          void save({ notifySound });
        }}
      />
      {settings.notifySound !== "off" && (
        <label className="notice-volume">
          <span>{t("settings.noticeVolume")}</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            aria-label={t("settings.noticeVolume")}
            onChange={(e) => setVolume(Number(e.target.value))}
            onPointerUp={() => {
              playSound(settings.notifySound, volume);
              void save({ notifyVolume: volume });
            }}
            onKeyUp={() => void save({ notifyVolume: volume })}
          />
          <button type="button" className="link" onClick={() => playSound(settings.notifySound, volume)}>
            {t("settings.noticeListen")}
          </button>
        </label>
      )}
    </Setting>
  );
}
