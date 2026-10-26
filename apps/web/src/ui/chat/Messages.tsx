import type { MessageKey } from "../../i18n";
import type { ChatKind, MessageView } from "@drimvox/shared";
import { useState, type ReactNode } from "react";
import { PencilIcon } from "../SideChats";
import { MessageText } from "./LinkedText";
import { SpeakButton } from "./Voice";
import { useApp } from "../../context";
import { useSmoothText } from "../../lib/smooth";
import { formatTokens, formatUsd } from "../../lib/format";
import { ErrorNote } from "../ErrorNote";
import { Markdown } from "./Markdown";
import { MediaView } from "./MediaView";
import { ZoomableImage } from "../Lightbox";
import { AuthImage, ShotGallery, useShots } from "../ShotGallery";
import { useAuthorizedUrl } from "../../lib/media";
import { Reasoning } from "./Reasoning";

/**
 * The user's message. It can be edited in place: the answer is written again on a branch of its own, and the arrows
 * switch between the versions (asked for: like in other chats).
 */
export function UserMessage({
  content,
  files,
  versions,
  onEdit,
  onVersion,
}: {
  content: string;
  files?: ReactNode;
  versions?: MessageView["versions"];
  onEdit?(text: string): void;
  onVersion?(id: string): void;
}) {
  const { t } = useApp();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(content);
  if (editing && onEdit) {
    // As in other chats: the message becomes a box with the text and the buttons inside, the same width every time.
    return (
      <form
        className="msg-editing"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          setEditing(false);
          onEdit(text.trim());
        }}
      >
        {files}
        <textarea
          aria-label={t("msg.editLabel")}
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setEditing(false);
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="msg-editing-actions">
          <button type="button" className="btn" onClick={() => setEditing(false)}>
            {t("providers.cancel")}
          </button>
          <button className="btn is-primary" disabled={!text.trim()}>
            {t("msg.editSend")}
          </button>
        </div>
      </form>
    );
  }
  return (
    <div className="msg-user-wrap">
      <div className="msg msg-user">
        <span className="visually-hidden">{t("chat.you")}</span>
        {files}
        <p>
          <MessageText text={content} />
        </p>
      </div>
      {/* Under the message, as in other chats: edit it, and the versions it has. */}
      {(onEdit || (versions && onVersion)) && (
        <div className="msg-user-tools">
          {onEdit && (
            <button
              type="button"
              className="msg-tool"
              aria-label={t("msg.edit")}
              title={t("msg.edit")}
              onClick={() => {
                setText(content);
                setEditing(true);
              }}
            >
              <PencilIcon />
            </button>
          )}
          {versions && onVersion && (
            <span className="msg-versions">
              <button type="button" className="msg-tool" aria-label={t("msg.versionPrev")} disabled={versions.index === 0} onClick={() => onVersion(versions.ids[versions.index - 1]!)}>
                <Chevron left />
              </button>
              <span className="msg-versions-count">
                {versions.index + 1} / {versions.count}
              </span>
              <button type="button" className="msg-tool" aria-label={t("msg.versionNext")} disabled={versions.index === versions.count - 1} onClick={() => onVersion(versions.ids[versions.index + 1]!)}>
                <Chevron />
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function Chevron({ left = false }: { left?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={left ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"} />
    </svg>
  );
}

interface AssistantProps {
  content: string;
  reasoning: string | null;
  model: string | null;
  streaming?: boolean;
  message?: MessageView;
  /** Shown while a picture or a clip is being made. */
  making?: ChatKind;
  /** The chat's kind: what an answer still being written is waiting for (a text, a picture, a clip). */
  kind?: ChatKind;
  /** What the model did while answering, each where it happened in the text (screenshots of pages among them). */
  actions?: AnswerAction[];
  /** MCP tools asking for permission in this answer. */
  approvals?: ChatApproval[];
  onApprove?(id: string, allow: boolean, always: boolean, server?: boolean): void;
  /** Puts the chat's folder back as it was before this answer. */
  onUndo?(): void;
}

/** One thing the model did, as the answer shows it. */
export interface AnswerAction {
  /** "Reads app.js", "Searches: …". */
  line: string;
  /** Where in the text it happened; actions of answers saved before this was kept come first. */
  at?: number;
  /** A screenshot of a page: its address to show it. */
  shot?: string;
}

export interface ChatApproval {
  id: string;
  server: string;
  tool: string;
  input: unknown;
  /** A command in the chat's folder: why it asks (approval.reason.*); none for an MCP tool. */
  reason?: string;
  /** What the command does, in the model's words. */
  purpose?: string;
  state: "open" | "allowed" | "denied";
}

export function AssistantMessage({
  content,
  reasoning,
  model,
  streaming,
  message,
  making,
  kind,
  actions = [],
  approvals = [],
  onApprove,
  onUndo,
}: AssistantProps) {
  const { t, settings } = useApp();
  const tokens = (n: number) => formatTokens(n, settings.locale);
  // Letter by letter while it is written, at the speed it comes.
  const shown = useSmoothText(content, !!streaming);

  let meta: string | null = null;
  if (message && message.inputTokens !== null && message.outputTokens !== null) {
    const vars = { input: tokens(message.inputTokens), output: tokens(message.outputTokens) };
    meta =
      message.costUsd === null
        ? t("msg.metaNoCost", vars)
        : message.costUsd === 0
          ? t("msg.metaFree", vars)
          : t("msg.meta", { ...vars, cost: formatUsd(message.costUsd) });
  } else if (message && message.media.length > 0) {
    meta = message.costUsd === null ? t("msg.metaMediaNoCost") : t("msg.metaMedia", { cost: formatUsd(message.costUsd) });
  }
  // A clip keeps its answer open for minutes after the request itself has ended.
  // Still being written, seen from a window that did not send it (or after coming back to the chat).
  const rendering = message?.status === "streaming";

  return (
    <div className={`msg msg-assistant${streaming ? " is-streaming" : ""}`} aria-busy={streaming}>
      {model && <div className="msg-who mono">{model}</div>}
      {approvals.map((a) => (
        <div key={a.id} className="approval" role={a.state === "open" ? "alert" : undefined}>
          <strong>{t("approval.title")}</strong>
          {a.purpose && <p className="approval-purpose">{a.purpose}</p>}
          <span className="muted">{t(`approval.reason.${a.reason ?? "mcp"}` as MessageKey)}</span>
          <code className="mono">{a.reason ? a.tool : `${a.server}: ${a.tool} ${JSON.stringify(a.input)}`}</code>
          {a.state === "open" && onApprove ? (
            <div className="actions">
              <button className="btn is-primary" onClick={() => onApprove(a.id, true, false)}>
                {t("approval.allow")}
              </button>
              <button className="btn" onClick={() => onApprove(a.id, true, true)}>
                {t("approval.always")}
              </button>
              {/* A server's tools one by one asked again and again (seen: a browser server has twenty of them). */}
              {!a.reason && a.server && (
                <button className="btn" onClick={() => onApprove(a.id, true, true, true)}>
                  {t("approval.server", { server: a.server })}
                </button>
              )}
              <button className="btn is-pencil" onClick={() => onApprove(a.id, false, false)}>
                {t("approval.deny")}
              </button>
            </div>
          ) : (
            <span className={a.state === "allowed" ? "is-ok" : "is-pencil-text"}>{t(a.state === "allowed" ? "approval.allowed" : "approval.denied")}</span>
          )}
        </div>
      ))}
      {reasoning && <Reasoning text={reasoning} thinking={!!streaming && !content} />}
      <AnswerFlow text={shown} actions={actions} streaming={!!streaming} live={!!streaming || rendering} />
      {message?.media.map((item) => <MediaView key={item.id} item={item} />)}
      {/* An answer followed live shows its own caret and words; "answering" is for one only known to be under way. */}
      {(making || (rendering && !streaming)) && (
        <p className="msg-making">
          <span className="action-spinner" aria-hidden />
          {rendering
            ? t(kind === "video" ? "media.videoWaiting" : kind === "image" ? "media.drawing" : "chat.answering")
            : t(making === "video" ? "media.videoSending" : "media.drawing")}
        </p>
      )}
      {streaming && !making && !content && !reasoning && <span className="caret" aria-hidden />}
      {message?.status === "stopped" && <p className="msg-flag">{t("chat.stopped")}</p>}
      {message?.error && <ErrorNote error={message.error} />}
      {(meta || (!streaming && content)) && (
        <div className="msg-foot">
          {meta && <p className="msg-meta mono">{meta}</p>}
          {!streaming && content && <SpeakButton text={content} />}
        </div>
      )}
      {message?.canUndo && onUndo && (
        <div className="actions">
          <button className="btn" onClick={onUndo} title={t("folder.undoHint")}>
            {t("folder.undo")}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The answer in order, the way a coding agent shows its work: what the model said, the actions it did then (folded
 * into one line), what it said next (seen: actions piled on top and the text jumping down with each new one). An action
 * shows once the text has come as far as where it happened.
 */
function AnswerFlow({ text, actions, streaming, live }: { text: string; actions: AnswerAction[]; streaming: boolean; live: boolean }) {
  const parts: ({ kind: "text"; text: string } | { kind: "actions"; actions: AnswerAction[] })[] = [];
  let pos = 0;
  for (const action of actions) {
    const at = Math.min(action.at ?? 0, text.length);
    if ((action.at ?? 0) > text.length) break;
    if (at > pos) {
      parts.push({ kind: "text", text: text.slice(pos, at) });
      pos = at;
    }
    const last = parts.at(-1);
    if (last?.kind === "actions") last.actions.push(action);
    else parts.push({ kind: "actions", actions: [action] });
  }
  if (pos < text.length) parts.push({ kind: "text", text: text.slice(pos) });
  return (
    <>
      {parts.map((part, i) =>
        part.kind === "text" ? (
          part.text.trim() && <Markdown key={i} text={part.text} streaming={streaming && i === parts.length - 1} />
        ) : (
          <ActionGroup key={i} actions={part.actions} open={live && i === parts.length - 1} />
        ),
      )}
    </>
  );
}

/** Actions done in a row: one line saying how many and the latest, opened while it is the newest of an answer. */
function ActionGroup({ actions, open }: { actions: AnswerAction[]; open: boolean }) {
  const { t } = useApp();
  const lines = actions.filter((a) => !a.shot);
  const shots = actions.filter((a) => a.shot);
  return (
    <>
      {lines.length > 0 && (
        <details className="msg-done muted" open={open || undefined}>
          <summary>
            {lines.length === 1 ? lines[0]!.line : t("msg.actionsLatest", { n: lines.length, latest: lines.at(-1)!.line })}
          </summary>
          {lines.length > 1 && (
            <ul className="msg-activity">
              {lines.map((a, i) => (
                <li key={i}>{a.line}</li>
              ))}
            </ul>
          )}
        </details>
      )}
      {shots.length > 0 && (
        <div className="msg-shots">
          {shots.map((a, i) => (
            <ShotImage key={i} url={a.shot!} />
          ))}
        </div>
      )}
    </>
  );
}

/** A screenshot; a click opens it among all of the conversation's, to go through them with the arrows. */
function ShotImage({ url }: { url: string }) {
  const { t } = useApp();
  const all = useShots();
  const [open, setOpen] = useState<number | null>(null);
  const shots = all.some((s) => s.url === url) ? all : [{ url }];
  return (
    <>
      <button type="button" className="zoomable" aria-label={t("viewer.open", { name: t("msg.screenshot") })} onClick={() => setOpen(shots.findIndex((s) => s.url === url))}>
        <AuthImage className="msg-shot" url={url} alt={t("msg.screenshot")} />
      </button>
      {open !== null && <ShotGallery shots={shots} start={open} onClose={() => setOpen(null)} />}
    </>
  );
}
