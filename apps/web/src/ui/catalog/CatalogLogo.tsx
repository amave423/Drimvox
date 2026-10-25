import type { CatalogLogo as Logo } from "../../lib/catalog";

/** A card's mark on a tile: a vendor's logo in one colour, or Drimvox's plain glyph. */
export function CatalogLogo({ logo, size = 40 }: { logo: Logo; size?: number }) {
  return (
    <span className="catalog-logo" style={{ width: size, height: size }} aria-hidden>
      <svg viewBox="0 0 24 24" width={size * 0.55} height={size * 0.55}>
        {logo.stroke ? (
          <path d={logo.path} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <path d={logo.path} fill="currentColor" />
        )}
      </svg>
    </span>
  );
}
