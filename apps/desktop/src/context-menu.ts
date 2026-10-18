import { app, Menu, type MenuItemConstructorOptions, type WebContents } from "electron";
import { menuItems } from "./menu-items";

/**
 * The right-click menu of the window: corrections for a word the spell checker underlined, "Add to dictionary", and the
 * usual editing commands. Russian and English are checked together.
 */
export function attachContextMenu(contents: WebContents): void {
  try {
    contents.session.setSpellCheckerLanguages(["ru", "en-US"]);
  } catch {
    // Some systems check with the languages of the OS and refuse a list; the underlining still works.
  }
  contents.on("context-menu", (_event, params) => {
    const items = menuItems(params, app.getLocale());
    if (items.length === 0) return;
    const template = items.map((item): MenuItemConstructorOptions => {
      switch (item.kind) {
        case "separator":
          return { type: "separator" };
        case "none":
          return { label: item.label, enabled: false };
        case "replace":
          return { label: item.label, click: () => contents.replaceMisspelling(item.word) };
        case "learn":
          return { label: item.label, click: () => contents.session.addWordToSpellCheckerDictionary(item.word) };
        case "role":
          return { label: item.label, role: item.role, enabled: item.enabled };
      }
    });
    Menu.buildFromTemplate(template).popup();
  });
}
