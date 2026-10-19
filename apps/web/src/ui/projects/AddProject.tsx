import type { ProjectView } from "@artel/shared";
import { useState } from "react";
import { ok } from "../../api";
import { useApp } from "../../context";

/** Adding a project folder: the native picker on the desktop, a path field in a plain browser. */
export function useAddProject() {
  const { api, reloadProjects, navigate } = useApp();
  const [typing, setTyping] = useState(false);
  const [path, setPath] = useState("");
  const [failed, setFailed] = useState(false);

  async function add(folder: string) {
    setFailed(false);
    const project = await api.projects
      .$post({ json: { path: folder } })
      .then((r) => ok<ProjectView>(r))
      .catch(() => null);
    if (!project) {
      setFailed(true);
      return;
    }
    setTyping(false);
    setPath("");
    await reloadProjects();
    navigate({ kind: "project", projectId: project.id });
  }

  async function pick() {
    if (!window.artel?.pickFolder) {
      setTyping(true);
      return;
    }
    const folder = await window.artel.pickFolder();
    if (folder) await add(folder);
  }

  return { pick, add, typing, path, setPath, failed };
}

/** The sidebar's "+ Project". */
export function AddProject() {
  const { t } = useApp();
  const { pick, add, typing, path, setPath, failed } = useAddProject();
  return (
    <>
      <button className="side-new" onClick={() => void pick()}>
        {t("side.addProject")}
      </button>
      {typing && (
        <form
          className="side-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim()) void add(path.trim());
          }}
        >
          <input
            className="field-input mono"
            aria-label={t("project.pathLabel")}
            placeholder={t("project.pathLabel")}
            value={path}
            onChange={(e) => setPath(e.target.value)}
            autoFocus
          />
          <button className="btn">{t("project.add")}</button>
        </form>
      )}
      {failed && <p className="error-note">{t("project.addFailed")}</p>}
    </>
  );
}
