import type { BacklogItem, WorkChanges, WorkStart } from "@artel/shared";
import { useEffect, useState } from "react";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";
import { DiffView } from "../tasks/DiffView";

/**
 * Above the message box of a project task's conversation (docs/specs/project-work.md): what the task changed, "Accept"
 * as one commit, "Roll back the task", and after accepting, the next task of the batch. Writing in the box sends the
 * agent back to work instead.
 */
export function WorkReview({ projectId, itemId, busy, answers }: { projectId: string; itemId: string; busy: boolean; answers: number }) {
  const { api, t, navigate, reloadChats } = useApp();
  const [item, setItem] = useState<BacklogItem | null>(null);
  const [next, setNext] = useState<BacklogItem | null>(null);
  const [changes, setChanges] = useState<WorkChanges | null>(null);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [working, setWorking] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function load() {
    const res = await api.projects[":id"].backlog.$get({ param: { id: projectId } }).catch(() => null);
    if (!res?.ok) return;
    const { items } = (await res.json()) as { items: BacklogItem[] };
    const own = items.find((i) => i.id === itemId) ?? null;
    setItem(own);
    setNext(items.find((i) => i.status === "picked") ?? null);
    if (own?.status === "review") {
      const c = await api.projects[":id"].backlog[":itemId"].changes.$get({ param: { id: projectId, itemId } }).catch(() => null);
      setChanges(c?.ok ? ((await c.json()) as WorkChanges) : null);
    }
  }

  // Again after each answer: the task goes to review once the agent has answered.
  useEffect(() => {
    if (!busy) void load();
  }, [projectId, itemId, busy, answers]);

  async function act(kind: "accept" | "undo") {
    setWorking(true);
    setProblem(null);
    const res =
      kind === "accept"
        ? await api.projects[":id"].backlog[":itemId"].accept.$post({ param: { id: projectId, itemId }, json: {} }).catch(() => null)
        : await api.projects[":id"].backlog[":itemId"].undo.$post({ param: { id: projectId, itemId } }).catch(() => null);
    setWorking(false);
    setConfirmUndo(false);
    const body = (await res?.json().catch(() => null)) as { commit?: string | null; error?: { code?: string } } | null;
    if (!res?.ok) return setProblem(body?.error?.code ?? "unknown");
    setDone(kind === "accept" ? (body?.commit ? t("work.accepted", { commit: body.commit }) : t("work.acceptedEmpty")) : t("work.undone"));
    await load();
  }

  async function goNext() {
    setWorking(true);
    const res = await api.projects[":id"].backlog.next.$post({ param: { id: projectId } }).catch(() => null);
    setWorking(false);
    if (!res?.ok) return setProblem("unknown");
    const started = (await res.json()) as WorkStart;
    await reloadChats();
    navigate({ kind: "chat", chatId: started.chatId, key: started.chatId, send: started.message });
  }

  if (!item) return null;
  const errorText = problem && <p className="error-note">{t(`work.error.${problem}` as MessageKey)}</p>;

  if (item.status === "done" || item.status === "open") {
    return (
      <div className="work-review is-closed" role="status">
        <p>{done ?? t(item.status === "done" ? "work.isDone" : "work.isUndone")}</p>
        {next ? (
          <button className="btn is-primary" disabled={working} onClick={() => void goNext()}>
            {t("work.next", { title: next.title })}
          </button>
        ) : (
          <button className="link" onClick={() => navigate({ kind: "project", projectId })}>
            {t("work.toList")}
          </button>
        )}
        {errorText}
      </div>
    );
  }
  if (item.status !== "review" || busy) return null;

  return (
    <div className="work-review" role="region" aria-label={t("work.title")}>
      <p>
        <strong>{t("work.ready", { title: item.title })}</strong> <span className="muted">{t("work.howTo")}</span>
      </p>
      {changes && changes.files.length > 0 && (
        <details className="work-files">
          <summary>{t("work.files", { n: changes.files.length })}</summary>
          {/* Line by line, as the review of a task always showed it (seen: only file names here). */}
          <div className="work-diff">
            <DiffView files={changes.diff} comments={[]} />
          </div>
        </details>
      )}
      {errorText}
      {confirmUndo ? (
        <div className="actions">
          <span>{t("work.undoConfirm")}</span>
          <button className="btn is-pencil" disabled={working} onClick={() => void act("undo")}>
            {t("work.undo")}
          </button>
          <button className="btn" onClick={() => setConfirmUndo(false)}>
            {t("providers.cancel")}
          </button>
        </div>
      ) : (
        <div className="actions">
          <button className="btn is-primary" disabled={working} onClick={() => void act("accept")}>
            {t("work.accept")}
          </button>
          <button className="btn is-pencil" disabled={working} onClick={() => setConfirmUndo(true)}>
            {t("work.undo")}
          </button>
        </div>
      )}
    </div>
  );
}
