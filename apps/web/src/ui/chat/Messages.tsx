import type { MessageKey } from "../../i18n";
import type { ChatKind, MessageView } from "@drimvox/shared";
import type { ReactNode } from "react";
import { useApp } from "../../context";
import { useSmoothText } from "../../lib/smooth";
import { formatTokens, formatUsd } from "../../lib/format";
import { ErrorNote } from "../ErrorNote";
import { Markdown } from "./Markdown";
import { MediaView } from "./MediaView";
import { Reasoning } from "./Reasoning";

export function UserMessage({ content, files }: { content: string; files?: ReactNode }) {
  const { t } = useApp();
  return (
    <div className="msg msg-user">
      <span className="visually-hidden">{t("chat.you")}</span>
      {files}
      <p>{content}</p>
    </div>
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
  /** What the model searched and read while answering. */
  activity?: string[];
  /** What a saved answer did, folded under one line. */
  done?: string[];
  /** MCP tools asking for permission in this answer. */
  approvals?: ChatApproval[];
  onApprove?(id: string, allow: boolean, always: boolean): void;
  /** Puts the chat's folder back as it was before this answer. */
  onUndo?(): void;
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
  activity = [],
  done = [],
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
      {activity.length > 0 && (
        <ul className="msg-activity muted">
          {activity.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
      {done.length > 0 && (
        <details className="msg-done muted">
          <summary>{t("msg.actions", { n: done.length })}</summary>
          <ul className="msg-activity">
            {done.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </details>
      )}
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
      {shown && <Markdown text={shown} streaming={streaming} />}
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
      {meta && <p className="msg-meta mono">{meta}</p>}
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
