import logo from "../assets/logo.svg";
import { useApp } from "../context";

export function TopBar() {
  const { t, view, navigate, chats } = useApp();

  let crumb = "";
  if (view.kind === "settings") crumb = t("top.settings");
  if (view.kind === "providers") crumb = t("top.keys");
  if (view.kind === "chat") crumb = chats.find((c) => c.id === view.chatId)?.title ?? t("chat.untitled");

  return (
    <header className="topbar">
      {/* The name and the place stand on one line of text, the mark centred beside the name. */}
      <div className="topbar-title">
        <button className="logo" onClick={() => navigate({ kind: "home" })} title={t("top.home")}>
          <img src={logo} alt="" width={22} height={22} />
          <span className="logo-name">Artel</span>
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
