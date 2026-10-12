import type { ChatKind, MessageView } from "@artel/shared";
import { useApp } from "../../context";
import { formatTokens, formatUsd } from "../../lib/format";
import { ErrorNote } from "../ErrorNote";
import { Markdown } from "./Markdown";
import { MediaView } from "./MediaView";
import { Reasoning } from "./Reasoning";

export function UserMessage({ content }: { content: string }) {
  const { t } = useApp();
  return (
    <div className="msg msg-user">
      <span className="visually-hidden">{t("chat.you")}</span>
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
  /** What the model searched and read while answering. */
  activity?: string[];
  /** MCP tools asking for permission in this answer. */
  approvals?: ChatApproval[];
  onApprove?(id: string, allow: boolean, always: boolean): void;
}

export interface ChatApproval {
  id: string;
  server: string;
  tool: string;
  input: unknown;
  state: "open" | "allowed" | "denied";
}

export function AssistantMessage({
  content,
  reasoning,
  model,
  streaming,
  message,
  making,
  activity = [],
  approvals = [],
  onApprove,
}: AssistantProps) {
  const { t, settings } = useApp();
  const tokens = (n: number) => formatTokens(n, settings.locale);

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
      {approvals.map((a) => (
        <div key={a.id} className="approval" role={a.state === "open" ? "alert" : undefined}>
          <strong>{t("approval.title")}</strong>
          <span>{t("approval.reason.mcp")}</span>
          <code className="mono">
            {a.server}: {a.tool} {JSON.stringify(a.input)}
          </code>
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
      {content && <Markdown text={content} streaming={streaming} />}
      {message?.media.map((item) => <MediaView key={item.id} item={item} />)}
      {(making || rendering) && (
        <p className="msg-making">
          <span className="action-spinner" aria-hidden />
          {rendering ? t("media.videoWaiting") : t(making === "video" ? "media.videoSending" : "media.drawing")}
        </p>
      )}
      {streaming && !making && !content && !reasoning && <span className="caret" aria-hidden />}
      {message?.status === "stopped" && <p className="msg-flag">{t("chat.stopped")}</p>}
      {message?.error && <ErrorNote error={message.error} />}
      {meta && <p className="msg-meta mono">{meta}</p>}
    </div>
  );
}
