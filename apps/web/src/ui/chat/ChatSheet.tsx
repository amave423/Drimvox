import type { MessageKey } from "../../i18n";
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
  type AttachmentView,
  type ActivityEntry,
} from "@drimvox/shared";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ok } from "../../api";
import { useApp } from "../../context";
import { formatUsd } from "../../lib/format";
import { readLastModel, rememberLastModel, type ModelChoice } from "../../lib/lastModel";
import { loadMediaModel } from "../../lib/media";
import { CoreRefusal, postStream } from "../../lib/sse";
import { Composer } from "./Composer";
import { MediaPrice, useMediaOptionRows } from "./MediaOptions";
import { directorRows, useDirector } from "./DirectorControl";
import { AssistantMessage, UserMessage, type AnswerAction, type ChatApproval } from "./Messages";
import { ModelPicker } from "./ModelPicker";
import { isPhoto, photoProblem } from "./photos";
import { loadModels } from "../../lib/models";
import { readWebMode, WebSwitch } from "./WebSwitch";
import { FolderSwitch } from "./FolderSwitch";
import { readThinking, ThinkingSwitch } from "./ThinkingSwitch";
import { ChatMargin } from "./ChatMargin";
import { WorkReview } from "../projects/WorkReview";
import { MAX_BYTES, MAX_FILES, prepareFile, SentFiles, toBase64, type PendingFile } from "./Attachments";
import { activityLine } from "./activityLine";
import { useFollow } from "./useFollow";
import { useLiveAnswer } from "./useLiveAnswer";
import { useProjectWork } from "../projects/useProjectWork";
import { noticeLookNow } from "../NoticeSoundSetting";
import { ShotsContext, type Shot } from "../ShotGallery";

interface Draft {
  user: string;
  text: string;
  reasoning: string;
  model: string;
  /** A picture or a clip is being made rather than text streamed. */
  media: boolean;
  /** Searches and pages the model looked at while answering. */
  activity: ActivityEntry[];
  /** MCP tools waiting for, or given, the user's permission. */
  approvals: ChatApproval[];
  /** Files sent with the question. */
  attachments: AttachmentView[];
}

/** Answers still being made on the provider's side, such as clips, are checked this often. */
const PENDING_POLL_MS = 3000;

/**
 * A chat, or in a project's workshop (`workshop`) the run's conversation as a timeline: the agent's actions and the
 * user's messages in time, with the box to write to the run under them.
 */
