import { CONFIRM_ABOVE_USD } from "@artel/shared";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";
import { exitCodeOf, type FeedItem } from "../../lib/activity";
import { formatUsd } from "../../lib/format";
import { useAuthorizedUrl } from "../../lib/media";
import { Markdown } from "../chat/Markdown";

interface Props {
  items: FeedItem[];
  /** For the screenshots the agent took. */
  taskId: string;
  /** Present while the task waits for an answer. */
  onAnswer?(approvalId: string, allow: boolean, always?: boolean): void;
}

/** The agent's work as one line per action; details open on click. */
export function Feed({ items, onAnswer, taskId }: Props) {
  return (
    <ol className="feed">
      {items.map((item) => (
        <li key={item.seq} className={`feed-${item.kind}`}>
          <FeedLine item={item} onAnswer={onAnswer} taskId={taskId} />
        </li>
      ))}
    </ol>
  );
}

function FeedLine({ item, onAnswer, taskId }: { item: FeedItem; onAnswer?: Props["onAnswer"]; taskId: string }) {
  const { t } = useApp();
  if (item.kind === "screenshot") return <Screenshot taskId={taskId} id={item.id} url={item.url} />;

  if (item.kind === "user") return <p className="feed-bubble">{item.text}</p>;
  if (item.kind === "note") return <p>{item.text}</p>;
  if (item.kind === "status") return <p className="muted">{t(`task.status.${item.status}` as MessageKey)}</p>;
  if (item.kind === "phase") return <p className="feed-step">{t(`feed.phase.${item.phase}` as MessageKey, { round: item.round ?? 1 })}</p>;
  if (item.kind === "milestone") {
    return <p className="feed-step is-ok">{t("feed.milestone", { stage: item.stage, total: item.total, title: item.title })}</p>;
  }
  if (item.kind === "acceptance") {
    return (
      <p className={item.done === item.total ? "feed-step is-ok" : "feed-step is-pencil-text"}>
        {t("feed.acceptance", { done: item.done, total: item.total })} — {item.summary}
      </p>
    );
  }
  if (item.kind === "questions") return <p className="muted">{t("feed.questions", { count: item.questions.length })}</p>;
  if (item.kind === "escalation") return <p className="feed-escalation">{t("feed.escalation", { from: item.from, to: item.to })}</p>;

  if (item.kind === "answers") {
    if (item.skipped) return <p className="muted">{t("feed.answersSkipped")}</p>;
    return (
      <div className="feed-bubble feed-answers">
        <strong>{t("feed.answers")}</strong>
        <ul>
          {item.answers.map((a) => (
            <li key={a.id}>{a.answer}</li>
          ))}
        </ul>
      </div>
    );
  }

  if (item.kind === "subtask") {
    const text = t(`feed.subtask.${item.action}` as MessageKey, { title: item.title, files: item.files.join(", ") });
    return <p className={item.action === "conflict" ? "feed-escalation" : "feed-step"}>{text}</p>;
  }

  if (item.kind === "spec" || item.kind === "plan") {
    const label = item.kind === "plan" ? (item.edited ? "feed.planEdited" : "feed.plan") : item.edited ? "feed.specEdited" : "feed.spec";
    return (
      <details className="action feed-spec">
        <summary>
          <span className="action-label">{t(label)}</span>
        </summary>
        <div className="feed-spec-body">
          <Markdown text={item.spec} />
          {item.kind === "plan" && (
            <ol className="feed-checks">
              {item.subtasks.map((s) => (
                <li key={s.id}>{s.title}</li>
              ))}
            </ol>
          )}
          {item.checks.length > 0 && (
            <ul className="feed-checks mono muted">
              {item.checks.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          )}
        </div>
      </details>
    );
  }

  if (item.kind === "check") {
    const outcome = item.ok ? t("feed.checkOk") : item.exitCode === null ? t("feed.checkTimeout") : t("feed.checkFail", { code: item.exitCode });
    return (
      <details className="action feed-check">
        <summary>
          <span className="action-label mono">{t("feed.check", { command: item.command })}</span>
          <span className={item.ok ? "action-ok" : "action-bad"}>{outcome}</span>
        </summary>
        <pre className="action-output mono">{item.output || "—"}</pre>
      </details>
    );
  }

  if (item.kind === "approval") {
    return (
      <div className="approval" role={item.allowed === null ? "alert" : undefined}>
        <strong>{t("approval.title")}</strong>
        <span>{t(`approval.reason.${item.reason}` as MessageKey, { limit: formatUsd(CONFIRM_ABOVE_USD) })}</span>
        <code className="mono">{item.command}</code>
        {item.allowed === null && onAnswer ? (
          <div className="actions">
            <button className="btn is-primary" onClick={() => onAnswer(item.id, true)}>
              {t("approval.allow")}
            </button>
            {item.reason === "mcp" && (
              <button className="btn" onClick={() => onAnswer(item.id, true, true)}>
                {t("approval.always")}
              </button>
            )}
            <button className="btn is-pencil" onClick={() => onAnswer(item.id, false)}>
              {t("approval.deny")}
            </button>
          </div>
        ) : (
          item.allowed !== null && (
            <span className={item.allowed ? "is-ok" : "is-pencil-text"}>
              {t(item.always ? "approval.allowedAlways" : item.allowed ? "approval.allowed" : "approval.denied")}
            </span>
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
          : item.name === "web_search"
            ? input.query
            : item.name === "open_page" || item.name === "look_at_page"
              ? input.url
              : item.name === "start_background"
                ? input.command
                : item.name === "read_background" || item.name === "stop_background"
                  ? String((item.input as { id?: unknown }).id ?? "")
              : item.name === "use_skill"
                ? input.name
                : item.name === "read_skill_file"
                  ? `${input.name}/${input.path}`
                  : input.path;
  const mcp = item.name.includes("/");
  const known = ["read_file", "list_files", "search", "write_file", "edit_file", "run_command", "generate_image", "web_search", "open_page", "use_skill", "read_skill_file", "start_background", "read_background", "stop_background", "look_at_page"].includes(
    item.name,
  );
  const label = mcp
    ? t("action.mcp", { target: item.name })
    : known
      ? t(`action.${item.name}` as MessageKey, { target: target ?? "" })
      : item.name;

  let outcome: { text: string; bad: boolean } | null = null;
  if (item.result && !item.result.ok && item.result.output.startsWith("The user denied")) {
    outcome = { text: t("action.denied"), bad: true };
  } else if (item.result && item.name === "run_command") {
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

/** What the agent saw: a screenshot of a page, opened full size on click. */
function Screenshot({ taskId, id, url }: { taskId: string; id: string; url: string }) {
  const { t, token } = useApp();
  const src = useAuthorizedUrl(`/api/tasks/${taskId}/screenshots/${id}`, token);
  return (
    <figure className="feed-shot">
      <figcaption className="muted">{t("feed.screenshot", { url })}</figcaption>
      {src ? (
        <a href={src} target="_blank" rel="noreferrer">
          <img src={src} alt={t("feed.screenshot", { url })} />
        </a>
      ) : (
        <div className="media-wait" aria-busy />
      )}
    </figure>
  );
}
