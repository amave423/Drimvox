import { useState } from "react";
import { useApp } from "../context";
import { BookIcon, ComputerIcon, GalleryIcon, GearIcon, KeyIcon, MenuIcon } from "./NavIcons";
import { PencilIcon, showStart } from "./SideChats";
import { AddProject } from "./projects/AddProject";
import { SideChats } from "./SideChats";
import { StatusDot } from "./tasks/StatusDot";

const FINISHED = new Set(["accepted", "discarded"]);
const SECTIONS_KEY = "drimvox.sidebarSections";

export function Sidebar() {
  const { api, t, view, navigate, projects, tasks, chats, reloadProjects } = useApp();
  // The sections at the bottom fold under one button (asked for), remembered in this window.
  const [sectionsOpen, setSectionsOpen] = useState(() => {
    try {
      return localStorage.getItem(SECTIONS_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  const toggleSections = () => {
    const next = !sectionsOpen;
    setSectionsOpen(next);
    try {
      localStorage.setItem(SECTIONS_KEY, next ? "open" : "closed");
    } catch {
      // Kept for this visit only.
    }
  };
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
                        className={`side-item${project.id === currentProject ? " is-on" : ""}`}
                        onClick={() => navigate({ kind: "project", projectId: project.id })}
                      >
                        <span className="side-item-title">{project.name}</span>
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

      <nav className="side-nav" aria-label={t("side.sections")}>
        <button type="button" className="side-link side-sections" aria-expanded={sectionsOpen} onClick={toggleSections}>
          <MenuIcon />
          {t("side.sections")}
          <span className="side-sections-arrow" aria-hidden>
            ▾
          </span>
        </button>
        {sectionsOpen && (
          <div className="side-nav-items">
        <button className={`side-link${view.kind === "gallery" ? " is-on" : ""}`} onClick={() => navigate({ kind: "gallery" })}>
          <GalleryIcon />
          {t("side.gallery")}
        </button>
        <button className={`side-link${view.kind === "providers" ? " is-on" : ""}`} onClick={() => navigate({ kind: "providers" })}>
          <KeyIcon />
          {t("side.keys")}
        </button>
        <button className={`side-link${view.kind === "local" ? " is-on" : ""}`} onClick={() => navigate({ kind: "local" })}>
          <ComputerIcon />
          {t("side.local")}
        </button>
        <button className={`side-link${view.kind === "settings" ? " is-on" : ""}`} onClick={() => navigate({ kind: "settings" })}>
          <GearIcon />
          {t("top.settings")}
        </button>
        <button className={`side-link${view.kind === "guide" ? " is-on" : ""}`} onClick={() => navigate({ kind: "guide" })}>
          <BookIcon />
          {t("side.guide")}
        </button>
          </div>
        )}
      </nav>
    </aside>
  );
}
