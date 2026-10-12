import type { TaskStages, TaskView } from "@artel/shared";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";

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

export function StageSwitches({ value, onChange }: { value: TaskStages; onChange(stages: TaskStages): void }) {
  const { t } = useApp();
  const set = (patch: Partial<TaskStages>) => {
    const next = { ...value, ...patch };
    remember(next);
    onChange(next);
  };
  const box = (key: keyof TaskStages, disabled = false) => (
    <label className={`stage-switch${disabled ? " is-disabled" : ""}`}>
      <input type="checkbox" checked={value[key] && !disabled} disabled={disabled} onChange={(e) => set({ [key]: e.target.checked })} />
      {t(`stages.${key}` as MessageKey)}
    </label>
  );
  return (
    <fieldset className="stages">
      <legend>{t("stages.title")}</legend>
      {box("interview")}
      {box("spec")}
      {box("approveSpec", !value.spec)}
      {box("testsFirst", !value.spec)}
    </fieldset>
  );
}

type Step = "interview" | "spec" | "tests" | "code" | "review";

/** Where the task is in its sequence of steps; skipped steps are not shown. */
export function PhaseSteps({ task }: { task: TaskView }) {
  const { t } = useApp();
  const steps: Step[] = [];
  if (task.stages.interview) steps.push("interview");
  if (task.stages.spec) steps.push("spec");
  if (task.stages.spec && task.stages.testsFirst) steps.push("tests");
  steps.push("code", "review");
  if (steps.length <= 2) return null;

  const reviewing = ["review", "done_empty", "accepted", "discarded"].includes(task.status);
  const current: Step = reviewing ? "review" : (task.phase ?? "code");
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
