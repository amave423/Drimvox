import type { ProjectView } from "@drimvox/shared";
import { useState } from "react";
import { useApp } from "../../context";

/**
 * A project whose folder is gone and was not found beside where it was (renamed or moved further): the user shows its new
 * place, and the project with its history and conversation goes on there (seen live: renamed folders asked for git again).
 */
export function MissingFolder({ project }: { project: ProjectView }) {
  const { api, t, reloadProjects } = useApp();
  const [path, setPath] = useState("");
  const [problem, setProblem] = useState<"not_found" | "taken" | null>(null);
  const [busy, setBusy] = useState(false);

  async function move(folder: string) {
    setBusy(true);
    setProblem(null);
    const res = await api.projects[":id"].move.$post({ param: { id: project.id }, json: { path: folder } }).catch(() => null);
    setBusy(false);
    if (res?.ok) return void (await reloadProjects());
    setProblem(res?.status === 409 ? "taken" : "not_found");
  }

  async function pick() {
    const folder = await window.drimvox?.pickFolder?.();
    if (folder) await move(folder);
  }

  return (
    <section className="notice workshop-pad">
      <h2 className="sheet-h">{t("project.missingTitle")}</h2>
      <p>{t("project.missingBody")}</p>
      <p className="mono muted">{project.path}</p>
      {problem && <p className="error-note">{t(problem === "taken" ? "project.missingTaken" : "project.missingFailed")}</p>}
      {window.drimvox?.pickFolder ? (
        <button className="btn is-primary" disabled={busy} onClick={() => void pick()}>
          {t("project.missingPick")}
        </button>
      ) : (
        <form
          className="actions"
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim()) void move(path.trim());
          }}
        >
          <input className="field-input" placeholder={t("folder.pathPlaceholder")} aria-label={t("project.missingPath")} value={path} onChange={(e) => setPath(e.target.value)} />
          <button className="btn is-primary" disabled={busy || !path.trim()}>
            {t("project.missingSave")}
          </button>
        </form>
      )}
    </section>
  );
}
