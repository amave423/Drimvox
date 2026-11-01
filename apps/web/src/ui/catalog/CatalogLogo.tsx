import type { CatalogLogo as Logo } from "../../lib/catalog";
import { useBrandFill } from "../BrandFill";

/** A card's mark on a tile: a vendor's logo or Drimvox's plain glyph, in the app's own violet-to-blue. */
export function CatalogLogo({ logo, size = 40 }: { logo: Logo; size?: number }) {
  const brand = useBrandFill();
  return (
    <span className="catalog-logo" style={{ width: size, height: size }} aria-hidden>
      <svg viewBox="0 0 24 24" width={size * 0.55} height={size * 0.55}>
        {brand.defs}
        {logo.letters ? (
          <text x="12" y="16.2" textAnchor="middle" fontSize={logo.letters.length > 3 ? 7.5 : logo.letters.length > 2 ? 9.5 : 11.5} fontWeight="700" letterSpacing="-0.3" fill={brand.fill} style={{ fontFamily: "var(--font-ui)" }}>
            {logo.letters}
          </text>
        ) : logo.stroke ? (
          <path d={logo.path} fill="none" stroke={brand.fill} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <path d={logo.path} fill={brand.fill} />
        )}
      </svg>
    </span>
  );
}
