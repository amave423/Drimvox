/** The model picked last, so a new chat starts with it. A per-device convenience, not settings. */
export interface ModelChoice {
  providerId: string;
  model: string;
}

const KEY = "artel.lastModel";
/** The model a team's worker agents used last. */
export const TEAM_MODEL_KEY = "artel.teamModel";

export function readLastModel(key = KEY): ModelChoice | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as ModelChoice | null;
    return value && typeof value.providerId === "string" && typeof value.model === "string" ? value : null;
  } catch {
    return null;
  }
}

export function rememberLastModel(choice: ModelChoice, key = KEY): void {
  try {
    localStorage.setItem(key, JSON.stringify(choice));
  } catch {
    // Storage may be unavailable; the next chat just starts without a preselected model.
  }
}
