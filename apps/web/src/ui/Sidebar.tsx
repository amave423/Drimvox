import { useApp } from "../context";
import { AddProject } from "./projects/AddProject";
import { SideChats } from "./SideChats";
import { StatusDot } from "./tasks/StatusDot";

const FINISHED = new Set(["accepted", "discarded"]);

export function Sidebar() {
  const { t, view, navigate, providers, projects, tasks, chats } = useApp();
  const currentChat = view.kind === "chat" ? view.chatId : undefined;
  const currentProject = view.kind === "project" ? view.projectId : undefined;
  const currentTask = view.kind === "task" ? view.taskId : undefined;

  return (
    <aside className="side">
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
              const open = tasks.filter((task) => task.projectId === project.id && !FINISHED.has(task.status)).slice(0, 6);
              // The project's task conversations, the newest first.
              const work = chats.filter((c) => c.projectId === project.id).slice(0, 6);
              return (
                <li key={project.id}>
                  <button
                    className={`side-item${project.id === currentProject ? " is-on" : ""}`}
                    onClick={() => navigate({ kind: "project", projectId: project.id })}
                  >
                    <span className="side-item-title">{project.name}</span>
                  </button>
                  {(open.length > 0 || work.length > 0) && (
                    <ul className="side-sublist">
                      {work.map((chat) => (
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

      <SideChats />

      <nav className="side-nav">
        <button className={`side-link${view.kind === "gallery" ? " is-on" : ""}`} onClick={() => navigate({ kind: "gallery" })}>
          {t("side.gallery")}
        </button>
        <button
          className={`side-link${view.kind === "providers" ? " is-on" : ""}`}
          onClick={() => navigate({ kind: "providers" })}
        >
          {t("side.keys")}
          <small>{providers.length}</small>
        </button>
        <button className={`side-link${view.kind === "local" ? " is-on" : ""}`} onClick={() => navigate({ kind: "local" })}>
          {t("side.local")}
        </button>
        <button
          className={`side-link${view.kind === "settings" ? " is-on" : ""}`}
          onClick={() => navigate({ kind: "settings" })}
        >
          {t("top.settings")}
        </button>
      </nav>
    </aside>
  );
}
