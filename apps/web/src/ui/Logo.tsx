import { useId } from "react";

/** The ribbon D (assets/logo.svg), with the outline it is drawn along. */
const RIBBON = "M22 14 H52 C74 14 88 30 88 50 C88 70 74 86 52 86 H38 L46 70 H52 C64 70 72 62 72 50 C72 38 64 30 52 30 H30 Z";
const FOLD = "M30 30 L22 14 L14 30 L26 86 L38 86 Z";
const LIGHT = "M38 86 L46 70 L30 30 L26 86 Z";

/**
 * Drimvox's mark in the colours of the mode (asked for: the projects' mode has its own), from --brand-from and
 * --brand-to; the fold a shade darker, its light side a shade lighter. `draw`: drawn along its outline, then filled.
 */
export function Logo({ size, draw }: { size: number; draw?: boolean }) {
  const id = useId().replace(/:/g, "");
  const stop = (offset: number, color: string) => <stop offset={offset} style={{ stopColor: color }} />;
  return (
    <svg className={`logo-mark${draw ? " is-drawn" : ""}`} viewBox="8 8 84 84" width={size} height={size} aria-hidden>
      <defs>
        <linearGradient id={`${id}r`} x1="0" y1="0" x2="1" y2="1">
          {stop(0, "var(--brand-from)")}
          {stop(1, "var(--brand-to)")}
        </linearGradient>
        <linearGradient id={`${id}f`} x1="0" y1="0" x2="1" y2="1">
          {stop(0, "color-mix(in srgb, var(--brand-from) 78%, black)")}
          {stop(1, "color-mix(in srgb, var(--brand-to) 78%, black)")}
        </linearGradient>
        <linearGradient id={`${id}l`} x1="0" y1="0" x2="1" y2="1">
          {stop(0, "color-mix(in srgb, var(--brand-from) 65%, white)")}
          {stop(1, "color-mix(in srgb, var(--brand-to) 65%, white)")}
        </linearGradient>
      </defs>
      <path d={RIBBON} pathLength={1} fill={`url(#${id}r)`} stroke={`url(#${id}r)`} />
      <path d={FOLD} pathLength={1} fill={`url(#${id}f)`} stroke={`url(#${id}f)`} />
      <path className="logo-light" d={LIGHT} pathLength={1} fill={`url(#${id}l)`} stroke={`url(#${id}l)`} />
    </svg>
  );
}
