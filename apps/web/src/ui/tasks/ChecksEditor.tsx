import { useApp } from "../../context";

/** The commands Artel runs to tell whether the work is done; each one can be edited or removed. */
export function ChecksEditor({ checks, onChange }: { checks: string[]; onChange(checks: string[]): void }) {
  const { t } = useApp();
  return (
    <>
      <h3 className="spec-sub">{t("spec.checks")}</h3>
      <p className="muted spec-hint">{t("spec.checksHint")}</p>
      <ul className="check-list">
        {checks.map((c, i) => (
          <li key={i}>
            <input
              className="field-input mono"
              value={c}
              aria-label={t("spec.checkLabel", { n: i + 1 })}
              onChange={(e) => onChange(checks.map((x, j) => (j === i ? e.target.value : x)))}
            />
            <button className="link is-pencil" onClick={() => onChange(checks.filter((_, j) => j !== i))}>
              {t("spec.removeCheck")}
            </button>
          </li>
        ))}
      </ul>
      {checks.length === 0 && <p className="error-note">{t("spec.noChecks")}</p>}
      <button className="link" onClick={() => onChange([...checks, ""])}>
        {t("spec.addCheck")}
      </button>
    </>
  );
}
