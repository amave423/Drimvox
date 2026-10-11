import { useApp } from "../context";

export function Sidebar() {
  const { t, status, view, navigate, openNewChat, chats, providers } = useApp();
  const currentChat = view.kind === "chat" ? view.chatId : undefined;

  return (
    <aside className="side">
      <section className="side-chats">
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
