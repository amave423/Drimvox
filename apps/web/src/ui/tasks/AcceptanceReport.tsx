import type { AcceptanceReport as Report, Milestone, Requirement } from "@artel/shared";
import { useApp } from "../../context";

/** The acceptance agent's checklist: every requirement with its mark, what is wrong, and the evidence on request. */
export function AcceptanceReport({ report, requirements }: { report: Report; requirements: Requirement[] }) {
  const { t } = useApp();
  const done = report.results.filter((r) => r.status === "done").length;
  return (
    <section className="acceptance">
      <h3 className="spec-sub">{t("acceptance.title")}</h3>
      <p className="muted acceptance-meta">
        {t("acceptance.meta", { done, total: report.results.length, round: report.round })} · <span className="mono">{report.model}</span>
      </p>
      <p>{report.summary}</p>
      <ul className="acceptance-list">
        {report.results.map((r) => (
          <li key={r.id} className={`acceptance-item is-${r.status}`}>
            <span className="acceptance-mark">{t(`acceptance.status.${r.status}`)}</span>
            <div className="acceptance-body">
              <p>
                <span className="mono">{r.id}</span> {requirements.find((q) => q.id === r.id)?.text ?? ""}
              </p>
              {r.problem && r.status !== "done" && <p className="acceptance-problem">{r.problem}</p>}
              {r.evidence && (
                <details className="action">
                  <summary>
                    <span className="action-label">{t("acceptance.evidence")}</span>
                  </summary>
                  <pre className="action-output mono">{r.evidence}</pre>
                </details>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The spec's stages, requirements and the agent's own decisions, before the work starts. */
export function RequirementsList({
  requirements,
  decisions,
  milestones = [],
}: {
  requirements: Requirement[];
  decisions: string[];
  milestones?: Milestone[];
}) {
  const { t } = useApp();
  if (requirements.length === 0 && decisions.length === 0 && milestones.length === 0) return null;
  const staged = milestones.length > 1;
  return (
    <>
      {staged && (
        <>
          <h3 className="spec-sub">{t("spec.milestones")}</h3>
          <p className="muted spec-hint">{t("spec.milestonesHint")}</p>
          <ol className="steps">
            {milestones.map((m, i) => (
              <li key={i}>{m.title}</li>
            ))}
          </ol>
        </>
      )}
      {requirements.length > 0 && (
        <>
          <h3 className="spec-sub">{t("spec.requirements")}</h3>
          <p className="muted spec-hint">{t("spec.requirementsHint")}</p>
          <ol className="requirements">
            {requirements.map((r) => (
              <li key={r.id}>
                <span className="mono requirement-id">{r.id}</span>
                <span>{r.text}</span>
                <span className="muted requirement-how">
                  {staged ? `${t("spec.stageOf", { stage: r.stage ?? 1 })} · ` : ""}
                  {t(`spec.verify.${r.verify}`)}
                  {r.how ? `: ${r.how}` : ""}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
      {decisions.length > 0 && (
        <>
          <h3 className="spec-sub">{t("spec.decisions")}</h3>
          <ul className="decisions">
            {decisions.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
