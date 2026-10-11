import { useApp } from "../context";
import { AddProject } from "./projects/AddProject";
import { StatusDot } from "./tasks/StatusDot";

const FINISHED = new Set(["accepted", "discarded"]);

export function Sidebar() {
  const { t, status, view, navigate, openNewChat, chats, providers, projects, tasks } = useApp();
  const currentChat = view.kind === "chat" ? view.chatId : undefined;
  const currentProject = view.kind === "project" ? view.projectId : undefined;
  const currentTask = view.kind === "task" ? view.taskId : undefined;

  return (
    <aside className="side">
      <section className="side-group">
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
              return (
                <li key={project.id}>
                  <button
                    className={`side-item${project.id === currentProject ? " is-on" : ""}`}
                    onClick={() => navigate({ kind: "project", projectId: project.id })}
                  >
                    <span className="side-item-title">{project.name}</span>
                  </button>
                  {open.length > 0 && (
                    <ul className="side-sublist">
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

      <section className="side-group">
        <div className="side-row">
          <h2 className="side-h">{t("side.chats")}</h2>
          <button className="side-new" onClick={openNewChat}>
            + {t("side.newChat")}
          </button>
        </div>
        {chats.length === 0 ? (
          <p className="side-empty">{t("side.chatsEmpty")}</p>
        ) : (
          <ul className="side-list">
            {chats.map((chat) => (
              <li key={chat.id}>
                <button
                  className={`side-item${chat.id === currentChat ? " is-on" : ""}`}
                  onClick={() => navigate({ kind: "chat", chatId: chat.id, key: chat.id })}
                  aria-current={chat.id === currentChat ? "page" : undefined}
                >
                  <span className="side-item-title">{chat.title ?? t("chat.untitled")}</span>
                  {chat.model && <small className="mono">{chat.model}</small>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="side-h">{t("side.system")}</h2>
        <ul className="checks">
          <li>
            <i aria-hidden>✓</i>
            {t("side.core")}
          </li>
          <li>
            <i aria-hidden>✓</i>
            {t("side.database", { version: status.schemaVersion })}
          </li>
        </ul>
      </section>

      <nav className="side-nav">
        <button
          className={`side-link${view.kind === "providers" ? " is-on" : ""}`}
          onClick={() => navigate({ kind: "providers" })}
        >
          {t("side.keys")}
          <small>{providers.length}</small>
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
