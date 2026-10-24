import { app, Menu, nativeImage, Notification, Tray, type BrowserWindow } from "electron";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let tray: Tray | null = null;

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
  if (!tray) {
    tray = new Tray(icon());
    tray.setToolTip("Drimvox");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: texts.open, click: show },
        { type: "separator" },
        { label: texts.quit, click: () => app.quit() },
      ]),
    );
    tray.on("click", show);
  }
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
