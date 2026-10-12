import {
  estimateCost,
  needsConfirmation,
  presets,
  CONFIRM_ABOVE_USD,
  type ChatView,
  type ChatWithMessages,
  type MediaModel,
  type MediaOptions as Options,
  type StreamEvent,
} from "@artel/shared";
import { useEffect, useRef, useState } from "react";
import { ok } from "../../api";
import { useApp } from "../../context";
import { formatTokens, formatUsd } from "../../lib/format";
import { readLastModel, rememberLastModel, type ModelChoice } from "../../lib/lastModel";
import { loadMediaModel } from "../../lib/media";
import { postStream } from "../../lib/sse";
import { Composer } from "./Composer";
import { MediaOptions } from "./MediaOptions";
import { AssistantMessage, UserMessage } from "./Messages";
import { ModelNote } from "./ModelNote";
import { ModelPicker } from "./ModelPicker";
import { readWebMode, WebSwitch } from "./WebSwitch";

interface Draft {
  user: string;
  text: string;
  reasoning: string;
  model: string;
  /** A picture or a clip is being made rather than text streamed. */
  media: boolean;
  /** Searches and pages the model looked at while answering. */
  activity: string[];
}

/** Answers still being made on the provider's side, such as clips, are checked this often. */
const PENDING_POLL_MS = 3000;

export function ChatSheet({ chatId, viewKey }: { chatId: string | null; viewKey: string }) {
  const { api, token, t, settings, providers, navigate, reloadChats, reloadToday } = useApp();
  const [chat, setChat] = useState<ChatWithMessages | null>(null);
  const [choice, setChoice] = useState<ModelChoice | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [mediaModel, setMediaModel] = useState<MediaModel | null>(null);
  const [options, setOptions] = useState<Options>({});
  const [web, setWeb] = useState(readWebMode);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const kind = choice?.kind ?? "text";

  async function load(id: string) {
    const loaded = await api.chats[":id"].$get({ param: { id } }).then((r) => ok<ChatWithMessages>(r)).catch(() => null);
    if (!loaded) return;
    setChat(loaded);
    if (loaded.providerId && loaded.model) setChoice({ providerId: loaded.providerId, model: loaded.model, kind: loaded.kind });
  }

  // Pictures and clips: the model's options and prices, for the estimate under the prompt.
  useEffect(() => {
    setMediaModel(null);
    setOptions({});
    if (!choice || kind === "text") return;
    let live = true;
    void loadMediaModel(api, choice.providerId, kind, choice.model).then((m) => live && setMediaModel(m));
    return () => {
      live = false;
    };
  }, [api, choice?.providerId, choice?.model, kind]);

  // A clip renders for minutes on the provider's side; the chat checks on it until it arrives.
  const pending = !draft && !!chat?.messages.some((m) => m.status === "streaming");
  useEffect(() => {
    if (!pending || !chat) return;
    const timer = setTimeout(() => void load(chat.id).then(() => void reloadToday()), PENDING_POLL_MS);
    return () => clearTimeout(timer);
  }, [pending, chat]);

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

  const estimateUsd = mediaModel ? estimateCost(mediaModel, options) : null;
  const preset = providers.find((p) => p.id === choice?.providerId)?.preset;
  const providerSearch = preset === "openrouter" || preset === "routerai";
  const searchProvider = providerSearch && preset ? presets[preset].name : null;
  const webMode = web === "provider" && !providerSearch ? "free" : web;
  const confirm = !!mediaModel && needsConfirmation(mediaModel, estimateUsd);

  async function send(content: string) {
    if (!choice) return;
    setFailed(false);
    let id = chat?.id;
    const target = { providerId: choice.providerId, model: choice.model, kind };
    try {
      if (!id) {
        const created = await ok<ChatView>(await api.chats.$post({ json: target }));
        id = created.id;
        setChat({ ...created, messages: [] });
        navigate({ kind: "chat", chatId: id, key: viewKey });
      } else if (chat && (chat.providerId !== choice.providerId || chat.model !== choice.model || chat.kind !== kind)) {
        await ok(await api.chats[":id"].$patch({ param: { id }, json: target }));
      }
    } catch {
      setFailed(true);
      return;
    }
    rememberLastModel(choice);

    const controller = new AbortController();
    abort.current = controller;
    setDraft({ user: content, text: "", reasoning: "", model: choice.model, media: kind !== "text", activity: [] });
    try {
      await postStream<StreamEvent>(
        `/api/chats/${id}/messages`,
        token,
        // The price was on the button the user pressed; that is the confirmation.
        kind === "text" ? { content, web: webMode } : { content, options, confirm },
        (e) => {
          if (e.type === "text") setDraft((d) => d && { ...d, text: d.text + e.text });
          if (e.type === "reasoning") setDraft((d) => d && { ...d, reasoning: d.reasoning + e.text });
          if (e.type === "tool") {
            const line = e.name === "web_search" ? t("web.searching", { query: e.input }) : t("web.reading", { url: e.input });
            setDraft((d) => d && { ...d, activity: [...d.activity, line] });
          }
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

        {empty && <p className="lede">{t(kind === "text" ? "chat.emptyLede" : "media.emptyLede", { limit: formatUsd(CONFIRM_ABOVE_USD) })}</p>}

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
              <AssistantMessage
                content={draft.text}
                reasoning={draft.reasoning || null}
                model={draft.model}
                streaming
                making={draft.media ? kind : undefined}
                activity={draft.activity}
              />
            </>
          )}
          <div ref={end} />
        </div>

        {failed && <p className="error-note">{t("chat.sendFailed")}</p>}
        <Composer
          disabled={!choice || (kind !== "text" && !mediaModel)}
          streaming={!!draft}
          onSend={(text) => void send(text)}
          onStop={() => abort.current?.abort()}
          tools={
            <>
              <ModelPicker value={choice} onChange={setChoice} placement="above" kinds={["text", "image", "video"]} />
              {kind === "text" && choice && <WebSwitch value={web} onChange={setWeb} providerName={searchProvider} />}
            </>
          }
          extra={mediaModel && <MediaOptions model={mediaModel} value={options} onChange={setOptions} estimateUsd={estimateUsd} />}
          placeholder={kind === "text" ? undefined : t(kind === "image" ? "media.placeholderImage" : "media.placeholderVideo")}
          sendLabel={
            kind === "text"
              ? undefined
              : confirm
                ? estimateUsd === null
                  ? t("media.startUnknown")
                  : t("media.startFor", { cost: formatUsd(estimateUsd) })
                : t("media.make")
          }
        />
      </div>

      {/* Sticks to the top while the conversation scrolls, so these stay within reach. */}
      <aside className="margin chat-margin">
        {choice && <ModelNote choice={choice} />}
        {answers.length > 0 && (
          <p className="note">
            {tokens === 0
              ? t("chat.totalsCost", { cost: formatUsd(spent) })
              : t("chat.totals", { cost: formatUsd(spent), tokens: formatTokens(tokens, settings.locale) })}
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
