import { CONFIRM_ABOVE_USD } from "@artel/shared";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";
import { formatUsd } from "../../lib/format";

interface Props {
  approval: { id: string; command: string; reason: string; purpose?: string };
  /** Null while nobody answered. */
  allowed: boolean | null;
  always?: boolean;
  /** Present where the question is answered: at the top of the task. The feed only records it. */
  onAnswer?(approvalId: string, allow: boolean, always?: boolean): void;
}

/** A command the agent wants to run and needs the user's word for. */
export function ApprovalCard({ approval, allowed, always = false, onAnswer }: Props) {
  const { t } = useApp();
  const pending = allowed === null;
  return (
    <div className={`approval${pending && onAnswer ? " is-asking" : ""}`} role={pending && onAnswer ? "alert" : undefined}>
      <strong>{t("approval.title")}</strong>
      {approval.purpose && <p className="approval-purpose">{approval.purpose}</p>}
      <span className="muted">{t(`approval.reason.${approval.reason}` as MessageKey, { limit: formatUsd(CONFIRM_ABOVE_USD) })}</span>
      <code className="mono">{approval.command}</code>
      {pending && onAnswer ? (
        <div className="actions">
          <button className="btn is-primary" onClick={() => onAnswer(approval.id, true)}>
            {t("approval.allow")}
          </button>
          {approval.reason === "mcp" && (
            <button className="btn" onClick={() => onAnswer(approval.id, true, true)}>
              {t("approval.always")}
            </button>
          )}
          <button className="btn is-pencil" onClick={() => onAnswer(approval.id, false)}>
            {t("approval.deny")}
          </button>
        </div>
      ) : pending ? (
        <span className="muted">{t("approval.answerAbove")}</span>
      ) : (
        <span className={allowed ? "is-ok" : "is-pencil-text"}>{t(always ? "approval.allowedAlways" : allowed ? "approval.allowed" : "approval.denied")}</span>
      )}
    </div>
  );
}
