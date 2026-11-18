/**
 * How full a model's context is, as the bar's colour (asked for: the bar changes colour as it fills). Green while there
 * is room, amber from half, red from 80 %, where a project's history starts to be summarized.
 */
export type ContextLevel = "low" | "mid" | "high";

export function contextLevel(used: number, size: number): ContextLevel {
  const share = size > 0 ? used / size : 0;
  return share >= 0.8 ? "high" : share >= 0.5 ? "mid" : "low";
}
