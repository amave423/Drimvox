import type { ProjectWorkView } from "@drimvox/shared";
import { useCallback, useEffect, useState } from "react";
import { ok } from "../../api";
import { useApp } from "../../context";

/** While the interview, the plan or the run goes on, its state is asked for this often. */
const POLL_MS = 1500;

/** A project's work (docs/specs/project-work.md), kept fresh while something is going on. */
export function useProjectWork(projectId: string | null) {
  const { api } = useApp();
  const [work, setWork] = useState<ProjectWorkView | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return null;
    const next = await api.projects[":id"].work
      .$get({ param: { id: projectId } })
      .then((r) => ok<ProjectWorkView>(r))
      .catch(() => null);
    if (next) setWork(next);
    return next;
  }, [api, projectId]);

  useEffect(() => {
    setWork(null);
    void load();
  }, [load]);

  const live = work?.status === "running" || work?.status === "planning";
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [live, load]);

  return { work, reload: load };
}

/** "1 h 5 min", "12 min". */
export function hoursAndMinutes(ms: number, t: (key: "projectWork.duration" | "projectWork.minutes", vars: Record<string, number>) => string): string {
  const minutes = Math.floor(ms / 60_000);
  const h = Math.floor(minutes / 60);
  return h > 0 ? t("projectWork.duration", { h, m: minutes % 60 }) : t("projectWork.minutes", { m: minutes });
}
