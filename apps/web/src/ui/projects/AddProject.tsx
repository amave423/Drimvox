import type { ProjectKind, ProjectView } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { ok } from "../../api";
import { useApp } from "../../context";

/**
 * Adding a project folder: the native picker on the desktop, a path field in a plain browser; then whether the project
 * is ready or made from scratch (asked for: the work fits itself to that).
 */
export function useAddProject() {
  const { api, reloadProjects, navigate } = useApp();
  const [typing, setTyping] = useState(false);
  const [path, setPath] = useState("");
  const [failed, setFailed] = useState(false);
  /** The folder picked, waiting for its kind. */
  const [asking, setAsking] = useState<string | null>(null);

  async function add(folder: string, kind: ProjectKind) {
    setFailed(false);
    setAsking(null);
    const project = await api.projects
      .$post({ json: { path: folder, kind } })
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
    if (!window.drimvox?.pickFolder) {
      setTyping(true);
      return;
    }
    const folder = await window.drimvox.pickFolder();
    if (folder) setAsking(folder);
  }

  const dialog = asking ? <KindDialog folder={asking} onPick={(kind) => void add(asking, kind)} onCancel={() => setAsking(null)} /> : null;
  return { pick, ask: setAsking, typing, path, setPath, failed, dialog };
}

/** Ready or from scratch, with Drimvox's guess from what is in the folder already chosen. */
function KindDialog({ folder, onPick, onCancel }: { folder: string; onPick(kind: ProjectKind): void; onCancel(): void }) {
  const { api, t } = useApp();
  const [kind, setKind] = useState<ProjectKind | null>(null);
  const [guess, setGuess] = useState<ProjectKind | null>(null);
  useEffect(() => {
    let live = true;
    void api.projects.peek
      .$post({ json: { path: folder } })
      .then((r) => ok<{ guess: ProjectKind }>(r))
      .then((r) => {
        if (!live) return;
        setGuess(r.guess);
        setKind((k) => k ?? r.guess);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [folder]);
  useEffect(() => {
    const close = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onCancel]);
  return (
    <div className="kind-backdrop" onClick={onCancel}>
      <div className="kind-dialog" role="dialog" aria-modal="true" aria-labelledby="kind-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="kind-title" className="sheet-h">
          {t("project.kindTitle")}
        </h2>
        <p className="mono muted kind-path">{folder}</p>
        <div className="kind-options" role="radiogroup" aria-label={t("project.kindTitle")}>
          {(["new", "existing"] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} className={`kind-option${kind === k ? " is-on" : ""}`} onClick={() => setKind(k)}>
              <strong>{t(`project.kind.${k}`)}</strong>
              <span className="muted">{t(`project.kind.${k}Text`)}</span>
            </button>
          ))}
        </div>
        {guess && <p className="kind-guess">{t(guess === "existing" ? "project.kindGuessExisting" : "project.kindGuessNew")}</p>}
        <div className="actions">
          <button type="button" className="btn" onClick={onCancel}>
            {t("providers.cancel")}
          </button>
          <button type="button" className="btn is-primary" disabled={!kind} onClick={() => kind && onPick(kind)}>
            {t("project.kindContinue")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The sidebar's "+ Project". */
export function AddProject() {
  const { t } = useApp();
  const { pick, ask, typing, path, setPath, failed, dialog } = useAddProject();
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
            if (path.trim()) ask(path.trim());
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
      {dialog}
    </>
  );
}
