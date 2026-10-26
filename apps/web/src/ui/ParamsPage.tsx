import type { ReactNode } from "react";
import { useApp, type View } from "../context";
import type { MessageKey } from "../i18n";
import { BookIcon, ComputerIcon, GalleryIcon, GearIcon, KeyIcon } from "./NavIcons";

const SECTIONS: { kind: View["kind"]; label: MessageKey; Icon: () => ReactNode }[] = [
  { kind: "settings", label: "top.settings", Icon: GearIcon },
  { kind: "providers", label: "side.keys", Icon: KeyIcon },
  { kind: "local", label: "side.local", Icon: ComputerIcon },
  { kind: "gallery", label: "side.gallery", Icon: GalleryIcon },
  { kind: "guide", label: "side.guide", Icon: BookIcon },
];

/**
 * The parameters (asked for): a page of their own over the whole window, the way back on the top left, the sections on
 * the right. The mode the user came from stays as it was.
 */
export function ParamsPage({ children }: { children: ReactNode }) {
  const { t, view, navigate, leaveParams } = useApp();
  return (
    <div className="params">
      <div className="params-main">
        <button type="button" className="params-back" onClick={leaveParams}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 5l-7 7 7 7" />
          </svg>
          {t("params.back")}
        </button>
        {children}
      </div>
      <nav className="params-nav" aria-label={t("params.sections")}>
        {SECTIONS.map(({ kind, label, Icon }) => (
          <button
            key={kind}
            type="button"
            className={`side-link${view.kind === kind ? " is-on" : ""}`}
            aria-current={view.kind === kind ? "page" : undefined}
            onClick={() => navigate({ kind } as View)}
          >
            <Icon />
            {t(label)}
          </button>
        ))}
      </nav>
    </div>
  );
}
