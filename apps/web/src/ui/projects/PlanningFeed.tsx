import type { ProjectPlan, ProjectWorkView, Question, TaskEvent } from "@drimvox/shared";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useApp } from "../../context";
import { Markdown } from "../chat/Markdown";
import { LookSample } from "../tasks/Design";
import { useTaskStream } from "../tasks/useTaskStream";
import { PlanDetails } from "./PlanDetails";
import { ProjectComposer } from "./ProjectComposer";

/** A long project needs more than one task's budget: at least this much, in dollars, unless the settings say more. */
const MIN_BUDGET_USD = 1;
const DEFAULT_HOURS = 2;

/**
 * The interview and the plan in the project's conversation, as in the design agreed on (variant A, asked for: they
 * opened as pages of their own). The task, the agent's questions as a card with choices, the answers, the plan as a
 * card with "Start work" and "Correct the plan", all on the same timeline as the work after them; the box stays below.
 */
export function PlanningFeed({ work, onChanged }: { work: ProjectWorkView; onChanged(): void }) {
  const { t, settings } = useApp();
  const { task, events } = useTaskStream(work.planTaskId!);
  const box = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const shown = events.filter((e) => KINDS.has(e.kind) && !(e.kind === "user" && e.data?.drimvox));
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [shown.length, task?.status]);
  const time = (at: number) => new Date(at).toLocaleTimeString(settings.locale, { hour: "2-digit", minute: "2-digit" });
  const row = (key: string | number, at: number, node: ReactNode, done = false) => (
    <div className={`tl-item${done ? " is-done" : ""}`} key={key}>
      <time className="tl-time mono">{time(at)}</time>
      {node}
    </div>
  );
  const waiting = task?.status === "waiting" && task.statusReason === "questions" && task.questions.length > 0;
  const lastQuestions = [...shown].reverse().find((e) => e.kind === "questions");
  const lastPlan = [...shown].reverse().find((e) => e.kind === "project_plan");
  const thinking = work.status === "planning" && !waiting && task?.status !== "failed";

  return (
    <div className="workshop-feed">
      <article className="workshop-chat">
        <div className="workshop-chat-body">
          <div className="messages timeline planning-feed">
            {shown.map((e) => {
              if (e.kind === "user") return row(e.seq, e.createdAt, <div className="msg-user">{String(e.data?.text ?? "")}</div>);
              if (e.kind === "text") return row(e.seq, e.createdAt, <div className="planning-say">{<Markdown text={String(e.data?.text ?? "")} />}</div>, true);
              if (e.kind === "answers") {
                const said = (e.data?.answers ?? []) as { answer: string }[];
                const text = said.length ? said.map((a) => a.answer).join(" · ") : t("planning.skipped");
                return row(e.seq, e.createdAt, <div className="msg-user">{text}</div>);
              }
              if (e.kind === "questions") {
                const live = waiting && e === lastQuestions && task;
                return row(
                  e.seq,
                  e.createdAt,
                  live ? (
                    <QuestionsCard key={task.updatedAt} taskId={task.id} questions={task.questions} />
                  ) : (
                    <AskedCard questions={(e.data?.questions ?? []) as Question[]} />
                  ),
                  !live,
                );
              }
              if (e.kind === "project_plan") {
                const live = e === lastPlan && work.status === "ready";
                return row(
                  e.seq,
                  e.createdAt,
                  <PlanCardInline
                    plan={e.data as ProjectPlan}
                    work={work}
                    live={live}
                    onChanged={onChanged}
                    onFix={() => box.current?.querySelector("textarea")?.focus()}
                  />,
                  !live,
                );
              }
              return null;
            })}
            {thinking &&
              row(
                "thinking",
                Date.now(),
                <p className="msg-thinking muted">{t(lastQuestions || task?.phase === "list" ? "planning.writingPlan" : "planning.thinking")}</p>,
              )}
            {task?.status === "failed" && row("failed", task.updatedAt, <p className="error-note">{t("planning.failed")}</p>)}
            <div ref={end} />
          </div>
          {/* The box stays below, as in the work: it corrects the plan once there is one. */}
          <div className="planning-box" ref={box}>
            <ProjectComposer projectId={work.projectId} work={work} onSent={onChanged} />
          </div>
        </div>
      </article>
    </div>
  );
}

const KINDS = new Set<TaskEvent["kind"]>(["user", "text", "questions", "answers", "project_plan"]);

type Choice = { kind: "option"; index: number } | { kind: "custom"; text: string };

