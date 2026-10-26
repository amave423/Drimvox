import type { ProjectWorkView } from "@drimvox/shared";
import { useEffect, useRef, useState } from "react";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";
import { formatUsd } from "../../lib/format";
import { LimitsForm } from "./LimitsForm";
import { hoursAndMinutes } from "./useProjectWork";
import { stageOf, type Stage } from "./Workshop";

/**
 * The open project's run in the top bar (variant A): its state with the checklist's progress, the time and the money
 * (a click opens the limits, changed without stopping), and Stop or Continue.
 */
export function WorkshopBar({ projectId }: { projectId: string }) {
  const { api, t, projects, works, reloadWorks } = useApp();
  const [limits, setLimits] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // The limits close on a click elsewhere, like a menu.
  useEffect(() => {
    if (!limits) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setLimits(false);
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [limits]);
  const project = projects.find((p) => p.id === projectId);
  const w = works.find((x) => x.projectId === projectId) ?? null;
  if (!project) return null;
  const done = w?.checklist.filter((i) => i.done).length ?? 0;
  const total = w?.checklist.length ?? 0;
  const pill = pillOf(stageOf(project, w), w);
  const text = t(pill.key, { detail: w?.detail ?? "" });

  async function act(kind: "stop" | "continue") {
    await (kind === "stop" ? api.projects[":id"].work.stop.$post({ param: { id: projectId } }) : api.projects[":id"].work.continue.$post({ param: { id: projectId } })).catch(() => null);
    reloadWorks();
  }

  return (
    <div className="workshop-bar-top">
      <span className={`workshop-pill is-${pill.tone}`} role="status" title={text}>
        <span className="workshop-pill-dot" aria-hidden />
        {text}
        {total > 0 && ` · ${t("projectWork.progress", { done, total })}`}
      </span>
      {w?.startedAt && (
        <div className="workshop-limits-box" ref={box}>
          <button type="button" className="link workshop-numbers" aria-expanded={limits} onClick={() => setLimits(!limits)} title={t("workshop.limits")}>
            {t("workshop.numbers", {
              time: hoursAndMinutes(w.workedMs, t),
              hours: t("projectWork.hoursShort", { h: w.hours }),
              spent: formatUsd(w.spentUsd),
              budget: formatUsd(w.budgetUsd),
            })}
          </button>
          {limits && (
            <div className="workshop-limits-pop">
              <LimitsForm
                work={w}
                onSaved={() => {
                  setLimits(false);
                  reloadWorks();
                }}
              />
            </div>
          )}
        </div>
      )}
      {w?.status === "running" && (
        <button className="btn is-pencil is-small" onClick={() => void act("stop")}>
          {t("projectWork.stop")}
        </button>
      )}
      {w?.startedAt && (w.status === "paused" || w.status === "stopped") && (
        <button className="btn is-primary is-small" onClick={() => void act("continue")}>
          {t("projectWork.continue")}
        </button>
      )}
    </div>
  );
}

function pillOf(stage: Stage, w: ProjectWorkView | null): { key: MessageKey; tone: "run" | "ok" | "wait" | "idle" } {
  if (stage === "git") return { key: "workshop.state.git", tone: "wait" };
  if (!w || stage === "start" || stage === "loading") return { key: "workshop.state.new", tone: "idle" };
  if (stage === "interview") return { key: "workshop.state.interview", tone: "run" };
  if (stage === "plan") return { key: w.status === "planning" ? "workshop.state.rewriting" : "workshop.state.plan", tone: w.status === "planning" ? "run" : "wait" };
  if (w.status === "running") return w.waitingApproval ? { key: "projectWork.waitingApproval", tone: "wait" } : { key: "projectWork.status.running", tone: "run" };
  if (w.status === "done") return { key: "workshop.state.done", tone: "ok" };
  return { key: `projectWork.reason.${w.reason ?? "user"}` as MessageKey, tone: "wait" };
}
