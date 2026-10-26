import { useApp } from "../context";
import { GearIcon } from "./NavIcons";
import { SideChats } from "./SideChats";
import { SideProjects } from "./SideProjects";

/** The mode's list (chats, or projects with the open one's checklist), and one way into the parameters (asked for). */
export function Sidebar() {
  const { t, mode, navigate } = useApp();
  return (
    <aside className="side">
      {mode === "projects" ? <SideProjects /> : <SideChats />}
      <nav className="side-nav" aria-label={t("side.sections")}>
        <button type="button" className="side-link" onClick={() => navigate({ kind: "settings" })}>
          <GearIcon />
          {t("side.params")}
        </button>
      </nav>
    </aside>
  );
}
