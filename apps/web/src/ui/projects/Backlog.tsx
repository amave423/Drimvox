import { BATCH_POINTS, pointsOf, SIZE_POINTS, type BacklogItem, type BacklogSize, type ProjectPlan, type TaskView } from "@artel/shared";
import { useEffect, useState } from "react";
import { ok } from "../../api";
import { useApp } from "../../context";
import { rememberLastModel, type ModelChoice } from "../../lib/lastModel";
import { ModelPicker } from "../chat/ModelPicker";

interface Props {
  projectId: string;
  choice: ModelChoice | null;
  onChoice(choice: ModelChoice): void;
  /** The model cannot call tools: it cannot work on the project. */
  noTools: boolean;
}

/**
 * The project's task list (docs/specs/backlog-loop.md): a plan's interview fills it; the user picks a batch of at most
 * BATCH_POINTS and starts it; each task is reviewed before "Next" starts another.
 */
export function Backlog({ projectId, choice, onChoice, noTools }: Props) {
  const { api, t, navigate, reloadTasks } = useApp();
  const [items, setItems] = useState<BacklogItem[] | null>(null);
  const [plan, setPlan] = useState<ProjectPlan | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [adding, setAdding] = useState<{ title: string; size: BacklogSize } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  async function load() {
    const body = await api.projects[":id"].backlog
      .$get({ param: { id: projectId } })
      .then((r) => ok<{ items: BacklogItem[]; plan: ProjectPlan | null }>(r))
      .catch(() => null);
    if (!body) return;
    setItems(body.items);
    setPlan(body.plan);
    setPicked((p) => p.filter((id) => body.items.some((i) => i.id === id && i.status === "open")));
  }

  useEffect(() => {
    void load();
  }, [projectId]);

  if (items === null) return null;
  const active = items.find((i) => i.status === "active");
  const waiting = items.filter((i) => i.status === "picked");
  const open = items.filter((i) => i.status === "open");
  const chosen = picked.map((id) => items.find((i) => i.id === id)).filter((i): i is BacklogItem => !!i);
  const points = pointsOf(chosen);

  async function startTask(request: () => Promise<Response>) {
    setBusy(true);
    setFailed(null);
    const res = await request().catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      const body = (await res?.json().catch(() => null)) as { error?: { code?: string } } | null;
      return setFailed(body?.error?.code ?? "unknown");
    }
    const task = (await res.json()) as TaskView;
    if (choice) rememberLastModel(choice);
    setPicked([]);
    await reloadTasks();
    navigate({ kind: "task", taskId: task.id });
  }

  const startPlan = () =>
    choice && startTask(() => api.projects[":id"].backlog.plan.$post({ param: { id: projectId }, json: { task: text.trim(), providerId: choice.providerId, model: choice.model } }));
  const run = () => choice && startTask(() => api.projects[":id"].backlog.run.$post({ param: { id: projectId }, json: { ids: picked, providerId: choice.providerId, model: choice.model } }));
  const next = () => startTask(() => api.projects[":id"].backlog.next.$post({ param: { id: projectId } }));

  async function move(id: string, by: -1 | 1) {
    const order = open.map((i) => i.id);
    const at = order.indexOf(id);
    const to = at + by;
    if (at < 0 || to < 0 || to >= order.length) return;
    [order[at], order[to]] = [order[to]!, order[at]!];
    await api.projects[":id"].backlog.order.$post({ param: { id: projectId }, json: { ids: order } }).catch(() => null);
    await load();
  }

  async function remove(id: string) {
    await api.projects[":id"].backlog[":itemId"].$delete({ param: { id: projectId, itemId: id } }).catch(() => null);
    await load();
  }

  async function add() {
    if (!adding?.title.trim()) return;
    const title = adding.title.trim();
    await api.projects[":id"].backlog.$post({ param: { id: projectId }, json: { title, done: [title], size: adding.size } }).catch(() => null);
    setAdding(null);
    await load();
  }

  function toggle(item: BacklogItem) {
    setPicked((p) => (p.includes(item.id) ? p.filter((id) => id !== item.id) : [...p, item.id]));
  }

  // No list yet: describe the project; the interview ends with the list.
  if (items.length === 0) {
    return (
      <section>
        <h2 className="sheet-h">{t("backlog.planTitle")}</h2>
        <p className="muted">{t("backlog.planLede")}</p>
        <form
          className="task-form"
          onSubmit={(e) => {
            e.preventDefault();
            void startPlan();
          }}
        >
          <textarea
            className="field-input task-input"
            rows={5}
            value={text}
            placeholder={t("backlog.planPlaceholder")}
            aria-label={t("backlog.planTitle")}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="actions">
            <ModelPicker value={choice} onChange={onChoice} />
            <button className="btn is-primary" disabled={busy || !choice || !text.trim() || noTools}>
              {t("backlog.planStart")}
            </button>
          </div>
          {failed && <p className="error-note">{t("project.startFailed")}</p>}
        </form>
      </section>
    );
  }

  return (
    <section className="backlog">
      <h2 className="sheet-h">{t("backlog.title")}</h2>
      {plan?.context && <p className="muted backlog-context">{plan.context}</p>}

      {active?.taskId && (
        <p className="note">
          {t("backlog.now", { title: active.title })}{" "}
          <button className="link" onClick={() => navigate({ kind: "task", taskId: active.taskId! })}>
            {t("backlog.open")}
          </button>
        </p>
      )}
      {!active && waiting.length > 0 && (
        <div className="note backlog-next">
          <p>{t("backlog.nextUp", { title: waiting[0]!.title })}</p>
          <button className="btn is-primary" disabled={busy} onClick={() => void next()}>
            {t("backlog.next")}
          </button>
        </div>
      )}

      <ul className="backlog-list">
        {items.map((item) => {
          const isOpen = item.status === "open";
          const on = picked.includes(item.id);
          const tooMuch = !on && points + SIZE_POINTS[item.size] > BATCH_POINTS;
          return (
            <li key={item.id} className={`backlog-item is-${item.status}`}>
              <label className="backlog-pick">
                {isOpen ? (
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={(tooMuch || !!active || waiting.length > 0) && !on}
                    title={tooMuch ? t("backlog.tooMuch", { points: BATCH_POINTS }) : undefined}
                    onChange={() => toggle(item)}
                  />
                ) : (
                  <span className="backlog-status">{t(`backlog.status.${item.status}`)}</span>
                )}
                <span className="backlog-title">
                  {on && <span className="backlog-order">{picked.indexOf(item.id) + 1}. </span>}
                  {item.title}
                </span>
                <span className={`backlog-size size-${item.size}`} title={t(`backlog.size.${item.size}`)}>
                  {item.size}
                </span>
              </label>
              <ul className="backlog-done muted">
                {item.done.map((d, n) => (
                  <li key={n}>{d}</li>
                ))}
              </ul>
              <div className="backlog-tools">
                {item.taskId && (
                  <button className="link" onClick={() => navigate({ kind: "task", taskId: item.taskId! })}>
                    {t("backlog.open")}
                  </button>
                )}
                {isOpen && (
                  <>
                    <button className="link" aria-label={t("backlog.up")} onClick={() => void move(item.id, -1)}>
                      ↑
                    </button>
                    <button className="link" aria-label={t("backlog.down")} onClick={() => void move(item.id, 1)}>
                      ↓
                    </button>
                    <button className="link" onClick={() => void remove(item.id)}>
                      {t("backlog.remove")}
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {adding ? (
        <form
          className="backlog-add"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input className="field-input" aria-label={t("backlog.addTitle")} placeholder={t("backlog.addTitle")} value={adding.title} onChange={(e) => setAdding({ ...adding, title: e.target.value })} autoFocus />
          <select className="field-input" aria-label={t("backlog.addSize")} value={adding.size} onChange={(e) => setAdding({ ...adding, size: e.target.value as BacklogSize })}>
            {(["S", "M", "L"] as const).map((s) => (
              <option key={s} value={s}>
                {s} — {t(`backlog.size.${s}`)}
              </option>
            ))}
          </select>
          <button className="btn" disabled={!adding.title.trim()}>
            {t("backlog.add")}
          </button>
        </form>
      ) : (
        <button className="link" onClick={() => setAdding({ title: "", size: "S" })}>
          {t("backlog.addOne")}
        </button>
      )}

      {!active && waiting.length === 0 && open.length > 0 && (
        <div className="backlog-run">
          <p className="muted">{t("backlog.points", { points, max: BATCH_POINTS })}</p>
          <div className="actions">
            <ModelPicker value={choice} onChange={onChoice} />
            <button className="btn is-primary" disabled={busy || !choice || picked.length === 0 || noTools} onClick={() => void run()}>
              {t("backlog.start")}
            </button>
          </div>
        </div>
      )}
      {failed && <p className="error-note">{t(failed === "too_many_points" ? "backlog.tooMuch" : "project.startFailed", { points: BATCH_POINTS })}</p>}
    </section>
  );
}
