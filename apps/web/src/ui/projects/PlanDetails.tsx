import type { ProjectPlan } from "@drimvox/shared";
import { useApp } from "../../context";

/**
 * The plan as the user reads it (docs/specs/project-work.md): what we build, the steps, each page with what is on it,
 * the technical decisions with their reasons and the look (seen live: a plan of a few lines said too little).
 */
export function PlanDetails({ plan }: { plan: ProjectPlan }) {
  const { t } = useApp();
  return (
    <div className="plan-details">
      <p className="plan-summary">{plan.context}</p>
      {plan.steps && plan.steps.length > 0 && (
        <section>
          <h3 className="plan-h">{t("projectWork.plan.steps")}</h3>
          <ol className="plan-steps">
            {plan.steps.map((step, n) => (
              <li key={n}>{step}</li>
            ))}
          </ol>
        </section>
      )}
      {plan.screens && plan.screens.length > 0 && (
        <section>
          <h3 className="plan-h">{t("projectWork.plan.screens")}</h3>
          <dl className="plan-pairs">
            {plan.screens.map((s, n) => (
              <div key={n}>
                <dt>{s.name}</dt>
                <dd>{s.contents}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {plan.decisions && plan.decisions.length > 0 && (
        <section>
          <h3 className="plan-h">{t("projectWork.plan.decisions")}</h3>
          <dl className="plan-pairs">
            {plan.decisions.map((d, n) => (
              <div key={n}>
                <dt>{d.what}</dt>
                <dd>{d.why}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {plan.design && (
        <section>
          <h3 className="plan-h">{t("projectWork.plan.design")}</h3>
          <p>
            <strong>{plan.design.direction}.</strong> {plan.design.concept}
          </p>
          <p className="plan-palette">
            {plan.design.palette.map((c) => (
              <span key={c.role + c.hex} className="plan-swatch" title={`${c.role} ${c.hex}`}>
                <span className="plan-swatch-color" style={{ background: c.hex }} aria-hidden />
                {c.role}
              </span>
            ))}
          </p>
          <p className="muted">{t("projectWork.plan.fonts", { heading: plan.design.fonts.heading.name, body: plan.design.fonts.body.name })}</p>
          {plan.design.rules.length > 0 && (
            <ul className="plan-rules">
              {plan.design.rules.map((r, n) => (
                <li key={n}>{r}</li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
