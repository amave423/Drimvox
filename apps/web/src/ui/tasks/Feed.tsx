import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";
import { exitCodeOf, type FeedItem } from "../../lib/activity";

interface Props {
  items: FeedItem[];
  /** Present while the task waits for an answer. */
  onAnswer?(approvalId: string, allow: boolean): void;
}

/** The agent's work as one line per action; details open on click. */
export function Feed({ items, onAnswer }: Props) {
  return (
    <ol className="feed">
      {items.map((item) => (
        <li key={item.seq} className={`feed-${item.kind}`}>
          <FeedLine item={item} onAnswer={onAnswer} />
        </li>
      ))}
    </ol>
  );
}

function FeedLine({ item, onAnswer }: { item: FeedItem; onAnswer?: Props["onAnswer"] }) {
  const { t } = useApp();

  if (item.kind === "user") return <p className="feed-bubble">{item.text}</p>;
  if (item.kind === "note") return <p>{item.text}</p>;
  if (item.kind === "status") return <p className="muted">{t(`task.status.${item.status}` as MessageKey)}</p>;

  if (item.kind === "approval") {
    return (
      <div className="approval" role={item.allowed === null ? "alert" : undefined}>
        <strong>{t("approval.title")}</strong>
        <span>{t(`approval.reason.${item.reason}` as MessageKey)}</span>
        <code className="mono">{item.command}</code>
        {item.allowed === null && onAnswer ? (
          <div className="actions">
            <button className="btn is-primary" onClick={() => onAnswer(item.id, true)}>
              {t("approval.allow")}
            </button>
            <button className="btn is-pencil" onClick={() => onAnswer(item.id, false)}>
              {t("approval.deny")}
            </button>
          </div>
        ) : (
          item.allowed !== null && (
            <span className={item.allowed ? "is-ok" : "is-pencil-text"}>{t(item.allowed ? "approval.allowed" : "approval.denied")}</span>
          )
        )}
      </div>
    );
  }

  const input = item.input as Record<string, string | undefined>;
  const target =
    item.name === "run_command"
      ? input.command
      : item.name === "search"
        ? input.pattern
        : item.name === "list_files"
          ? (input.path ?? ".")
          : input.path;
  const known = ["read_file", "list_files", "search", "write_file", "edit_file", "run_command"].includes(item.name);
  const label = known ? t(`action.${item.name}` as MessageKey, { target: target ?? "" }) : item.name;

  let outcome: { text: string; bad: boolean } | null = null;
  if (item.result && item.name === "run_command") {
    const code = exitCodeOf(item.result.output);
    outcome = code === null ? { text: t("action.timeout"), bad: true } : { text: t("action.exit", { code }), bad: code !== 0 };
  } else if (item.result && !item.result.ok) {
    outcome = { text: t("action.failed"), bad: true };
  }

  return (
    <details className="action">
      <summary>
        <span className={`action-label${item.name === "run_command" ? " mono" : ""}`}>{label}</span>
        {!item.result && <span className="action-spinner" aria-hidden />}
        {outcome && <span className={outcome.bad ? "action-bad" : "action-ok"}>{outcome.text}</span>}
      </summary>
      {item.result && <pre className="action-output mono">{item.result.output}</pre>}
    </details>
  );
}
