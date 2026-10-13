import type { TaskStages, TaskView } from "@artel/shared";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";
import { Segmented } from "../Segmented";

const KEY = "artel.stages";
const ALL_ON: TaskStages = { interview: true, spec: true, approveSpec: true, testsFirst: true };

/** The stage switches a new task starts with: the user's last choice on this device. */
export function readStages(): TaskStages {
  try {
    return { ...ALL_ON, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<TaskStages>) };
  } catch {
    return ALL_ON;
  }
}

function remember(stages: TaskStages) {
  try {
    localStorage.setItem(KEY, JSON.stringify(stages));
  } catch {
    // Without storage the next task starts with every stage on.
  }
}

/** For a team the plan is not optional: it is what splits the goal between the agents. */
export function StageSwitches({ value, onChange, team = false }: { value: TaskStages; onChange(stages: TaskStages): void; team?: boolean }) {
  const { t } = useApp();
  const set = (patch: Partial<TaskStages>) => {
    const next = { ...value, ...patch };
    remember(next);
    onChange(next);
  };
  const spec = value.spec || team;
  const box = (key: keyof TaskStages, disabled = false, forced = false) => (
    <label className={`stage-switch${disabled || forced ? " is-disabled" : ""}`}>
      <input
        type="checkbox"
        checked={forced || (value[key] && !disabled)}
        disabled={disabled || forced}
        onChange={(e) => set({ [key]: e.target.checked })}
      />
      {t((team && key === "spec" ? "stages.plan" : `stages.${key}`) as MessageKey)}
    </label>
  );
  // "With stops" waits for the user's OK on the spec or plan (and between the stages of a big task); "On its own" does not.
  const mode = value.approveSpec ? "stops" : "auto";
  return (
    <fieldset className="stages">
      <legend>{t("stages.title")}</legend>
      <div className="stages-mode">
        <span id="stages-mode-label" className="sr-only">
          {t("stages.mode")}
        </span>
        <Segmented
          labelledBy="stages-mode-label"
          value={mode}
          options={[
            { value: "stops", label: t("stages.stops") },
            { value: "auto", label: t("stages.auto") },
          ]}
          onChange={(m) => set({ approveSpec: m === "stops" })}
        />
        <span className="muted stages-mode-hint">{t(mode === "auto" ? "stages.autoHint" : "stages.stopsHint")}</span>
      </div>
      {box("interview")}
      {box("spec", false, team)}
      {box("testsFirst", !spec)}
    </fieldset>
  );
}

type Step = "interview" | "spec" | "tests" | "code" | "plan" | "team" | "review";

/** Where the task is in its sequence of steps; skipped steps are not shown. */
export function PhaseSteps({ task }: { task: TaskView }) {
  const { t } = useApp();
  const goal = task.kind === "goal";
  const steps: Step[] = [];
  if (task.stages.interview) steps.push("interview");
  if (goal) steps.push("plan", "team");
  else {
    if (task.stages.spec) steps.push("spec");
    if (task.stages.spec && task.stages.testsFirst) steps.push("tests");
    steps.push("code");
  }
  steps.push("review");
  if (steps.length <= 2) return null;

  const reviewing = ["review", "done_empty", "accepted", "discarded"].includes(task.status);
  const phase = task.phase ?? "code";
  const current: Step = reviewing ? "review" : goal ? (phase === "interview" ? "interview" : phase === "spec" ? "plan" : "team") : (phase as Step);
  const at = steps.indexOf(current);
  return (
    <ol className="phase-steps">
      {steps.map((step, i) => (
        <li key={step} className={i < at ? "is-done" : i === at ? "is-now" : undefined} aria-current={i === at ? "step" : undefined}>
          {t(`phase.${step}` as MessageKey)}
        </li>
      ))}
    </ol>
  );
}
