import { useState } from "react";
import { useApp } from "../../context";
import { formatTokens, formatUsd } from "../../lib/format";
import type { ModelChoice } from "../../lib/lastModel";
import { SubscriptionLimits } from "../providers/SubscriptionLimits";
import { ModelNote } from "./ModelNote";

interface Answer {
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** The chat's margin: the model, what is left of a subscription, what the chat cost, and deleting it. */
export function ChatMargin({ choice, answers, onDelete }: { choice: ModelChoice | null; answers: Answer[]; onDelete: (() => void) | null }) {
  const { t, settings, providers } = useApp();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const spent = answers.reduce((sum, m) => sum + (m.costUsd ?? 0), 0);
  const tokens = answers.reduce((sum, m) => sum + (m.inputTokens ?? 0) + (m.outputTokens ?? 0), 0);
  const unpriced = answers.some((m) => m.costUsd === null && m.outputTokens !== null);
  const subscription = !!choice && providers.find((p) => p.id === choice.providerId)?.billing === "subscription";

  return (
    // Sticks to the top while the conversation scrolls, so these stay within reach.
    <aside className="margin chat-margin">
      {choice && <ModelNote choice={choice} />}
      {choice && subscription && (
        <div className="note">
          <strong>{t("limits.title")}</strong>
          <SubscriptionLimits providerId={choice.providerId} seen={answers.length} />
        </div>
      )}
      {answers.length > 0 && (
        <p className="note">
          {tokens === 0 ? t("chat.totalsCost", { cost: formatUsd(spent) }) : t("chat.totals", { cost: formatUsd(spent), tokens: formatTokens(tokens, settings.locale) })}
          {unpriced && (
            <>
              <br />
              <span className="muted">{t("chat.totalsUnpriced")}</span>
            </>
          )}
        </p>
      )}
      {onDelete &&
        (confirmDelete ? (
          <div className="note is-pencil delete-confirm">
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
    </aside>
  );
}
