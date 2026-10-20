import { useState } from "react";
import { useApp } from "../context";

/** Small line icons, drawn with the text colour. */
export function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 20h4L19 9l-4-4L4 16v4z" />
      <path d="M13.5 6.5l4 4" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="M6 7l1 13h10l1-13" />
    </svg>
  );
}

/**
 * The chats in the sidebar: open one, rename it or delete it from the list, or pick several and delete them at once.
 * The list scrolls on its own, so the sections around it stay in place however many chats there are.
 */
export function SideChats() {
  const { api, t, view, navigate, openNewChat, chats: all, reloadChats } = useApp();
  // A project task's conversation lives under its project (seen: it looked like a stray new chat in this list).
  const chats = all.filter((c) => !c.projectId);
  const current = view.kind === "chat" ? view.chatId : undefined;
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);

  async function remove(ids: string[]) {
    await Promise.all(ids.map((id) => api.chats[":id"].$delete({ param: { id } }).catch(() => null)));
    setSelected([]);
    setSelecting(false);
    setDeleting(null);
    await reloadChats();
    if (current && ids.includes(current)) navigate({ kind: "home" });
  }

  async function rename(id: string) {
    const title = name.trim();
    setRenaming(null);
    if (!title) return;
    await api.chats[":id"].$patch({ param: { id }, json: { title } }).catch(() => null);
    await reloadChats();
  }

  return (
    <section className="side-group side-chats-group">
      <div className="side-row">
        <h2 className="side-h">{t("side.chats")}</h2>
        {selecting ? (
          <span className="side-row-actions">
            <button className="side-new is-pencil" disabled={selected.length === 0} onClick={() => void remove(selected)}>
              {t("side.deleteSelected", { n: selected.length })}
            </button>
            <button
              className="side-new"
              onClick={() => {
                setSelecting(false);
                setSelected([]);
              }}
            >
              {t("providers.cancel")}
            </button>
          </span>
        ) : (
          <span className="side-row-actions">
            {chats.length > 1 && (
              <button className="side-new is-quiet" onClick={() => setSelecting(true)}>
                {t("side.select")}
              </button>
            )}
            <button className="side-new" onClick={openNewChat}>
              + {t("side.newChat")}
            </button>
          </span>
        )}
      </div>
      {chats.length === 0 ? (
        <p className="side-empty">{t("side.chatsEmpty")}</p>
      ) : (
        <ul className="side-list side-chats">
          {chats.map((chat) => {
            const title = chat.title ?? t("chat.untitled");
            if (renaming === chat.id) {
              return (
                <li key={chat.id}>
                  <form
                    className="side-rename"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void rename(chat.id);
                    }}
                  >
                    <input
                      className="field-input"
                      aria-label={t("side.renameLabel")}
                      value={name}
                      autoFocus
                      onChange={(e) => setName(e.target.value)}
                      onBlur={() => void rename(chat.id)}
                      onKeyDown={(e) => e.key === "Escape" && setRenaming(null)}
                    />
                  </form>
                </li>
              );
            }
            if (selecting) {
              const on = selected.includes(chat.id);
              return (
                <li key={chat.id}>
                  <label className={`side-item side-pick${on ? " is-on" : ""}`}>
                    <input type="checkbox" checked={on} onChange={() => setSelected(on ? selected.filter((id) => id !== chat.id) : [...selected, chat.id])} />
                    <span className="side-item-title">{title}</span>
                  </label>
                </li>
              );
            }
            return (
              <li key={chat.id} className="side-chat">
                <button
                  className={`side-item${chat.id === current ? " is-on" : ""}`}
                  onClick={() => navigate({ kind: "chat", chatId: chat.id, key: chat.id })}
                  aria-current={chat.id === current ? "page" : undefined}
                >
                  <span className="side-item-title">{title}</span>
                  {/* Like ChatGPT and Claude: a spinner while the model answers, a dot once an unseen answer is ready. */}
                  {chat.answering ? (
                    <span className="action-spinner side-chat-state" role="img" aria-label={t("side.answering")} />
                  ) : (
                    chat.unread && chat.id !== current && <span className="side-chat-dot side-chat-state" role="img" aria-label={t("side.unread")} />
                  )}
                </button>
                {deleting === chat.id ? (
                  <span className="side-chat-actions is-shown">
                    <button className="side-new is-pencil" onClick={() => void remove([chat.id])}>
                      {t("side.deleteYes")}
                    </button>
                    <button className="side-new" onClick={() => setDeleting(null)}>
                      {t("side.deleteNo")}
                    </button>
                  </span>
                ) : (
                  <span className="side-chat-actions">
                    <button
                      className="icon-button"
                      aria-label={t("side.rename", { title })}
                      title={t("side.renameLabel")}
                      onClick={() => {
                        setName(title);
                        setRenaming(chat.id);
                      }}
                    >
                      <PencilIcon />
                    </button>
                    <button className="icon-button" aria-label={t("side.delete", { title })} title={t("chat.delete")} onClick={() => setDeleting(chat.id)}>
                      <TrashIcon />
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
