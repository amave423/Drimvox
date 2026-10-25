import type { Theme } from "@drimvox/shared";

export type ResolvedTheme = "light" | "dark";

export function resolveTheme(theme: Theme, systemDark: boolean): ResolvedTheme {
  if (theme === "system") return systemDark ? "dark" : "light";
  return theme;
}

export function applyTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.dataset.theme = resolved;
  const css = getComputedStyle(root);
  window.drimvox?.setTitleBar({
    background: css.getPropertyValue("--paper").trim(),
    symbols: css.getPropertyValue("--fg").trim(),
  });
}

/** "#rrggbb" or "rgba(r, g, b, a)" as numbers. */
function rgba(color: string): [number, number, number, number] | null {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(color);
  if (!fn) return null;
  const [r, g, b, a = "1"] = fn[1]!.split(",").map((p) => p.trim());
  return [Number(r), Number(g), Number(b), Number(a)];
}

const hexOf = (c: number[]) => `#${c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

/** A colour seen through a dimming layer on top of it. */
function under(color: string, layer: string): string {
  const base = rgba(color);
  const top = rgba(layer);
  if (!base || !top) return color;
  const a = top[3];
  return hexOf(base.map((v, i) => (i < 3 ? v * (1 - a) + top[i]! * a : 1)));
}

let dimmed = 0;

/**
 * The window's own buttons dim with a dark layer over the page (seen: the picture viewer and a card's details left them
 * bright, as if lit up): the title bar takes the colour the layer gives the bar under it. Counted, so nested layers work.
 */
export function dimTitleBar(on: boolean, layer: "--overlay" | "--overlay-soft"): void {
  dimmed = Math.max(0, dimmed + (on ? 1 : -1));
  const css = getComputedStyle(document.documentElement);
  const paper = css.getPropertyValue("--paper").trim();
  const fg = css.getPropertyValue("--fg").trim();
  const shade = css.getPropertyValue(layer).trim();
  window.drimvox?.setTitleBar(dimmed > 0 ? { background: under(paper, shade), symbols: under(fg, shade) } : { background: paper, symbols: fg });
}
