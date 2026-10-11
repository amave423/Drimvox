/** The model picked last, so a new chat starts with it. A per-device convenience, not settings. */
export interface ModelChoice {
  providerId: string;
  model: string;
}

const KEY = "artel.lastModel";

export function readLastModel(): ModelChoice | null {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null") as ModelChoice | null;
    return value && typeof value.providerId === "string" && typeof value.model === "string" ? value : null;
  } catch {
    return null;
  }
}

export function rememberLastModel(choice: ModelChoice): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(choice));
  } catch {
    // Storage may be unavailable; the next chat just starts without a preselected model.
  }
}
