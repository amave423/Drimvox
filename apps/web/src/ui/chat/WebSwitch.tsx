import type { WebMode } from "@artel/shared";
import { useApp } from "../../context";

const KEY = "artel.web";

/** The internet setting of the last chat message on this device; free search by default. */
export function readWebMode(): WebMode {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === "off" || saved === "provider" ? saved : "free";
  } catch {
    return "free";
  }
}

function remember(mode: WebMode) {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // Without storage the next chat starts with free search.
  }
}

/** Off, Artel's free search, or the provider's paid search where the provider has one. */
export function WebSwitch({ value, onChange, providerSearch }: { value: WebMode; onChange(mode: WebMode): void; providerSearch: boolean }) {
  const { t } = useApp();
  const modes: WebMode[] = providerSearch ? ["off", "free", "provider"] : ["off", "free"];
  return (
    <select
      className="field-input web-switch"
      aria-label={t("web.label")}
      title={t("web.label")}
      value={modes.includes(value) ? value : "free"}
      onChange={(e) => {
        const mode = e.target.value as WebMode;
        remember(mode);
        onChange(mode);
      }}
    >
      {modes.map((m) => (
        <option key={m} value={m}>
          {t(`web.${m}`)}
        </option>
      ))}
    </select>
  );
}
