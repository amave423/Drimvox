import type { DesignBrief, DesignReview, FontKind, Look } from "@artel/shared";
import { useApp } from "../../context";
import { useAuthorizedUrl } from "../../lib/media";

/** Fonts from the internet do not load in the window: a sample is drawn with the nearest font of the same kind. */
const fontClass = (kind: FontKind) => `font-${kind}`;

/** The colours of a direction as a strip. The colours are the agent's data, not the interface's own. */
function Swatches({ colors, labels }: { colors: string[]; labels?: string[] }) {
  return (
    <span className="swatches" role="img" aria-label={colors.join(", ")}>
      {colors.map((c, i) => (
        <span key={i} className="swatch" style={{ background: c }} title={labels?.[i] ? `${labels[i]} ${c}` : c} />
      ))}
    </span>
  );
}

/** One visual direction offered in the interview: its palette and its two fonts. */
export function LookSample({ look }: { look: Look }) {
  return (
    <span className="look-sample">
      <Swatches colors={look.palette} />
      <span className="look-fonts">
        <span className={fontClass(look.heading.kind)}>Аа {look.heading.name}</span>
        <span className={`muted ${fontClass(look.body.kind)}`}>{look.body.name}</span>
      </span>
    </span>
  );
}

/** The brief the coders follow, as the spec, the plan and the task show it. */
export function DesignBriefView({ brief }: { brief: DesignBrief }) {
  const { t } = useApp();
  return (
    <div className="design-brief">
      <h3 className="spec-sub">{t("design.title")}</h3>
      <p>
        <strong>{brief.direction}.</strong> {brief.concept}
      </p>
      <Swatches colors={brief.palette.map((c) => c.hex)} labels={brief.palette.map((c) => c.role)} />
      <ul className="design-palette">
        {brief.palette.map((c, i) => (
          <li key={i}>
            <span className="mono">{c.hex}</span> {c.role}
          </li>
        ))}
      </ul>
      <p className="look-fonts">
        <span className={fontClass(brief.fonts.heading.kind)}>{t("design.headings", { font: brief.fonts.heading.name })}</span>
        <span className={fontClass(brief.fonts.body.kind)}>{t("design.text", { font: brief.fonts.body.name })}</span>
      </p>
      {brief.rules.length > 0 && (
        <ul className="design-rules">
          {brief.rules.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The direction in the task's margin: its name and colours. */
export function DesignNote({ brief }: { brief: DesignBrief }) {
  const { t } = useApp();
  return (
    <p className="note design-note">
      {t("design.margin")}
      <br />
      <strong>{brief.direction}</strong>
      <Swatches colors={brief.palette.map((c) => c.hex)} labels={brief.palette.map((c) => c.role)} />
    </p>
  );
}

/** Artel's look at the finished screens: the verdict, the notes and the screenshots. */
export function DesignReviewView({ review, taskId }: { review: DesignReview; taskId: string }) {
  const { t } = useApp();
  return (
    <div className="design-review">
      <h3 className="spec-sub">{t("design.review")}</h3>
      {/* Notes of a polish round are already worked in by the time anyone reads them: no alarm colour. */}
      <p className="muted">
        {review.verdict === "good" ? t("design.good", { model: review.model }) : t("design.polished", { count: review.issues.length, model: review.model })}
      </p>
      {review.issues.length > 0 && (
        <ul className="design-rules">
          {review.issues.map((issue, i) => (
            <li key={i}>{issue}</li>
          ))}
        </ul>
      )}
      <div className="design-shots">
        {review.shots.map((id) => (
          <Shot key={id} taskId={taskId} id={id} />
        ))}
      </div>
    </div>
  );
}

function Shot({ taskId, id }: { taskId: string; id: string }) {
  const { t, token } = useApp();
  const src = useAuthorizedUrl(`/api/tasks/${taskId}/screenshots/${id}`, token);
  return src ? (
    <a href={src} target="_blank" rel="noreferrer">
      <img src={src} alt={t("design.shot")} />
    </a>
  ) : (
    <div className="media-wait" aria-busy />
  );
}
