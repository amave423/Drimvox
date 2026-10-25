import type { ReactNode } from "react";

/**
 * One setting: its name in the interface font, what it does in a quiet line under it, then the control (seen: every
 * field was a serif heading with a "?", so the page read as a list of headings). Serif headings name the groups.
 */
export function Setting({ id, title, about, children }: { id: string; title: ReactNode; about?: ReactNode; children: ReactNode }) {
  return (
    <section className="setting" aria-labelledby={id}>
      <h3 className="setting-h" id={id}>
        {title}
      </h3>
      {about && <p className="setting-about">{about}</p>}
      {children}
    </section>
  );
}
