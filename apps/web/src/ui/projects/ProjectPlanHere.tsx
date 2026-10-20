import { useApp } from "../../context";
import { PlanCard } from "./PlanCard";
import { useProjectWork } from "./useProjectWork";

/** Right under the interview: the plan with "Go", or the way to the work once it started (docs/specs/project-work.md). */
export function ProjectPlanHere({ projectId }: { projectId: string }) {
  const { t, navigate } = useApp();
  const { work, reload } = useProjectWork(projectId);
  if (!work) return null;
  if (work.status === "ready" || work.status === "planning") return work.plan ? <PlanCard key={work.plan.context} work={work} onChanged={() => void reload()} /> : null;
  if (!work.chatId) return null;
  return (
    <div className="note is-ok">
      <p>{t("projectWork.started")}</p>
      <button className="btn is-primary" onClick={() => navigate({ kind: "chat", chatId: work.chatId!, key: work.chatId! })}>
        {t("projectWork.openChat")}
      </button>
    </div>
  );
}
