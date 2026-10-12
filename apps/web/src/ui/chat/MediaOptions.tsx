import { isRoughEstimate, type MediaModel, type MediaOptions as Options } from "@artel/shared";
import { useApp } from "../../context";
import { formatUsd } from "../../lib/format";

interface Props {
  model: MediaModel;
  value: Options;
  onChange(value: Options): void;
  estimateUsd: number | null;
}

/** What the picture or the clip should be like, and what it will likely cost. */
export function MediaOptions({ model, value, onChange, estimateUsd }: Props) {
  const { t } = useApp();
  const select = (label: string, options: (string | number)[], current: string | number | undefined, set: (v: string) => void) =>
    options.length > 1 && (
      <label className="media-option">
        <span>{label}</span>
        <select className="field-input" value={String(current ?? options[0])} onChange={(e) => set(e.target.value)}>
          {options.map((o) => (
            <option key={o} value={String(o)}>
              {model.kind === "video" && typeof o === "number" ? t("media.seconds", { n: o }) : o}
            </option>
          ))}
        </select>
      </label>
    );

  return (
    <div className="media-options">
      {select(t("media.aspect"), model.aspectRatios, value.aspectRatio, (aspectRatio) => onChange({ ...value, aspectRatio }))}
      {select(t("media.resolution"), model.resolutions, value.resolution, (resolution) => onChange({ ...value, resolution }))}
      {model.kind === "video" && select(t("media.duration"), model.durations, value.duration, (d) => onChange({ ...value, duration: Number(d) }))}
      {model.kind === "video" && model.audio && (
        <label className="stage-switch">
          <input type="checkbox" checked={value.audio ?? false} onChange={(e) => onChange({ ...value, audio: e.target.checked })} />
          {t("media.audio")}
        </label>
      )}
      <span className="media-price mono">
        {estimateUsd === null
          ? t("media.priceUnknown")
          : t(isRoughEstimate(model) ? "media.estimateRough" : "media.estimate", { cost: formatUsd(estimateUsd) })}
      </span>
    </div>
  );
}
