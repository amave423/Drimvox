import { isRoughEstimate, type MediaModel, type MediaOptions as Options } from "@artel/shared";
import type { ReactNode } from "react";
import { useApp } from "../../context";
import { formatUsd } from "../../lib/format";

interface Props {
  model: MediaModel | null;
  value: Options;
  onChange(value: Options): void;
}

/** A row of pills for one setting; the first is chosen when nothing is. */
function Pills({ label, options, current, show, onPick }: { label: string; options: (string | number)[]; current: string | number | undefined; show(o: string | number): string; onPick(o: string): void }) {
  const chosen = String(current ?? options[0]);
  return (
    <div className="pills" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o} type="button" role="radio" aria-checked={String(o) === chosen} className={String(o) === chosen ? "is-on" : undefined} onClick={() => onPick(String(o))}>
          {show(o)}
        </button>
      ))}
    </div>
  );
}

/**
 * What the picture or the clip should be like, as rows for the chat's options panel (seen: native selects under the
 * message box looked bare and stretched the bar).
 */
export function useMediaOptionRows({ model, value, onChange }: Props): { rows: { label: string; control: ReactNode }[]; changed: string[] } {
  const { t } = useApp();
  const seconds = (o: string | number) => (typeof o === "number" ? t("media.seconds", { n: o }) : String(o));
  const rows: { label: string; control: ReactNode }[] = [];
  const changed: string[] = [];
  if (!model) return { rows, changed };
  const add = (label: string, options: (string | number)[], current: string | number | undefined, show: (o: string | number) => string, onPick: (o: string) => void) => {
    if (options.length < 2) return;
    rows.push({ label, control: <Pills label={label} options={options} current={current} show={show} onPick={onPick} /> });
    changed.push(show(current ?? options[0]!));
  };
  add(t("media.aspect"), model.aspectRatios, value.aspectRatio, String, (aspectRatio) => onChange({ ...value, aspectRatio }));
  add(t("media.resolution"), model.resolutions, value.resolution, String, (resolution) => onChange({ ...value, resolution }));
  if (model.kind === "video") add(t("media.duration"), model.durations, value.duration, seconds, (d) => onChange({ ...value, duration: Number(d) }));
  if (model.kind === "video" && model.audio) {
    rows.push({
      label: t("media.audio"),
      control: (
        <Pills
          label={t("media.audio")}
          options={["off", "on"]}
          current={value.audio ? "on" : "off"}
          show={(o) => t(o === "on" ? "media.audioOn" : "media.audioOff")}
          onPick={(o) => onChange({ ...value, audio: o === "on" })}
        />
      ),
    });
    if (value.audio) changed.push(t("media.audioOn"));
  }
  return { rows, changed };
}

/** What it will likely cost, next to the button that starts it. */
export function MediaPrice({ model, estimateUsd }: { model: MediaModel; estimateUsd: number | null }) {
  const { t } = useApp();
  return (
    <span className="media-price mono">
      {estimateUsd === null ? t("media.priceUnknown") : t(isRoughEstimate(model) ? "media.estimateRough" : "media.estimate", { cost: formatUsd(estimateUsd) })}
    </span>
  );
}
