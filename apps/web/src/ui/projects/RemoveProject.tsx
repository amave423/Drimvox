import type { ProjectView } from "@drimvox/shared";
import { useState } from "react";
import { useApp } from "../../context";

/** Leaving Drimvox from the sidebar's "⋯", confirmed under the project (asked for: in one place only); the folder stays. */
export function RemoveProject({ project, onDone, asked = false }: { project: ProjectView; onDone?: () => void; asked?: boolean }) {
  const { api, t, navigate, reloadProjects, reloadTasks } = useApp();
  const [confirm, setConfirm] = useState(asked);
  const [busy, setBusy] = useState(false);
  async function remove() {
    setBusy(true);
    await api.projects[":id"].$delete({ param: { id: project.id } }).catch(() => null);
    await Promise.all([reloadProjects(), reloadTasks()]);
    setBusy(false);
    onDone?.();
    navigate({ kind: "projects" });
  }
  return (
    <section className="danger-zone" aria-label={t("project.remove")}>
      <p className="muted">{t("project.removeHint")}</p>
      {confirm ? (
        <div className="actions">
          <span>{t("project.removeConfirm", { name: project.name })}</span>
          <button className="btn is-pencil" disabled={busy} onClick={() => void remove()}>
            {t("project.remove")}
          </button>
          <button
            className="btn"
            onClick={() => {
              setConfirm(false);
              if (asked) onDone?.();
            }}
          >
            {t("providers.cancel")}
          </button>
        </div>
      ) : (
        <button className="btn is-pencil" onClick={() => setConfirm(true)}>
          {t("project.removeAsk")}
        </button>
      )}
    </section>
  );
}
