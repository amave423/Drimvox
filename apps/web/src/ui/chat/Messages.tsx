import type { ChatKind, MessageView } from "@artel/shared";
import { useApp } from "../../context";
import { formatTokens, formatUsd } from "../../lib/format";
import { ErrorNote } from "../ErrorNote";
import { Markdown } from "./Markdown";
import { MediaView } from "./MediaView";

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
}

export function AssistantMessage({ content, reasoning, model, streaming, message, making }: AssistantProps) {
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
      {reasoning && (
        <details className="reasoning" open={streaming && !content}>
          <summary>{t("chat.reasoning")}</summary>
          <p>{reasoning}</p>
        </details>
      )}
      {content && <Markdown text={content} />}
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
