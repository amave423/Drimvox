import type { ProjectWorkView } from "@drimvox/shared";
import { useState } from "react";
import { useApp } from "../context";
import type { MessageKey } from "../i18n";
import { PencilIcon, showStart } from "./SideChats";
import { AddProject } from "./projects/AddProject";
import { StatusDot } from "./tasks/StatusDot";

const FINISHED = new Set(["accepted", "discarded"]);

/**
 * The projects' mode's sidebar: every project with how its work goes, the open project's checklist under it, and its
 * separate tasks and their conversations.
 */
export function SideProjects() {
  const { api, t, view, navigate, projects, tasks, chats, works, reloadProjects } = useApp();
  // A project is called by its folder until the user names it (asked for: renaming like chats).
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  async function rename(id: string) {
    const next = name.trim();
    setRenaming(null);
    if (!next || next === projects.find((p) => p.id === id)?.name) return;
    await api.projects[":id"].$patch({ param: { id }, json: { name: next } }).catch(() => null);
    await reloadProjects();
  }
  const currentChat = view.kind === "chat" ? view.chatId : undefined;
  const currentProject = view.kind === "project" ? view.projectId : undefined;
  const currentTask = view.kind === "task" ? view.taskId : undefined;

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
            const open = tasks.filter((task) => task.projectId === project.id && !FINISHED.has(task.status) && task.id !== work?.planTaskId).slice(0, 6);
            // A separate task's conversations; the project's own work is its workshop.
            const talks = chats.filter((c) => c.projectId === project.id && c.itemId).slice(0, 6);
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
                    <button className={`side-item${here ? " is-on" : ""}`} onClick={() => navigate({ kind: "project", projectId: project.id })} aria-current={here ? "page" : undefined}>
                      <WorkDot work={work} />
                      <span className="side-item-title">{project.name}</span>
                      {work && work.checklist.length > 0 && (
                        <span className="side-progress mono">
                          {work.checklist.filter((i) => i.done).length}/{work.checklist.length}
                        </span>
                      )}
                    </button>
                    <span className="side-chat-actions">
                      <button
                        className="icon-button"
                        aria-label={t("side.renameProject", { name: project.name })}
                        title={t("side.renameProjectLabel")}
                        onClick={() => {
                          setName(project.name);
                          setRenaming(project.id);
                        }}
                      >
                        <PencilIcon />
                      </button>
                    </span>
                  </div>
                )}
                {here && work && work.checklist.length > 0 && (
                  <ul className="checklist side-checklist" aria-label={t("projectWork.checklist")}>
                    {work.checklist.map((item, n) => (
                      <li key={n} className={item.done ? "is-done" : undefined}>
                        <span className="check-mark" aria-hidden>
                          {item.done ? "✓" : ""}
                        </span>
                        <span className="visually-hidden">{item.done ? t("projectWork.itemDone") : t("projectWork.itemOpen")}</span>
                        {item.text}
                      </li>
                    ))}
                  </ul>
                )}
                {(open.length > 0 || talks.length > 0) && (
                  <ul className="side-sublist">
                    {talks.map((chat) => (
                      <li key={chat.id}>
                        <button
                          className={`side-item side-task${chat.id === currentChat ? " is-on" : ""}`}
                          onClick={() => navigate({ kind: "chat", chatId: chat.id, key: chat.id })}
                          aria-current={chat.id === currentChat ? "page" : undefined}
                        >
                          <span className="side-item-title">{chat.title ?? t("chat.untitled")}</span>
                        </button>
                      </li>
                    ))}
                    {open.map((task) => (
                      <li key={task.id}>
                        <button
                          className={`side-item side-task${task.id === currentTask ? " is-on" : ""}`}
                          onClick={() => navigate({ kind: "task", taskId: task.id })}
                          aria-current={task.id === currentTask ? "page" : undefined}
                        >
                          <StatusDot status={task.status} />
                          <span className="side-item-title">{task.title}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** How a project's work goes, as a dot before its name: working, waiting for the user, done. */
function WorkDot({ work }: { work: ProjectWorkView | null }) {
  const { t } = useApp();
  if (!work || work.status === "idle") return null;
  const tone = work.status === "running" || work.status === "planning" ? (work.waitingApproval ? "wait" : "run") : work.status === "done" ? "ok" : "wait";
  return <span className={`work-dot is-${tone}`} title={t(`workshop.dot.${tone}` as MessageKey)} aria-hidden />;
}
