import { inParams, useApp } from "../context";
import { Logo } from "./Logo";
import { LAST_PROJECT_KEY } from "./projects/Workshop";
import { WorkshopBar } from "./projects/WorkshopBar";
import { BrowserPane, useBrowserState } from "./BrowserPane";
import { useState } from "react";

export function TopBar() {
  const { t, view, mode, navigate, chats, projects, tasks } = useApp();

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
        {/* The mark leads to the start of the mode the user is in: it never switches the mode (asked for). */}
        <button className="logo" onClick={() => navigate(mode === "projects" ? { kind: "projects" } : { kind: "home" })} title={t("top.home")}>
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
      <BrowserButton />
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

/**
 * The agent's browser, at the top right like Claude's (asked for): a dot while it runs; a click opens its panel, where
 * what the agent does is seen and a check can be passed by hand.
 */
function BrowserButton() {
  const { t } = useApp();
  const [open, setOpen] = useState(false);
  const state = useBrowserState();
  return (
    <>
      <button type="button" className={`topbar-browser${open ? " is-on" : ""}`} aria-pressed={open} title={t("browser.title")} onClick={() => setOpen(!open)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9M12 3c-2.5 2.6-3.8 5.6-3.8 9s1.3 6.4 3.8 9" />
        </svg>
        {t("browser.button")}
        {state?.running && <span className="topbar-browser-dot" aria-label={t("browser.running")} />}
      </button>
      {open && <BrowserPane onClose={() => setOpen(false)} />}
    </>
  );
}
