import type { ThinkingLevel } from "@drimvox/shared";
import { useCallback, useEffect, useState } from "react";

/**
 * How a project's work goes, kept per project between messages and visits: how much the model thinks. Set in the
 * project's parameters on the right (asked for: they moved there from a pop-up under the box), read by the box when it
 * sends. The strong model is gone (asked for: useless; the work is stopped and another model picked instead).
 */
export interface BoxPrefs {
  thinking: ThinkingLevel;
}

const DEFAULTS: BoxPrefs = { thinking: "auto" };
const keyOf = (projectId: string) => `drimvox.projectBox.${projectId}`;
const listeners = new Map<string, Set<(p: BoxPrefs) => void>>();

function read(projectId: string): BoxPrefs {
  try {
    const kept = localStorage.getItem(keyOf(projectId));
    return kept ? { ...DEFAULTS, ...(JSON.parse(kept) as Partial<BoxPrefs>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

/** A project's prefs, the same in the panel and in the box: a change in one shows in the other at once. */
export function useBoxPrefs(projectId: string): [BoxPrefs, (patch: Partial<BoxPrefs>) => void] {
  const [prefs, setPrefs] = useState<BoxPrefs>(() => read(projectId));
  useEffect(() => {
    setPrefs(read(projectId));
    const mine = listeners.get(projectId) ?? new Set();
    listeners.set(projectId, mine);
    mine.add(setPrefs);
    return () => void mine.delete(setPrefs);
  }, [projectId]);
  const set = useCallback(
    (patch: Partial<BoxPrefs>) => {
      const next = { ...read(projectId), ...patch };
      try {
        localStorage.setItem(keyOf(projectId), JSON.stringify(next));
      } catch {
        // Kept for this visit only.
      }
      for (const l of listeners.get(projectId) ?? []) l(next);
    },
    [projectId],
  );
  return [prefs, set];
}
