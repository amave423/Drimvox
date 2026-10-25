import { useState } from "react";
import { useApp } from "../../context";
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
 * The director in a picture or video chat's options (asked for: a text model that knows the picture model, writes the
 * prompt, looks at the result and redoes it, as many times as the user allows).
 */
export function DirectorControl({ value, video, onChange }: { value: Director; video: boolean; onChange(next: Director): void }) {
  const { t } = useApp();
  return (
    <div className="director">
      <span className="director-row">
        <Toggle checked={value.on} onChange={(on) => onChange({ ...value, on })}>
          {t("director.on")}
        </Toggle>
        <Hint text={t(video ? "director.hintVideo" : "director.hint")} />
      </span>
      {value.on && (
        <>
          <ModelPicker
            value={value.providerId && value.model ? { providerId: value.providerId, model: value.model, kind: "text" } : null}
            vision
            placement="above"
            onChange={({ providerId, model }) => onChange({ ...value, providerId, model })}
          />
          {!video && (
            <span className="director-row">
              <span className="muted">{t("director.attempts")}</span>
              <Pills label={t("director.attempts")} options={[1, 2, 3, 4, 5]} current={value.attempts} show={String} onPick={(n) => onChange({ ...value, attempts: Number(n) })} />
            </span>
          )}
        </>
      )}
    </div>
  );
}
