import { app, ipcMain, type BrowserWindow, type IpcMainEvent } from "electron";
import { autoUpdater } from "electron-updater";

/** What the window shows about a new version. "manual": a .deb cannot replace itself, so the user downloads it. */
export interface UpdateState {
  state: "downloading" | "ready" | "manual";
  version: string;
  percent?: number;
  url?: string;
}

const RELEASES = "https://github.com/amave423/artel/releases";
/** First look a little after the start, then every few hours: nobody restarts an app they leave open. */
const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 6 * 3600_000;

/**
 * Updates from the GitHub releases of the repository: the installed Windows app and the AppImage download the new
 * version by themselves and install it on restart; a .deb only says where to get it. Nothing runs unpackaged.
 */
export function startUpdates(window: () => BrowserWindow | null, trusted: (event: IpcMainEvent) => boolean): void {
  let last: UpdateState | null = null;
  ipcMain.handle("artel:update-state", () => last);
  if (!app.isPackaged || process.env.ARTEL_NO_UPDATES === "1") return;

  // Only Windows' installer and the AppImage can replace themselves; a .deb needs root.
  const manual = process.platform === "linux" && !process.env.APPIMAGE;
  autoUpdater.autoDownload = !manual;
  autoUpdater.autoInstallOnAppQuit = true;
  const tell = (state: UpdateState) => {
    last = state;
    window()?.webContents.send("artel:update", state);
  };
  autoUpdater.on("update-available", (info) =>
    tell(manual ? { state: "manual", version: info.version, url: `${RELEASES}/tag/v${info.version}` } : { state: "downloading", version: info.version, percent: 0 }),
  );
  autoUpdater.on("download-progress", (p) => last && tell({ ...last, percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (info) => tell({ state: "ready", version: info.version }));
  // Offline or GitHub down: try again at the next check, quietly.
  autoUpdater.on("error", () => {});

  const check = () => void autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, FIRST_CHECK_MS).unref();
  setInterval(check, CHECK_EVERY_MS).unref();

  ipcMain.on("artel:update-install", (event) => {
    if (!trusted(event) || last?.state !== "ready") return;
    // The core still gets to stop what it started (see before-quit in main.ts); the installer runs on quit.
    autoUpdater.quitAndInstall(true, true);
  });
}