export function ChatSheet({ chatId, viewKey, autoSend, workshop }: { chatId: string | null; viewKey: string; autoSend?: string; workshop?: boolean }) {
  const { api, token, t, settings, providers, navigate, reloadChats, reloadToday } = useApp();
  const [chat, setChat] = useState<ChatWithMessages | null>(null);
  const [choice, setChoice] = useState<ModelChoice | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  /** While an edited message is answered: how many messages before it stay on screen. */
  const [cutAt, setCutAt] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  /** The month's budget is used up: said with the numbers, not as a failed send. */
  const [monthRefusal, setMonthRefusal] = useState<{ spent: number; budget: number } | null>(null);
  const [mediaModel, setMediaModel] = useState<MediaModel | null>(null);
  const [options, setOptions] = useState<Options>({});
  const [web, setWeb] = useState(readWebMode);
  const [thinking, setThinking] = useState(readThinking);
  // Small local models cannot call tools: they chat without Drimvox's search.
  const [noTools, setNoTools] = useState(false);
  // The folder the model works in; kept locally until the chat exists.
  const [folder, setFolder] = useState<string | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  // Files for the next message (docs/specs/chat-attachments.md).
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [noVision, setNoVision] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const kind = choice?.kind ?? "text";

  useEffect(() => {
    setNoTools(false);
    if (!choice || kind !== "text") return;
    let live = true;
    void loadModels(api, choice.providerId).then((r) => {
      if (!live) return;
      const info = "models" in r ? r.models.find((m) => m.id === choice.model) : undefined;
      setNoTools(info?.tools === false);
      setNoVision(info?.vision === false);
    });
    return () => {
      live = false;
    };
  }, [api, choice?.providerId, choice?.model, kind]);

  async function load(id: string) {
    const loaded = await api.chats[":id"].$get({ param: { id } }).then((r) => ok<ChatWithMessages>(r)).catch(() => null);
    if (!loaded) return;
    setChat(loaded);
    setFolder(loaded.folder);
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

  // A clip renders for minutes on the provider's side, and an answer goes on after the window that asked left the chat:
  // the chat checks on them until they are done.
  const pending = !draft && !!chat?.messages.some((m) => m.status === "streaming");
  // A text answer is followed live, letter by letter (useLiveAnswer); the rest (clips, a project's run) by looking again.
  const live = useLiveAnswer(chat?.id ?? null, pending && chat?.kind === "text" && !chat.projectId, token, () => chat && void load(chat.id).then(() => void reloadToday()));
  useEffect(() => {
    if (!pending || !chat || live) return;
    // A text answer is followed closely; a clip renders for minutes.
    const timer = setTimeout(() => void load(chat.id).then(() => void reloadToday()), chat.kind === "text" ? 1000 : PENDING_POLL_MS);
    return () => clearTimeout(timer);
  }, [pending, chat, live]);

  // Looked at with nothing being written: its answers are read, and the list drops the dot.
  const settled = !!chat && !draft && !chat.messages.some((m) => m.status === "streaming");
  useEffect(() => {
    if (!settled || !chat) return;
    void api.chats[":id"].seen
      .$post({ param: { id: chat.id } })
      .then(() => reloadChats())
      .catch(() => null);
  }, [settled, chat?.id, chat?.messages.length]);

  useEffect(() => {
    if (chatId && chatId !== chat?.id) void load(chatId);
  }, [chatId]);

  // A project task's conversation starts with the task itself, sent once the chat and its model are loaded; a question
  // asked on the start page opens a new chat that sends it once its model is known.
  const autoSent = useRef(false);
  useEffect(() => {
    if (!autoSend || autoSent.current || !choice || draft) return;
    if (chatId && (!chat || chat.id !== chatId || chat.messages.length > 0)) return;
    autoSent.current = true;
    void send(autoSend);
  }, [autoSend, chat, choice]);

  // A new chat starts with the model used last, once providers are known.
  useEffect(() => {
    if (chatId || choice) return;
    const last = readLastModel();
    if (last && providers.some((p) => p.id === last.providerId)) setChoice(last);
  }, [chatId, choice, providers]);

  const list = useRef<HTMLDivElement>(null);
  useFollow(end, list, chat?.id, [chat?.id, draft?.user], chat?.messages.length);

  // A project's conversation (docs/specs/project-work.md): the run goes on in the core; the chat follows it in the
  // project's workshop, and messages join it on the way.
  const projectId = chat?.projectId && !chat.itemId ? chat.projectId : null;
  useEffect(() => {
    if (projectId && !workshop) navigate({ kind: "project", projectId });
  }, [projectId, workshop]);
  /** What the model did, as the answer shows it in order; a project's screenshots by their address. */
  const toActions = (entries: ActivityEntry[]): AnswerAction[] =>
    entries.flatMap((a) =>
      a.name === "screenshot"
        ? projectId
          ? [{ line: "", at: a.at, shot: `/api/projects/${projectId}/work/shots/${a.input}` }]
          : []
        : [{ line: activityLine(t, a.name, a.input), at: a.at }],
    );
  const { work, reload: reloadWork } = useProjectWork(projectId);
  // Every screenshot of the run in order, so one opened goes on to the others; captioned with its page.
  const shots: Shot[] = projectId
    ? (chat?.messages ?? []).flatMap((m) =>
        (live?.messageId === m.id ? live.activity : m.activity)
          .filter((a) => a.name === "screenshot")
          .map((a) => ({ url: `/api/projects/${projectId}/work/shots/${a.input}`, caption: work?.shots.find((s) => s.id === a.input)?.url })),
      )
    : [];
  const running = work?.status === "running";
  useEffect(() => {
    if (!running || !chat) return;
    const timer = setInterval(() => void load(chat.id), 1000);
    return () => clearInterval(timer);
  }, [running, chat?.id]);

  // A director makes up to its attempts, each paid: the price on the button is for all of them (a clip: one).
  const [director, setDirector] = useDirector();
  const directing = kind !== "text" && director.on && !!director.providerId && !!director.model;
  const tries = directing && kind === "image" ? director.attempts : 1;
  const one = mediaModel ? estimateCost(mediaModel, options) : null;
  const estimateUsd = one === null ? null : one * tries;
  const preset = providers.find((p) => p.id === choice?.providerId)?.preset;
  const providerSearch = preset === "openrouter" || preset === "routerai";
  const searchProvider = providerSearch && preset ? presets[preset].name : null;
  const asked = web === "provider" && !providerSearch ? "free" : web;
  const webMode = noTools && asked === "free" ? "off" : asked;
  // Command-line agents and local models think their own way: no switch for them.
  const thinks = !!preset && !["claude-code", "codex", "gemini-cli", "antigravity", "ollama", "lmstudio"].includes(preset);
  // What differs from the usual shows on the options button itself: no internet, another thinking level, a folder.
  const changedOptions = [
    ...(webMode === "off" ? [t("web.off")] : webMode === "provider" && searchProvider ? [t("web.provider", { name: searchProvider })] : []),
    ...(thinks && thinking !== "auto" ? [t("thinking.short", { level: t(`thinking.${thinking}` as MessageKey) })] : []),
    ...(folder ? [t("folder.connected", { name: folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder })] : []),
  ];
  const confirm = !!mediaModel && needsConfirmation(mediaModel, estimateUsd);
  const optionRows = useMediaOptionRows({ model: mediaModel, value: options, onChange: setOptions });
  const mediaRows = {
    changed: [...optionRows.changed, ...(directing ? [t("director.short", { n: tries })] : [])],
    rows: [...optionRows.rows, ...directorRows(director, kind === "video", setDirector, t)],
  };

  async function saveFolder(id: string, next: string | null): Promise<boolean> {
    const res = await api.chats[":id"].folder.$patch({ param: { id }, json: { folder: next } }).catch(() => null);
    if (res?.ok) return true;
    const body = (await res?.json().catch(() => null)) as { error?: { code?: string } } | null;
    setFolderError(body?.error?.code ?? "unknown");
    return false;
  }

  async function changeFolder(next: string | null) {
    setFolderError(null);
    if (chat && !(await saveFolder(chat.id, next))) return;
    setFolder(next);
  }

  async function undo(messageId: string) {
    if (!chat) return;
    await api.chats[":id"].messages[":messageId"].undo.$post({ param: { id: chat.id, messageId } }).catch(() => null);
    await load(chat.id);
  }

  async function addFiles(added: File[]) {
    setAttachError(null);
    const prepared = await Promise.all(added.map(prepareFile));
    if (prepared.some((f) => f === null)) setAttachError("format");
    const ready = prepared.filter((f): f is File => f !== null);
    const next = [...files, ...ready.map((file) => ({ key: `${file.name}-${file.size}-${Math.random()}`, file }))];
    if (next.length > MAX_FILES) return setAttachError("too_many");
    if (next.reduce((sum, f) => sum + f.file.size, 0) > MAX_BYTES) return setAttachError("too_big");
    setFiles(next);
  }

  /** Sends the waiting files to the chat; null when one of them could not go. */
  async function upload(id: string): Promise<AttachmentView[] | null> {
    const sent: AttachmentView[] = [];
    for (const f of files) {
      const res = await api.chats[":id"].attachments
        .$post({ param: { id }, json: { name: f.file.name, type: f.file.type, data: await toBase64(f.file) } })
        .catch(() => null);
      if (!res?.ok) return null;
      sent.push((await res.json()) as AttachmentView);
    }
    return sent;
  }

  /** In a project's conversation a message goes to the run: taken on the way, or starting it again. */
  async function sendToWork(id: string, content: string) {
    setFailed(false);
    const res = await api.projects[":id"].work.message.$post({ param: { id }, json: { content } }).catch(() => null);
    if (!res?.ok) setFailed(true);
    await reloadWork();
    if (chat) await load(chat.id);
  }

  /** Shows another version of an edited message, and the branch that goes on from it. */
  async function showVersion(messageId: string) {
    if (!chat) return;
    await api.chats[":id"].branch.$post({ param: { id: chat.id }, json: { messageId } }).catch(() => null);
    await load(chat.id);
  }

  async function send(content: string, editOf?: string) {
    setMonthRefusal(null);
    if (projectId) return sendToWork(projectId, content);
    if (!choice) return;
    setFailed(false);
    setAttachError(null);
    if (kind === "text" && noVision && files.some(isPhoto)) return setAttachError("no_vision");
    // Pictures and clips: photos only to a model that takes them, as many as it takes (the core refuses the same).
    const problem = kind === "text" ? null : photoProblem(mediaModel, files);
    if (problem) return setAttachError(problem);
    let id = chat?.id;
    const target = { providerId: choice.providerId, model: choice.model, kind };
    try {
      if (!id) {
        const created = await ok<ChatView>(await api.chats.$post({ json: target }));
        id = created.id;
        setChat({ ...created, messages: [], approvals: [] });
        // In the list at once: going elsewhere while the model answers must not lose the chat (seen: it showed up
        // only when the answer was done).
        void reloadChats();
        if (folder && !(await saveFolder(id, folder))) return;
        navigate({ kind: "chat", chatId: id, key: viewKey });
      } else if (chat && (chat.providerId !== choice.providerId || chat.model !== choice.model || chat.kind !== kind)) {
        await ok(await api.chats[":id"].$patch({ param: { id }, json: target }));
      }
    } catch {
      setFailed(true);
      return;
    }
    rememberLastModel(choice);
    const attached = files.length ? await upload(id) : [];
    if (attached === null) return setAttachError("failed");
    setFiles([]);

    const controller = new AbortController();
    abort.current = controller;
    // An edit: the chat shows what came before the edited message, then the new version and its answer.
    const cut = editOf ? (chat?.messages.findIndex((m) => m.id === editOf) ?? -1) : -1;
    setCutAt(cut >= 0 ? cut : null);
    const kept = cut >= 0 && !attached.length ? (chat?.messages[cut]?.attachments ?? []) : attached;
    setDraft({ user: content, text: "", reasoning: "", model: choice.model, media: kind !== "text", activity: [], approvals: [], attachments: kept });
    try {
      await postStream<StreamEvent>(
        `/api/chats/${id}/messages`,
        token,
        // The price was on the button the user pressed; that is the confirmation.
        kind === "text"
          ? { content, web: webMode, thinking: thinks ? thinking : "auto", attachments: attached.map((a) => a.id), ...(editOf ? { editOf } : {}) }
          : {
              content,
              options,
              confirm,
              attachments: attached.map((a) => a.id),
              ...(directing ? { director: { providerId: director.providerId!, model: director.model!, attempts: director.attempts, sketches: director.sketches } } : {}),
            },
        (e) => {
          // The core named the chat after the question: the list shows the name before the answer is done.
          if (e.type === "start") void reloadChats();
          if (e.type === "text") setDraft((d) => d && { ...d, text: d.text + e.text });
          if (e.type === "reasoning") setDraft((d) => d && { ...d, reasoning: d.reasoning + e.text });
          if (e.type === "tool") {
            setDraft((d) => d && { ...d, activity: [...d.activity, { name: e.name, input: e.input, at: d.text.length }] });
          }
          if (e.type === "approval") {
            const card: ChatApproval = { id: e.id, server: e.server, tool: e.tool, input: e.input, reason: e.reason, purpose: e.purpose, state: "open" };
            setDraft((d) => d && { ...d, approvals: [...d.approvals, card] });
            // The answer waits on the user: said by a notification when the window is elsewhere (seen: a chat stood still
            // for minutes on a request nobody saw).
            if (settings.notifications) window.drimvox?.notify({ ...noticeLookNow(settings), mode: "chat", title: t("notice.chatApproval"), body: content.slice(0, 120), chatId: id });
          }
          if (e.type === "approved") {
            const state = e.allowed ? "allowed" : "denied";
            setDraft((d) => d && { ...d, approvals: d.approvals.map((a) => (a.id === e.id ? { ...a, state } : a)) });
          }
        },
        controller.signal,
      );
    } catch (err) {
      if (err instanceof CoreRefusal && err.error?.code === "month_budget") setMonthRefusal({ spent: Number(err.error.spentUsd ?? 0), budget: Number(err.error.budgetUsd ?? 0) });
      else if (!controller.signal.aborted) setFailed(true);
    }
    abort.current = null;
    // After Stop the core saves the partial answer a moment later.
    if (controller.signal.aborted) await new Promise((r) => setTimeout(r, 200));
    await load(id);
    setDraft(null);
    setCutAt(null);
    void reloadChats();
    void reloadToday();
  }

  async function approve(approvalId: string, allow: boolean, always: boolean, server = false) {
    if (!chat) return;
    await api.chats[":id"].approvals[":approvalId"].$post({ param: { id: chat.id, approvalId }, json: { allow, always, server } }).catch(() => null);
    if (!draft) await load(chat.id);
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
  const empty = messages.length === 0 && !draft;
  // One's own message is edited in a text chat; a project's run and a program on a subscription keep their own course.
  const editable = kind === "text" && !projectId && !chat?.itemId && providers.find((p) => p.id === chat?.providerId)?.billing !== "subscription";

  // In the workshop every message stands at its time on the timeline.
  const at = (key: string, time: number, node: ReactNode, done = false) =>
    workshop ? (
      <div className={`tl-item${done ? " is-done" : ""}`} key={key}>
        <time className="tl-time mono">{new Date(time).toLocaleTimeString(settings.locale, { hour: "2-digit", minute: "2-digit" })}</time>
        {node}
      </div>
    ) : (
      node
    );

  return (
    <article className={workshop ? "workshop-chat" : "sheet chat"}>
      <div className={workshop ? "workshop-chat-body" : "sheet-body chat-body"}>
        {!workshop && (
          <header className="chat-head">
            <h1>{chat?.title ?? t("chat.emptyTitle")}</h1>
          </header>
        )}

        {empty && !workshop && <p className="lede">{t(kind === "text" ? "chat.emptyLede" : "media.emptyLede", { limit: formatUsd(CONFIRM_ABOVE_USD) })}</p>}

        <ShotsContext.Provider value={shots}>
        <div className={`messages${workshop ? " timeline" : ""}`} ref={list}>
          {(cutAt !== null ? messages.slice(0, cutAt) : messages).map((m) => at(m.id, m.createdAt,
            m.role === "user" ? (
              <UserMessage
                key={m.id}
                content={m.content}
                files={chat ? <SentFiles chatId={chat.id} files={m.attachments} /> : null}
                versions={m.versions}
                onVersion={draft ? undefined : (id) => void showVersion(id)}
                onEdit={editable && !draft ? (text) => void send(text, m.id) : undefined}
              />
            ) : (
              <AssistantMessage
                key={m.id}
                // Still being written and followed live: the text, the thinking and the actions as they come.
                content={live?.messageId === m.id ? live.text : m.content}
                reasoning={live?.messageId === m.id ? live.reasoning || null : m.reasoning}
                streaming={live?.messageId === m.id}
                model={m.model}
                message={m}
                kind={chat?.kind}
                // Still being written: its actions so far, as they come; once done, folded.
                actions={toActions(live?.messageId === m.id ? live.activity : m.activity)}
                onUndo={draft || chat?.itemId ? undefined : () => void undo(m.id)}
                // Seen after coming back to the chat: the requests this answer waits on, to answer here.
                approvals={m.status === "streaming" && !draft ? chat?.approvals.map((a) => ({ ...a, state: "open" as const })) : undefined}
                onApprove={approve}
              />
            ),
            // On the timeline a finished answer is a filled point; one still being written, an open one.
            m.role === "assistant" && m.status !== "streaming",
          ))}
          {draft && (
            <>
              <UserMessage content={draft.user} files={chat ? <SentFiles chatId={chat.id} files={draft.attachments} /> : null} />
              <AssistantMessage
                content={draft.text}
                reasoning={draft.reasoning || null}
                model={draft.model}
                streaming
                making={draft.media ? kind : undefined}
                actions={toActions(draft.activity)}
                approvals={draft.approvals}
                onApprove={approve}
              />
            </>
          )}
          <div ref={end} />
        </div>
        </ShotsContext.Provider>

        {failed && <p className="error-note">{t("chat.sendFailed")}</p>}
        {monthRefusal && <p className="error-note">{t("chat.monthBudget", { spent: formatUsd(monthRefusal.spent), budget: formatUsd(monthRefusal.budget) })}</p>}
        {attachError && <p className="error-note">{t(`attach.${attachError}` as MessageKey, { max: MAX_FILES })}</p>}
        {folderError && <p className="error-note">{t(folderError === "no_tools" ? "folder.noTools" : folderError === "not_found" ? "folder.notFound" : "folder.failed")}</p>}
        {chat?.projectId && chat.itemId && (
          <WorkReview projectId={chat.projectId} itemId={chat.itemId} busy={!!draft} answers={answers.length} />
        )}
        {/* The agent's newest question over the box (variant A); all of them are in the workshop's "Questions". */}
        {workshop && work && work.questions.length > 0 && (
          <section className="work-questions-note">
            <strong>{t("workshop.asks")}</strong>
            <p>{work.questions.at(-1)!.question}</p>
            <p className="muted">{t("projectWork.assumes", { assumption: work.questions.at(-1)!.assumption })}</p>
          </section>
        )}
        {projectId ? (
          // A project's conversation: the run goes on while the user writes; Stop is in the workshop's header.
          <Composer
            disabled={!work?.startedAt}
            streaming={false}
            onSend={(text) => void send(text)}
            onStop={() => {}}
            picker={null}
            options={{ changed: [], rows: [] }}
            placeholder={t("chat.workPlaceholder")}
          />
        ) : (
          <Composer
            disabled={!choice || (kind !== "text" && !mediaModel)}
            streaming={!!draft || pending}
            onSend={(text) => void send(text)}
            // An answer from this window stops with its request; one seen after coming back, through the core.
            onStop={() => (draft ? abort.current?.abort() : chat && void api.chats[":id"].stop.$post({ param: { id: chat.id } }).then(() => load(chat.id)))}
            attach={{
              files,
              onAdd: (added) => void addFiles(added),
              onRemove: (key) => setFiles(files.filter((f) => f.key !== key)),
              photos: kind !== "text",
              blocked: kind !== "text" && mediaModel && !mediaModel.photos ? t("photos.cannot") : undefined,
            }}
            picker={<ModelPicker value={choice} onChange={setChoice} placement="above" kinds={["text", "image", "video"]} photos={kind !== "text" && files.some(isPhoto)} />}
            options={
              mediaModel
                ? mediaRows
                : kind === "text" && choice
                  ? {
                      changed: changedOptions,
                      rows: [
                        { label: t("web.label"), control: <WebSwitch value={web} onChange={setWeb} providerName={searchProvider} noTools={noTools} /> },
                        ...(thinks ? [{ label: t("thinking.label"), control: <ThinkingSwitch value={thinking} onChange={setThinking} /> }] : []),
                        { label: t("folder.label"), control: <FolderSwitch value={folder} onChange={(next) => void changeFolder(next)} noTools={noTools} /> },
                      ],
                    }
                  : { changed: [], rows: [] }
            }
            beforeSend={mediaModel && !confirm && <MediaPrice model={mediaModel} estimateUsd={estimateUsd} />}
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
        )}
      </div>

      {!workshop && (
        <ChatMargin choice={choice} answers={answers} chat={chat && chat.messages.length ? { id: chat.id, title: chat.title } : null} onDelete={chat ? () => void remove() : null} />
      )}
    </article>
  );
}
