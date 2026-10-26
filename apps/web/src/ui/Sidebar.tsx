import { useState } from "react";
import { inProjects, useApp } from "../context";
import { BookIcon, ComputerIcon, GalleryIcon, GearIcon, KeyIcon, MenuIcon } from "./NavIcons";
import { SideChats } from "./SideChats";
import { SideProjects } from "./SideProjects";

const SECTIONS_KEY = "drimvox.sidebarSections";

export function Sidebar() {
  const { t, view, navigate, chats } = useApp();
  // The sections at the bottom fold under one button (asked for), remembered in this window.
  const [sectionsOpen, setSectionsOpen] = useState(() => {
    try {
      return localStorage.getItem(SECTIONS_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  const toggleSections = () => {
    const next = !sectionsOpen;
    setSectionsOpen(next);
    try {
      localStorage.setItem(SECTIONS_KEY, next ? "open" : "closed");
    } catch {
      // Kept for this visit only.
    }
  };
  return (
    <aside className="side">
      {inProjects(view, chats) ? <SideProjects /> : <SideChats />}

      <nav className="side-nav" aria-label={t("side.sections")}>
        <button type="button" className="side-link side-sections" aria-expanded={sectionsOpen} onClick={toggleSections}>
          <MenuIcon />
          {t("side.sections")}
          <span className="side-sections-arrow" aria-hidden>
            ▾
          </span>
        </button>
        {sectionsOpen && (
          <div className="side-nav-items">
        <button className={`side-link${view.kind === "gallery" ? " is-on" : ""}`} onClick={() => navigate({ kind: "gallery" })}>
          <GalleryIcon />
          {t("side.gallery")}
        </button>
        <button className={`side-link${view.kind === "providers" ? " is-on" : ""}`} onClick={() => navigate({ kind: "providers" })}>
          <KeyIcon />
          {t("side.keys")}
        </button>
        <button className={`side-link${view.kind === "local" ? " is-on" : ""}`} onClick={() => navigate({ kind: "local" })}>
          <ComputerIcon />
          {t("side.local")}
        </button>
        <button className={`side-link${view.kind === "settings" ? " is-on" : ""}`} onClick={() => navigate({ kind: "settings" })}>
          <GearIcon />
          {t("top.settings")}
        </button>
        <button className={`side-link${view.kind === "guide" ? " is-on" : ""}`} onClick={() => navigate({ kind: "guide" })}>
          <BookIcon />
          {t("side.guide")}
        </button>
          </div>
        )}
      </nav>
    </aside>
  );
}
