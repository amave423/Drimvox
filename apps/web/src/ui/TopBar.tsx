import { inParams, useApp } from "../context";
import { Logo } from "./Logo";
import { LAST_PROJECT_KEY } from "./projects/Workshop";
import { WorkshopBar } from "./projects/WorkshopBar";

export function TopBar() {
  const { t, view, navigate, chats, projects, tasks } = useApp();

  // Every screen says where the user is (seen: the start page, the local models, the gallery and projects said nothing).
  let crumb = "";
  if (view.kind === "home") crumb = t("top.home");
  if (inParams(view)) crumb = t("side.params");
  if (view.kind === "projects") crumb = t("side.projects");
  if (view.kind === "project") crumb = projects.find((p) => p.id === view.projectId)?.name ?? "";
  if (view.kind === "task") crumb = tasks.find((x) => x.id === view.taskId)?.title ?? "";
  if (view.kind === "chat") crumb = chats.find((c) => c.id === view.chatId)?.title ?? t("chat.untitled");

  return (
    <header className="topbar">
      {/* The name and the place stand on one line of text, the mark centred beside the name. */}
      <div className="topbar-title">
        <button className="logo" onClick={() => navigate({ kind: "home" })} title={t("top.home")}>
          <Logo size={22} />
          <span className="logo-name">Drimvox</span>
        </button>
        <ModeSwitch />
        {crumb && (
          <span className="crumb" title={crumb}>
            {crumb}
          </span>
        )}
      </div>
      {view.kind === "project" && <WorkshopBar projectId={view.projectId} />}
    </header>
  );
}

/**
 * Chats or projects (asked for: the projects' mode as a window of its own, switched like Claude Code's). The projects'
 * mode comes back to the project opened last; from the parameters, a mode's button goes back into it.
 */
function ModeSwitch() {
  const { t, view, mode, navigate, leaveParams, projects } = useApp();
  function to(next: typeof mode) {
    if (next === mode && !inParams(view)) return;
    if (next === mode) return leaveParams();
    if (next === "chat") return navigate({ kind: "home" });
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
      {(["chat", "projects"] as const).map((m) => (
        <button key={m} type="button" aria-pressed={mode === m} className={mode === m ? "is-on" : undefined} onClick={() => to(m)}>
          {t(m === "chat" ? "mode.chat" : "mode.projects")}
        </button>
      ))}
    </div>
  );
}
