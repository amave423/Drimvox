import { app, ipcMain, type BrowserWindow, type IpcMainEvent } from "electron";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { autoUpdater } from "electron-updater";

/**
 * What the window shows about updates. "manual": a .deb cannot replace itself, so the user downloads it; "off": not an
 * installed app (development, tests), nothing is checked. `version` is the new one, or the running one while none is.
 */
export interface UpdateState {
  state: "off" | "idle" | "checking" | "latest" | "error" | "downloading" | "ready" | "manual";
  version: string;
  percent?: number;
  url?: string;
  /** What went wrong, for "error". */
  message?: string;
  /** When Drimvox last asked GitHub, in milliseconds. */
  checkedAt?: number;
}

const RELEASES = "https://github.com/amave423/Drimvox/releases";
/** First look a little after the start, then every few hours: nobody restarts an app they leave open. */
const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 6 * 3600_000;

/**
 * Updates from the GitHub releases of the repository: the installed Windows app and the AppImage download the new
 * version by themselves and install it on restart; a .deb only says where to get it. Nothing runs unpackaged.
 */
export function startUpdates(window: () => BrowserWindow | null, trusted: (event: IpcMainEvent) => boolean): void {
  let last: UpdateState = { state: "off", version: app.getVersion() };
  ipcMain.handle("drimvox:update-state", () => last);
  if (!app.isPackaged || process.env.DRIMVOX_NO_UPDATES === "1") return;
  // Tests point the updater at a fake feed of their own.
  last = { state: "idle", version: app.getVersion() };
  if (process.env.DRIMVOX_TEST_UPDATE_URL) autoUpdater.setFeedURL({ provider: "generic", url: process.env.DRIMVOX_TEST_UPDATE_URL });

  // Every check and failure goes to logs/updates.log in the data folder (seen: an update never came and nothing said why).
  const logFile = join(app.getPath("userData"), "logs", "updates.log");
  const log = (level: string, message: unknown) => {
    try {
      mkdirSync(join(logFile, ".."), { recursive: true });
      appendFileSync(logFile, `${new Date().toISOString()} ${level} ${message instanceof Error ? (message.stack ?? message.message) : String(message)}\n`);
    } catch {
      // A log that cannot be written is no reason to stop updating.
    }
  };
  autoUpdater.logger = { info: (m: unknown) => log("info", m), warn: (m: unknown) => log("warn", m), error: (m: unknown) => log("error", m), debug: () => {} };
  log("info", `Drimvox ${app.getVersion()} looks for updates`);

  // Only Windows' installer and the AppImage can replace themselves; a .deb needs root.
  const manual = process.platform === "linux" && !process.env.APPIMAGE;
  autoUpdater.autoDownload = !manual;
  autoUpdater.autoInstallOnAppQuit = true;
  const tell = (state: UpdateState) => {
    last = state;
    window()?.webContents.send("drimvox:update", state);
  };
  autoUpdater.on("update-available", (info) =>
    tell(manual ? { state: "manual", version: info.version, url: `${RELEASES}/tag/v${info.version}` } : { state: "downloading", version: info.version, percent: 0 }),
  );
  autoUpdater.on("download-progress", (p) => tell({ ...last, percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (info) => tell({ state: "ready", version: info.version }));
  autoUpdater.on("update-not-available", () => tell({ state: "latest", version: app.getVersion(), checkedAt: Date.now() }));
  // Offline or GitHub out of reach: said in the settings, and tried again at the next check.
  autoUpdater.on("error", (err) => {
    log("error", err);
    // A version already downloaded stays ready: a later failed check does not take it away.
    if (last.state !== "ready") tell({ state: "error", version: app.getVersion(), message: err instanceof Error ? err.message.split("\n")[0]!.slice(0, 300) : String(err), checkedAt: Date.now() });
  });

  const check = () => {
    // Nothing to ask while a version is coming or waiting for the restart.
    if (last.state === "downloading" || last.state === "ready" || last.state === "checking") return;
    tell({ state: "checking", version: app.getVersion() });
    void autoUpdater.checkForUpdates().catch(() => {});
  };
  ipcMain.on("drimvox:update-check", (event) => trusted(event) && check());
  setTimeout(check, FIRST_CHECK_MS).unref();
  setInterval(check, CHECK_EVERY_MS).unref();

  ipcMain.on("drimvox:update-install", (event) => {
    if (!trusted(event) || last.state !== "ready") return;
    // The core still gets to stop what it started (see before-quit in main.ts); the installer runs on quit.
    autoUpdater.quitAndInstall(true, true);
  });
}
