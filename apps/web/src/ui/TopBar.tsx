import logo from "../assets/logo.svg";
import { inProjects, useApp } from "../context";
import { LAST_PROJECT_KEY } from "./projects/Workshop";

export function TopBar() {
  const { t, view, navigate, chats, projects, tasks } = useApp();

  // Every screen says where the user is (seen: the start page, the local models, the gallery and projects said nothing).
  let crumb = "";
  if (view.kind === "home") crumb = t("top.home");
  if (view.kind === "settings") crumb = t("top.settings");
  if (view.kind === "providers") crumb = t("top.keys");
  if (view.kind === "local") crumb = t("side.local");
  if (view.kind === "gallery") crumb = t("side.gallery");
  if (view.kind === "guide") crumb = t("side.guide");
  if (view.kind === "projects") crumb = t("side.projects");
  if (view.kind === "project") crumb = projects.find((p) => p.id === view.projectId)?.name ?? "";
  if (view.kind === "task") crumb = tasks.find((x) => x.id === view.taskId)?.title ?? "";
  if (view.kind === "chat") crumb = chats.find((c) => c.id === view.chatId)?.title ?? t("chat.untitled");

  return (
    <header className="topbar">
      {/* The name and the place stand on one line of text, the mark centred beside the name. */}
      <div className="topbar-title">
        <button className="logo" onClick={() => navigate({ kind: "home" })} title={t("top.home")}>
          <img src={logo} alt="" width={22} height={22} />
          <span className="logo-name">Drimvox</span>
        </button>
        {crumb && (
          <span className="crumb" title={crumb}>
            {crumb}
          </span>
        )}
      </div>
      <ModeSwitch />
    </header>
  );
}

/**
 * Chats or projects (asked for: the projects' mode as a window of its own, switched like Claude Code's). The projects'
 * mode comes back to the project opened last.
 */
function ModeSwitch() {
  const { t, view, navigate, chats, projects } = useApp();
  const projectsOn = inProjects(view, chats);
  function toProjects() {
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_PROJECT_KEY);
    } catch {
      // Not remembered: the projects' start.
    }
    navigate(last && projects.some((p) => p.id === last) ? { kind: "project", projectId: last } : { kind: "projects" });
  }
  return (
    <div className="mode-switch" role="group" aria-label={t("mode.label")}>
      <button type="button" aria-pressed={!projectsOn} className={!projectsOn ? "is-on" : undefined} onClick={() => projectsOn && navigate({ kind: "home" })}>
        {t("mode.chat")}
      </button>
      <button type="button" aria-pressed={projectsOn} className={projectsOn ? "is-on" : undefined} onClick={() => !projectsOn && toProjects()}>
        {t("mode.projects")}
      </button>
    </div>
  );
}
