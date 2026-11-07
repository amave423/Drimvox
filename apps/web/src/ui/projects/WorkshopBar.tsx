import { useApp } from "../../context";

/** The open project's run in the top bar: Stop or Continue. */
export function WorkshopBar({ projectId }: { projectId: string }) {
  const { api, t, projects, works, reloadWorks } = useApp();
  const project = projects.find((p) => p.id === projectId);
  const w = works.find((x) => x.projectId === projectId) ?? null;
  if (!project) return null;

  async function act(kind: "stop" | "continue") {
    await (
      kind === "stop"
        ? api.projects[":id"].work.stop.$post({ param: { id: projectId } })
        : api.projects[":id"].work.continue.$post({ param: { id: projectId } })
    ).catch(() => null);
    reloadWorks();
  }

  // The state is on the project in the sidebar and the time and money in the context window (asked for: not twice).
  return (
    <div className="workshop-bar-top">
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
