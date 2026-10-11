import { presets, type PresetId } from "@artel/shared";
import type { AppContextValue } from "../../context";

/** Brand names stay as they are; only the generic preset is translated. */
export function presetName(t: AppContextValue["t"], preset: PresetId): string {
  return preset === "custom" ? t("providers.preset.custom") : presets[preset].name;
}
