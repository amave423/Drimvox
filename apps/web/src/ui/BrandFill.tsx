import { useId, type ReactElement } from "react";

/**
 * The app's own violet-to-blue, for the marks of providers, servers and skills (asked for: logos in the colours of
 * Drimvox's mark). Returns the gradient to put in an SVG's defs and the fill that uses it.
 */
export function useBrandFill(): { defs: ReactElement; fill: string } {
  const id = `brand-${useId().replace(/:/g, "")}`;
  return {
    defs: (
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: "var(--brand-from)" }} />
          <stop offset="1" style={{ stopColor: "var(--brand-to)" }} />
        </linearGradient>
      </defs>
    ),
    fill: `url(#${id})`,
  };
}
