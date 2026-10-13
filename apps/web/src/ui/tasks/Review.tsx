import type { DiffFile, TaskView } from "@artel/shared";
import { useEffect, useState } from "react";
import { ok } from "../../api";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";
import { IdentityHelp } from "../projects/ProjectSheet";
import { AcceptanceReport } from "./AcceptanceReport";
import { DiffView, type LineComment } from "./DiffView";

interface Props {
  task: TaskView;
  comments: LineComment[];
  setComments(comments: LineComment[]): void;
}

interface Refusal {
  code: string;
  files: string[];
}

/** The proofreading screen: the agent's summary, its changes, and the decision. */
export function Review({ task, comments, setComments }: Props) {
  const { api, t } = useApp();
  const [diff, setDiff] = useState<DiffFile[] | null>(null);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState(task.commitMessage ?? task.title);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [commit, setCommit] = useState<string | null | undefined>(undefined);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const stuck = task.status === "waiting" && (task.statusReason === "stuck" || task.statusReason === "visual_failed");
  const open = task.status === "review" || task.status === "done_empty" || stuck;

  useEffect(() => {
    setMessage(task.commitMessage ?? task.title);
  }, [task.commitMessage, task.title]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void api.tasks[":id"].diff
      .$get({ param: { id: task.id } })
      .then((r) => ok<DiffFile[]>(r))
      .then((files) => live && setDiff(files))
      .catch(() => live && setDiff([]));
    return () => {
      live = false;
    };
  }, [api, task.id, task.updatedAt, open]);

  async function sendBack() {
    setBusy(true);
    const res = await api.tasks[":id"].feedback
      .$post({ param: { id: task.id }, json: { note: note.trim() || undefined, comments } })
      .catch(() => null);
    setBusy(false);
    if (res?.ok) {
      setComments([]);
      setNote("");
    }
  }

  async function accept() {
    setBusy(true);
    setRefusal(null);
    const res = await api.tasks[":id"].accept.$post({ param: { id: task.id }, json: { message: message.trim() || undefined } }).catch(() => null);
    setBusy(false);
    const body = (await res?.json().catch(() => null)) as { commit?: string | null; error?: Refusal } | null;
    if (res?.ok) setCommit(body?.commit ?? null);
    else setRefusal(body?.error ?? { code: "busy", files: [] });
  }

  async function discard() {
    setBusy(true);
    await api.tasks[":id"].discard.$post({ param: { id: task.id } }).catch(() => null);
    setBusy(false);
  }

  if (task.status === "accepted") {
    return (
      <p className="note is-ok result-note">
        {commit ? t("review.accepted", { commit: commit.slice(0, 7) }) : commit === null ? t("review.acceptedNoCommit") : t("task.status.accepted")}
      </p>
    );
  }
  if (task.status === "discarded") return <p className="note result-note">{t("review.discarded")}</p>;

  const empty = diff !== null && diff.length === 0;
  const team = task.kind === "goal";
  return (
    <section className="review">
      <h2 className="sheet-h">{stuck ? t("review.titleStuck") : empty ? t(team ? "team.reviewEmpty" : "review.empty") : t(team ? "team.reviewTitle" : "review.title")}</h2>
      {task.summary && !stuck && <p className="review-summary">{task.summary}</p>}
      {task.statusReason === "acceptance_partial" && <p className="note is-pencil">{t("acceptance.partial")}</p>}
      {task.statusReason === "milestones_left" && (
        <p className="note">
          {t("review.milestonesLeft", { done: task.milestone - 1, total: task.milestones.length })}{" "}
          {task.milestones
            .slice(task.milestone - 1)
            .map((m) => `«${m.title}»`)
            .join(", ")}
        </p>
      )}
      {task.acceptance && !stuck && <AcceptanceReport report={task.acceptance} requirements={task.requirements} />}
      {!stuck && task.phase !== null && (
        <p className={task.checks.length ? "note is-ok checks-note" : "muted checks-note"}>
          {task.checks.length ? t("review.checksGreen") : t("review.noChecks")}
        </p>
      )}

      {diff && diff.length > 0 && (
        <>
          <p className="muted review-hint">{t("review.commentHint")}</p>
          <DiffView taskId={task.id} files={diff} comments={comments} onComment={(c) => setComments([...comments, c])} />
        </>
      )}

      <div className="review-bar">
        {!stuck && (
        <label className="field">
          <span>{t("review.note")}</span>
          <textarea className="field-input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        )}
        {!empty && (
          <label className="field">
            <span>{t("review.commitMessage")}</span>
            <input className="field-input mono" value={message} onChange={(e) => setMessage(e.target.value)} />
          </label>
        )}

        {refusal && (
          <div className="error-note">
            {refusal.code === "no_identity" ? (
              <IdentityHelp />
            ) : (
              <p>{t(`review.refused.${refusal.code}` as MessageKey)}</p>
            )}
            {refusal.files.length > 0 && (
              <ul className="mono">
                {refusal.files.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="actions">
          {!stuck && (
            <button className="btn is-pencil" disabled={busy || (!note.trim() && comments.length === 0)} onClick={() => void sendBack()}>
              {t("review.return")}
            </button>
          )}
          {!empty && (
            <button className="btn is-primary" disabled={busy || !message.trim()} onClick={() => void accept()}>
              {t("review.accept")}
            </button>
          )}
          <span className="spacer" />
          {confirmDiscard ? (
            <>
              <span className="muted">{t("review.discardConfirm")}</span>
              <button className="btn is-pencil" disabled={busy} onClick={() => void discard()}>
                {t("review.discard")}
              </button>
              <button className="btn" onClick={() => setConfirmDiscard(false)}>
                {t("review.cancel")}
              </button>
            </>
          ) : (
            <button className="link is-pencil" onClick={() => setConfirmDiscard(true)}>
              {t("review.discard")}
            </button>
          )}
        </div>
        {!empty && <p className="muted review-hint">{t("review.acceptHint")}</p>}
      </div>
    </section>
  );
}
