import logo from "../assets/logo.svg";
import { useApp } from "../context";

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
    </header>
  );
}
