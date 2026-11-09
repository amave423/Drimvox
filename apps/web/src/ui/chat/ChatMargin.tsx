import { useState, type RefObject } from "react";
import { useApp } from "../../context";
import { authHeaders } from "../../api";
import { formatTokens, formatUsd } from "../../lib/format";
import type { ModelChoice } from "../../lib/lastModel";
import { SubscriptionLimits } from "../providers/SubscriptionLimits";
import { filesOf, type ActivityEntry } from "@drimvox/shared";
import { ModelNote, useModelInfo } from "./ModelNote";
import { MessageJump } from "./MessageRail";
import { FileViewer } from "./FileChips";

interface Answer {
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  contextTokens?: number | null;
  activity: ActivityEntry[];
}

/**
 * The chat's margin, laid out like the "console" design (asked for): how full the model's context is, the model and its
 * price, the files the chat worked with, what the chat cost, saving and deleting it; below, the user's messages to jump to.
 */
export function ChatMargin({
  choice,
  answers,
  chat,
  onDelete,
  own,
  list,
}: {
  choice: ModelChoice | null;
  answers: Answer[];
  chat: { id: string; title: string | null; folder: string | null } | null;
  onDelete: (() => void) | null;
  own: string[];
  list: RefObject<HTMLDivElement | null>;
}) {
  const { t, settings, providers, token } = useApp();
  const [saved, setSaved] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const model = useModelInfo(choice);

  /** Markdown from the core, saved as a file (asked for: export a chat). */
  async function exportMarkdown() {
    if (!chat) return;
    const res = await fetch(`/api/chats/${chat.id}/export.md?you=${encodeURIComponent(t("chat.you"))}`, { headers: authHeaders(token) }).catch(() => null);
    if (!res?.ok) return;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(await res.blob());
    link.download = `${(chat.title ?? "chat").replace(/[\\/:*?"<>|]+/g, " ").slice(0, 80)}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  }

  /** The chat as it shows, as a PDF: the desktop saves it, a browser prints it. */
  async function exportPdf() {
    if (!chat) return;
    document.documentElement.classList.add("is-printing");
    try {
      if (window.drimvox?.savePdf) {
        const path = await window.drimvox.savePdf(chat.title ?? "chat");
        if (path) setSaved(path);
      } else window.print();
    } finally {
      document.documentElement.classList.remove("is-printing");
    }
  }
  const [confirmDelete, setConfirmDelete] = useState(false);
  const spent = answers.reduce((sum, m) => sum + (m.costUsd ?? 0), 0);
  const tokens = answers.reduce((sum, m) => sum + (m.inputTokens ?? 0) + (m.outputTokens ?? 0), 0);
  const unpriced = answers.some((m) => m.costUsd === null && m.outputTokens !== null);
  const subscription = !!choice && providers.find((p) => p.id === choice.providerId)?.billing === "subscription";
  // How full the context is: what the latest answer's last step sent and got back, against the model's window (seen: the
  // sum over an answer's 43 steps showed 1.6 million tokens, far past a window the context never filled). An older answer
  // without it counts whole only when it took one step; otherwise the bar waits for the next answer.
  const last = answers.findLast((m) => m.inputTokens !== null);
  const used = !last ? 0 : (last.contextTokens ?? (last.activity.length ? null : (last.inputTokens ?? 0) + (last.outputTokens ?? 0)));
  const files = chat?.folder ? filesOf(answers.flatMap((m) => m.activity)) : [];

  return (
    // Sticks to the top while the conversation scrolls, so these stay within reach.
    <aside className="margin chat-margin">
      {model?.contextLength && used !== null && (
        <section className="margin-sec" aria-label={t("margin.context")}>
          <h3 className="margin-label">{t("margin.context")}</h3>
          <div className="context-bar" role="meter" aria-valuemin={0} aria-valuemax={model.contextLength} aria-valuenow={Math.min(used, model.contextLength)} aria-label={t("margin.context")}>
            <span style={{ width: `${Math.min(100, (used / model.contextLength) * 100)}%` }} />
          </div>
          <p className="mono margin-figure">{t("margin.contextUsed", { used: formatTokens(used, settings.locale), of: formatTokens(model.contextLength, settings.locale) })}</p>
        </section>
      )}
      {choice && model && (
        <section className="margin-sec">
          <h3 className="margin-label">{t("margin.model")}</h3>
          <ModelNote choice={choice} model={model} />
        </section>
      )}
      {choice && subscription && (
        <section className="margin-sec">
          <h3 className="margin-label">{t("limits.title")}</h3>
          <SubscriptionLimits providerId={choice.providerId} seen={answers.length} />
        </section>
      )}
      {files.length > 0 && chat && (
        <section className="margin-sec">
          <h3 className="margin-label">{t("margin.files")}</h3>
          <ul className="margin-files">
            {files.map((f) => (
              <li key={f.path}>
                <button type="button" className="link" title={t("files.open", { path: f.path })} onClick={() => setViewing(f.path)}>
                  <span className="mono">{f.path}</span>
                </button>{" "}
                <span className={`file-touch is-${f.touch}`}>{t(`files.touch.${f.touch}`)}</span>
              </li>
            ))}
          </ul>
          {viewing && <FileViewer chatId={chat.id} path={viewing} onClose={() => setViewing(null)} />}
        </section>
      )}
      {answers.length > 0 && (
        <p className="margin-sec mono margin-figure">
          {tokens === 0 ? t("chat.totalsCost", { cost: formatUsd(spent) }) : t("chat.totals", { cost: formatUsd(spent), tokens: formatTokens(tokens, settings.locale) })}
          {unpriced && (
            <>
              <br />
              <span className="muted">{t("chat.totalsUnpriced")}</span>
            </>
          )}
        </p>
      )}
      {chat && (
        <p className="chat-export">
          <span className="muted">{t("chat.export")}</span>{" "}
          <button className="link" onClick={() => void exportMarkdown()}>
            Markdown
          </button>{" "}
          <button className="link" onClick={() => void exportPdf()}>
            PDF
          </button>
          {saved && <span className="muted chat-export-saved">{t("chat.exportSaved", { path: saved })}</span>}
        </p>
      )}
      {onDelete &&
        (confirmDelete ? (
          <div className="margin-sec is-pencil delete-confirm">
            <p>{t("chat.deleteConfirm")}</p>
            <div className="actions">
              <button className="btn is-pencil" onClick={onDelete}>
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
      <MessageJump texts={own} list={list} />
    </aside>
  );
}
