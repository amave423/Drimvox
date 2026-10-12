import type { ChatView, ChatWithMessages, StreamEvent } from "@artel/shared";
import { useEffect, useRef, useState } from "react";
import { ok } from "../../api";
import { useApp } from "../../context";
import { formatTokens, formatUsd } from "../../lib/format";
import { readLastModel, rememberLastModel, type ModelChoice } from "../../lib/lastModel";
import { postStream } from "../../lib/sse";
import { Composer } from "./Composer";
import { AssistantMessage, UserMessage } from "./Messages";
import { ModelNote } from "./ModelNote";
import { ModelPicker } from "./ModelPicker";

interface Draft {
  user: string;
  text: string;
  reasoning: string;
  model: string;
}

export function ChatSheet({ chatId, viewKey }: { chatId: string | null; viewKey: string }) {
  const { api, token, t, settings, providers, navigate, reloadChats, reloadToday } = useApp();
  const [chat, setChat] = useState<ChatWithMessages | null>(null);
  const [choice, setChoice] = useState<ModelChoice | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);

  async function load(id: string) {
    const loaded = await api.chats[":id"].$get({ param: { id } }).then((r) => ok<ChatWithMessages>(r)).catch(() => null);
    if (!loaded) return;
    setChat(loaded);
    if (loaded.providerId && loaded.model) setChoice({ providerId: loaded.providerId, model: loaded.model });
  }

  useEffect(() => {
    if (chatId && chatId !== chat?.id) void load(chatId);
  }, [chatId]);

  // A new chat starts with the model used last, once providers are known.
  useEffect(() => {
    if (chatId || choice) return;
    const last = readLastModel();
    if (last && providers.some((p) => p.id === last.providerId)) setChoice(last);
  }, [chatId, choice, providers]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [chat?.messages.length, draft?.text, draft?.reasoning]);

  async function send(content: string) {
    if (!choice) return;
    setFailed(false);
    let id = chat?.id;
    try {
      if (!id) {
        const created = await ok<ChatView>(await api.chats.$post({ json: choice }));
        id = created.id;
        setChat({ ...created, messages: [] });
        navigate({ kind: "chat", chatId: id, key: viewKey });
      } else if (chat && (chat.providerId !== choice.providerId || chat.model !== choice.model)) {
        await ok(await api.chats[":id"].$patch({ param: { id }, json: choice }));
      }
    } catch {
      setFailed(true);
      return;
    }
    rememberLastModel(choice);

    const controller = new AbortController();
    abort.current = controller;
    setDraft({ user: content, text: "", reasoning: "", model: choice.model });
    try {
      await postStream<StreamEvent>(
        `/api/chats/${id}/messages`,
        token,
        { content },
        (e) => {
          if (e.type === "text") setDraft((d) => d && { ...d, text: d.text + e.text });
          if (e.type === "reasoning") setDraft((d) => d && { ...d, reasoning: d.reasoning + e.text });
        },
        controller.signal,
      );
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    }
    abort.current = null;
    // After Stop the core saves the partial answer a moment later.
    if (controller.signal.aborted) await new Promise((r) => setTimeout(r, 200));
    await load(id);
    setDraft(null);
    void reloadChats();
    void reloadToday();
  }

  async function remove() {
    if (!chat) return;
    await api.chats[":id"].$delete({ param: { id: chat.id } }).catch(() => null);
    await reloadChats();
    navigate({ kind: "home" });
  }

  if (providers.length === 0) {
    return (
      <article className="sheet">
        <div className="sheet-body">
          <h1>{t("chat.emptyTitle")}</h1>
          <p className="lede">{t("chat.noProviders")}</p>
          <button className="btn is-primary" onClick={() => navigate({ kind: "providers" })}>
            {t("chat.openKeys")}
          </button>
        </div>
      </article>
    );
  }

  const messages = chat?.messages ?? [];
  const answers = messages.filter((m) => m.role === "assistant");
  const spent = answers.reduce((sum, m) => sum + (m.costUsd ?? 0), 0);
  const tokens = answers.reduce((sum, m) => sum + (m.inputTokens ?? 0) + (m.outputTokens ?? 0), 0);
  const unpriced = answers.some((m) => m.costUsd === null && m.outputTokens !== null);
  const empty = messages.length === 0 && !draft;

  return (
    <article className="sheet chat">
      <div className="sheet-body chat-body">
        <header className="chat-head">
          <h1>{chat?.title ?? t("chat.emptyTitle")}</h1>
        </header>

        {empty && <p className="lede">{t("chat.emptyLede")}</p>}

        <div className="messages">
          {messages.map((m) =>
            m.role === "user" ? (
              <UserMessage key={m.id} content={m.content} />
            ) : (
              <AssistantMessage key={m.id} content={m.content} reasoning={m.reasoning} model={m.model} message={m} />
            ),
          )}
          {draft && (
            <>
              <UserMessage content={draft.user} />
              <AssistantMessage content={draft.text} reasoning={draft.reasoning || null} model={draft.model} streaming />
            </>
          )}
          <div ref={end} />
        </div>

        {failed && <p className="error-note">{t("chat.sendFailed")}</p>}
        <Composer
          disabled={!choice}
          streaming={!!draft}
          onSend={(text) => void send(text)}
          onStop={() => abort.current?.abort()}
          tools={<ModelPicker value={choice} onChange={setChoice} placement="above" />}
        />
      </div>

      {/* Sticks to the top while the conversation scrolls, so these stay within reach. */}
      <aside className="margin chat-margin">
        {choice && <ModelNote choice={choice} />}
        {answers.length > 0 && (
          <p className="note">
            {t("chat.totals", { cost: formatUsd(spent), tokens: formatTokens(tokens, settings.locale) })}
            {unpriced && (
              <>
                <br />
                <span className="muted">{t("chat.totalsUnpriced")}</span>
              </>
            )}
          </p>
        )}
        {chat &&
          (confirmDelete ? (
            <div className="note is-pencil delete-confirm">
              <p>{t("chat.deleteConfirm")}</p>
              <div className="actions">
                <button className="btn is-pencil" onClick={() => void remove()}>
                  {t("chat.delete")}
                </button>
                <button className="btn" onClick={() => setConfirmDelete(false)}>
                  {t("providers.cancel")}
                </button>
              </div>
            </div>
          ) : (
            <button className="link is-pencil margin-action" onClick={() => setConfirmDelete(true)}>
              {t("chat.delete")}
            </button>
          ))}
      </aside>
    </article>
  );
}
