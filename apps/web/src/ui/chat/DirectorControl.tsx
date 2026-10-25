import { useState, type ReactNode } from "react";
import type { MessageKey } from "../../i18n";
import { Hint } from "../Hint";
import { Toggle } from "../Toggle";
import { Pills } from "./MediaOptions";
import { ModelPicker } from "./ModelPicker";

/** A director for pictures and clips: on or off, its model (one that sees pictures), how many attempts it may make. */
export interface Director {
  on: boolean;
  providerId: string | null;
  model: string | null;
  attempts: number;
}

const KEY = "drimvox.director";
const DEFAULT: Director = { on: false, providerId: null, model: null, attempts: 3 };

/** The director chosen last, kept in this window (docs/specs/media-director.md). */
export function useDirector(): [Director, (next: Director) => void] {
  const [value, setValue] = useState<Director>(() => {
    try {
      return { ...DEFAULT, ...(JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Director> | null) };
    } catch {
      return DEFAULT;
    }
  });
  const set = (next: Director) => {
    setValue(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Kept for this visit only.
    }
  };
  return [value, set];
}

/**
 * The director in a picture or video chat's options, as rows of their own with their labels on the left (seen: one row
 * holding the switch, the model and the attempts looked lopsided). Asked for: a text model that knows the picture model,
 * writes the prompt, looks at the result and redoes it, as many times as the user allows.
 */
export function directorRows(value: Director, video: boolean, onChange: (next: Director) => void, t: (key: MessageKey) => string): { label: string; control: ReactNode }[] {
  const rows: { label: string; control: ReactNode }[] = [
    {
      label: t("director.label"),
      control: (
        <span className="director-row">
          <Toggle checked={value.on} onChange={(on) => onChange({ ...value, on })}>
            {t("director.on")}
          </Toggle>
          <Hint text={t(video ? "director.hintVideo" : "director.hint")} />
        </span>
      ),
    },
  ];
  if (!value.on) return rows;
  rows.push({
    label: t("director.model"),
    control: (
      <ModelPicker
        value={value.providerId && value.model ? { providerId: value.providerId, model: value.model, kind: "text" } : null}
        vision
        placement="above"
        onChange={({ providerId, model }) => onChange({ ...value, providerId, model })}
      />
    ),
  });
  if (!video) {
    rows.push({
      label: t("director.attempts"),
      control: <Pills label={t("director.attempts")} options={[1, 2, 3, 4, 5]} current={value.attempts} show={String} onPick={(n) => onChange({ ...value, attempts: Number(n) })} />,
    });
  }
  return rows;
}
