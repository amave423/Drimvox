import type { ProjectWorkView } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { useApp } from "../context";
import type { MessageKey } from "../i18n";
import { showStart } from "./SideChats";
import { RemoveProject } from "./projects/RemoveProject";
import { AddProject } from "./projects/AddProject";

/**
 * The projects' mode's sidebar: every project with how its work goes.
 */
export function SideProjects() {
  const { api, t, view, navigate, projects, chats, works, reloadProjects } = useApp();
  // A project is called by its folder until the user names it (asked for: renaming like chats).
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  // The "⋯" of a project: renaming, leaving Drimvox (asked for: removing a project was hard to find).
  const [menu, setMenu] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (!(e.target as Element).closest?.(".side-menu, .side-menu-button")) setMenu(null);
    };
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [menu]);
  async function rename(id: string) {
    const next = name.trim();
    setRenaming(null);
    if (!next || next === projects.find((p) => p.id === id)?.name) return;
    await api.projects[":id"].$patch({ param: { id }, json: { name: next } }).catch(() => null);
    await reloadProjects();
  }
  const currentChat = view.kind === "chat" ? view.chatId : undefined;
  const currentProject = view.kind === "project" ? view.projectId : undefined;

  return (
    <section className="side-group side-projects">
      <div className="side-row">
        <h2 className="side-h">{t("side.projects")}</h2>
        <AddProject />
      </div>
      {projects.length === 0 ? (
        <p className="side-empty">{t("side.projectsEmpty")}</p>
      ) : (
        <ul className="side-list">
          {projects.map((project) => {
            const work = works.find((w) => w.projectId === project.id) ?? null;
            const here = project.id === currentProject;
            return (
              <li key={project.id}>
                {renaming === project.id ? (
                  <form
                    className="side-rename"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void rename(project.id);
                    }}
                  >
                    <input
                      className="field-input"
                      aria-label={t("side.renameProjectLabel")}
                      value={name}
                      autoFocus
                      onChange={(e) => setName(e.target.value)}
                      onFocus={showStart}
                      onBlur={() => void rename(project.id)}
                      onKeyDown={(e) => e.key === "Escape" && setRenaming(null)}
                    />
                  </form>
                ) : (
                  <div className="side-project-row">
                    <button
                      className={`side-item side-project${here ? " is-on" : ""}`}
                      onClick={() => navigate({ kind: "project", projectId: project.id })}
                      aria-current={here ? "page" : undefined}
                    >
                      <span className="side-item-title">{project.name}</span>
                      <WorkLine work={work} unread={!here && !!chats.find((c) => c.id === work?.chatId)?.unread} />
                    </button>
                    <span className={`side-chat-actions${menu === project.id ? " is-open" : ""}`}>
                      <button
                        className="icon-button side-menu-button"
                        aria-label={t("side.projectMenu", { name: project.name })}
                        aria-haspopup="menu"
                        aria-expanded={menu === project.id}
                        onClick={() => setMenu(menu === project.id ? null : project.id)}
                      >
                        <span aria-hidden>⋯</span>
                      </button>
                    </span>
                    {menu === project.id && (
                      <div className="side-menu" role="menu" aria-label={t("side.projectMenu", { name: project.name })}>
                        <button
                          role="menuitem"
                          onClick={() => {
                            setMenu(null);
                            setName(project.name);
                            setRenaming(project.id);
                          }}
                        >
                          {t("side.renameProjectLabel")}
                        </button>
                        <button
                          role="menuitem"
                          className="is-pencil"
                          onClick={() => {
                            setMenu(null);
                            setRemoving(project.id);
                          }}
                        >
                          {t("project.removeAsk")}
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {removing === project.id && <RemoveProject project={project} asked onDone={() => setRemoving(null)} />}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * How a project's work goes, under its name: working or waiting. An answer not read yet is a dot, as a chat's (asked
 * for: a project answers as a chat does, it is not "done").
 */
function WorkLine({ work, unread }: { work: ProjectWorkView | null; unread: boolean }) {
  const { t } = useApp();
  if (!work || work.status === "idle") return null;
  if (work.status === "done") return unread ? <span className="side-chat-dot side-chat-state" role="img" aria-label={t("side.unread")} /> : null;
  // Waiting on the user's answer or permission counts as waiting, not as running.
  const tone = work.status === "running" ? (work.waitingApproval ? "wait" : "run") : "wait";
  return (
    <>
      {/* The project's state, the only place it is shown (asked for); why it waits, on hover. */}
      <small
        className={`side-work is-${tone}`}
        role="status"
        title={
          tone === "wait"
            ? t(work.waitingApproval ? "projectWork.waitingApproval" : (`projectWork.reason.${work.reason ?? "user"}` as MessageKey), {
                detail: work.detail ?? "",
              })
            : undefined
        }
      >
        {t(`workshop.dot.${tone}` as MessageKey)}
      </small>
    </>
  );
}
