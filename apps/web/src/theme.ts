import type { Theme } from "@artel/shared";

export type ResolvedTheme = "light" | "dark";

export function resolveTheme(theme: Theme, systemDark: boolean): ResolvedTheme {
  if (theme === "system") return systemDark ? "dark" : "light";
  return theme;
}

export function applyTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.dataset.theme = resolved;
  const css = getComputedStyle(root);
  window.artel?.setTitleBar({
    background: css.getPropertyValue("--paper").trim(),
    symbols: css.getPropertyValue("--fg").trim(),
  });
}
