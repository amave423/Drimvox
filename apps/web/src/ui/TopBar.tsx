import { useApp } from "../context";

export function TopBar() {
  const { t, view, navigate, chats } = useApp();

  let crumb = "";
  if (view.kind === "settings") crumb = t("top.settings");
  if (view.kind === "providers") crumb = t("top.keys");
  if (view.kind === "chat") crumb = chats.find((c) => c.id === view.chatId)?.title ?? t("chat.untitled");

  const onSettings = view.kind === "settings";
  return (
    <header className="topbar">
      <button className="logo" onClick={() => navigate({ kind: "home" })} title={t("top.home")}>
        Artel
      </button>
      <span className="crumb">{crumb}</span>
      <span className="spacer" />
      <button
        className={`topbar-link${onSettings ? " is-on" : ""}`}
        onClick={() => navigate({ kind: onSettings ? "home" : "settings" })}
        aria-pressed={onSettings}
      >
        {t("top.settings")}
      </button>
    </header>
  );
}
