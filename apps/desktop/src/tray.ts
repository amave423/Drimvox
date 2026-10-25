import { app, Menu, nativeImage, Notification, Tray, type BrowserWindow } from "electron";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let tray: Tray | null = null;
let menuTexts: { open: string; quit: string } | null = null;
let showWindow: (() => void) | null = null;
let update: { label: string; install: () => void } | null = null;

/** The tray's menu: open, restart into a downloaded update when there is one, quit. */
function rebuildMenu(): void {
  if (!tray || !menuTexts) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: menuTexts.open, click: () => showWindow?.() },
      ...(update ? [{ label: update.label, click: update.install }] : []),
      { type: "separator" },
      { label: menuTexts.quit, click: () => app.quit() },
    ]),
  );
}

/** A downloaded update: in the tray's menu, and said once with a notification (the window may be hidden). */
export function offerUpdate(label: string, title: string, body: string, install: () => void): void {
  update = { label, install };
  rebuildMenu();
  if (Notification.isSupported()) new Notification({ title, body }).show();
}

/** The app's icon: packed next to the app, or in the build folder while developing. */
function icon() {
  const file = app.isPackaged ? join(process.resourcesPath, "icon.png") : join(__dirname, "..", "build", "icon.png");
  const image = nativeImage.createFromPath(file);
  return image.isEmpty() ? image : image.resize({ width: 16, height: 16 });
}

/**
 * Closing the window leaves Drimvox in the tray (seen: agents and the started site stopped with the window): it goes on
 * working there; the tray's "Quit" ends it, and the core stops what it started. Said once, the first time.
 */
export function keepInTray(win: () => BrowserWindow | null, quitting: () => boolean, texts: { open: string; quit: string; hidden: string; hiddenBody: string }): (target: BrowserWindow) => void {
  const show = () => {
    const w = win();
    if (!w) return;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  };
  showWindow = show;
  menuTexts = { open: texts.open, quit: texts.quit };
  if (!tray) {
    tray = new Tray(icon());
    tray.setToolTip("Drimvox");
    tray.on("click", show);
  }
  rebuildMenu();
  const told = join(app.getPath("userData"), "tray-told");
  return (target) => {
    target.on("close", (event) => {
      if (quitting()) return;
      event.preventDefault();
      target.hide();
      if (existsSync(told)) return;
      try {
        writeFileSync(told, "");
      } catch {
        // Said again next time.
      }
      if (Notification.isSupported()) new Notification({ title: texts.hidden, body: texts.hiddenBody }).show();
    });
  };
}