/** The agent's questions to answer: each with its options as choices, the recommended one already picked. */
function QuestionsCard({ taskId, questions }: { taskId: string; questions: Question[] }) {
  const { api, t } = useApp();
  const [choices, setChoices] = useState<Record<string, Choice>>(() =>
    Object.fromEntries(
      questions.map((q): [string, Choice] =>
        q.options.length > 0 && q.recommended !== null ? [q.id, { kind: "option", index: q.recommended }] : [q.id, { kind: "custom", text: "" }],
      ),
    ),
  );
  const [busy, setBusy] = useState(false);
  const set = (id: string, c: Choice) => setChoices((all) => ({ ...all, [id]: c }));
  const answerOf = (q: Question): string | null => {
    const c = choices[q.id];
    if (!c) return null;
    if (c.kind === "custom") return c.text.trim() || null;
    const o = q.options[c.index];
    return o ? o.label : null;
  };
  const answered = questions.flatMap((q) => {
    const answer = answerOf(q);
    return answer ? [{ id: q.id, answer }] : [];
  });

  async function send(enough: boolean) {
    setBusy(true);
    await api.tasks[":id"].answers.$post({ param: { id: taskId }, json: { answers: answered, enough } }).catch(() => null);
    setBusy(false);
  }

  return (
    <div className="planning-turn">
      <p>{t("planning.askLead")}</p>
      <section className="planning-card" aria-label={t("planning.questionsTitle")}>
        <h3>{t("planning.questionsTitle")}</h3>
        <p className="planning-sub">{t("planning.askHint")}</p>
        {questions.map((q) => {
          const c = choices[q.id];
          const picked = c?.kind === "option" ? q.options[c.index] : undefined;
          return (
            <fieldset key={q.id} className="planning-question">
              <legend>{q.question}</legend>
              <div className="planning-chips" role="radiogroup" aria-label={q.question}>
                {q.options.map((o, i) => (
                  <button
                    key={i}
                    type="button"
                    role="radio"
                    aria-checked={c?.kind === "option" && c.index === i}
                    className={`planning-chip${c?.kind === "option" && c.index === i ? " is-on" : ""}`}
                    title={o.description ?? undefined}
                    onClick={() => set(q.id, { kind: "option", index: i })}
                  >
                    {o.label}
                  </button>
                ))}
                {q.options.length > 0 && (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={c?.kind === "custom"}
                    className={`planning-chip${c?.kind === "custom" ? " is-on" : ""}`}
                    onClick={() => set(q.id, { kind: "custom", text: c?.kind === "custom" ? c.text : "" })}
                  >
                    {t("interview.custom")}
                  </button>
                )}
              </div>
              {picked?.description && <small className="planning-why">{picked.description}</small>}
              {picked?.look && <LookSample look={picked.look} />}
              {c?.kind === "custom" && (
                <input
                  className="field-input"
                  autoFocus={q.options.length > 0}
                  placeholder={t(q.options.length ? "interview.customPlaceholder" : "interview.openPlaceholder")}
                  aria-label={`${q.question} — ${t("interview.custom")}`}
                  value={c.text}
                  onChange={(e) => set(q.id, { kind: "custom", text: e.target.value })}
                />
              )}
            </fieldset>
          );
        })}
        <div className="planning-actions">
          <button type="button" className="btn is-primary" disabled={busy || answered.length < questions.length} onClick={() => void send(false)}>
            {t("interview.send")}
          </button>
          <button type="button" className="btn" disabled={busy} title={t("interview.decideHint")} onClick={() => void send(true)}>
            {t("planning.skip")}
          </button>
        </div>
      </section>
    </div>
  );
}

/** Questions already answered: what was asked, quietly. */
function AskedCard({ questions }: { questions: Question[] }) {
  const { t } = useApp();
  if (questions.length === 0) return <p className="muted">{t("planning.nothingToAsk")}</p>;
  return (
    <section className="planning-card is-past" aria-label={t("planning.questionsTitle")}>
      <h3>{t("planning.questionsTitle")}</h3>
      <ul>
        {questions.map((q) => (
          <li key={q.id}>{q.question}</li>
        ))}
      </ul>
    </section>
  );
}

/** The plan in the conversation: what we build, its steps, "Start work" and "Correct the plan". */
function PlanCardInline({ plan, work, live, onChanged, onFix }: { plan: ProjectPlan; work: ProjectWorkView; live: boolean; onChanged(): void; onFix(): void }) {
  const { api, t, settings, reloadChats } = useApp();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function go() {
    setBusy(true);
    setFailed(false);
    const budgetUsd = Math.max(settings.agentBudgetUsd, MIN_BUDGET_USD);
    const res = await api.projects[":id"].work.start.$post({ param: { id: work.projectId }, json: { budgetUsd, hours: DEFAULT_HOURS } }).catch(() => null);
    setBusy(false);
    if (!res?.ok) return setFailed(true);
    await reloadChats();
    onChanged();
  }

  return (
    <section className={`planning-card is-plan${live ? "" : " is-past"}`} aria-label={t("projectWork.planTitle")}>
      <h3>{t("planning.planTitle")}</h3>
      <p className="planning-sub">{plan.context}</p>
      {(plan.steps ?? []).length > 0 && (
        <ol className="planning-steps">
          {plan.steps!.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      )}
      <details className="planning-more">
        <summary>{t("planning.more")}</summary>
        <PlanDetails plan={plan} />
      </details>
      {live && (
        <>
          <div className="planning-actions">
            <button type="button" className="btn is-primary" disabled={busy} onClick={() => void go()}>
              {t("projectWork.go")}
            </button>
            <button type="button" className="btn is-pencil" disabled={busy} onClick={onFix}>
              {t("planning.fix")}
            </button>
          </div>
          <p className="muted planning-limits">{t("planning.limits")}</p>
          {failed && <p className="error-note">{t("chat.sendFailed")}</p>}
        </>
      )}
    </section>
  );
}
