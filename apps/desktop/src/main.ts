import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, session, shell, utilityProcess, type UtilityProcess } from "electron";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { InitMessage } from "./core-process";
import { loadSecretKey } from "./keyring";

/** Must match DEV_CORE_PORT in apps/web/vite.config.ts (Vite proxies /api there). */
const DEV_CORE_PORT = 47800;
/** Injected by build.mjs; app.getVersion() reports Electron's version when running unpackaged. */
declare const __ARTEL_VERSION__: string;
const devServerUrl = process.env.ARTEL_DEV_SERVER_URL;
const token = randomBytes(32).toString("hex");

// Unpackaged Electron would otherwise store data under %APPDATA%\Electron. Dev keeps its own folder;
// ARTEL_USER_DATA lets tests isolate theirs.
app.setName(devServerUrl ? "Artel Dev" : "Artel");
app.setPath("userData", process.env.ARTEL_USER_DATA ?? join(app.getPath("appData"), app.getName()));
// Windows shows toasts only for apps with an identity.
app.setAppUserModelId(devServerUrl ? "Artel Dev" : "Artel");

let core: UtilityProcess | null = null;
let win: BrowserWindow | null = null;
let origin = "";

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(launch);
}

async function launch() {
  try {
    const port = await startCore();
    origin = devServerUrl ?? `http://127.0.0.1:${port}`;
    registerIpc();
    await createWindow();
  } catch (err) {
    dialog.showErrorBox("Artel не запустился", err instanceof Error ? err.message : String(err));
    app.quit();
  }
}

function webDir(): string {
  return app.isPackaged ? join(process.resourcesPath, "web") : join(__dirname, "..", "..", "web", "dist");
}

function startCore(): Promise<number> {
  const dataDir = app.getPath("userData");
  const init: InitMessage = {
    type: "init",
    token,
    secretKey: loadSecretKey(dataDir).toString("base64"),
    dataDir,
    version: __ARTEL_VERSION__,
    port: devServerUrl ? DEV_CORE_PORT : 0,
    webDir: devServerUrl ? undefined : webDir(),
  };

  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(join(__dirname, "core.cjs"), [], { serviceName: "Artel core" });
    child.postMessage(init);
    child.once("message", (msg: { type: string; port?: number; error?: string }) => {
      if (msg.type === "ready" && msg.port) resolve(msg.port);
      else reject(new Error(msg.error ?? "Ядро ответило непонятным сообщением"));
    });
    child.on("message", (msg: { type?: string; id?: number; url?: string; width?: number; height?: number }) => {
      if (msg.type !== "screenshot" || typeof msg.id !== "number" || typeof msg.url !== "string") return;
      const id = msg.id;
      photograph(msg.url, msg.width ?? 1280, msg.height ?? 800).then(
        (png) => child.postMessage({ type: "screenshot-done", id, png: png.toString("base64") }),
        (err: unknown) => child.postMessage({ type: "screenshot-done", id, error: err instanceof Error ? err.message : String(err) }),
      );
    });
    child.once("exit", (code) => {
      core = null;
      reject(new Error(`Ядро завершилось с кодом ${code}`));
    });
    core = child;
  });
}

/**
 * A page an agent wants to see, in a hidden window of its own session: no preload, no access to Artel's
 * token or storage, no pop-ups, downloads or navigation away from http(s).
 */
async function photograph(url: string, width: number, height: number): Promise<Buffer> {
  if (!/^https?:\/\//.test(url)) throw new Error("Only http and https pages");
  const preview = session.fromPartition("artel-preview");
  preview.removeAllListeners("will-download");
  preview.on("will-download", (_event, item) => item.cancel());
  const shot = new BrowserWindow({
    show: false,
    width,
    height,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, session: preview },
  });
  shot.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  shot.webContents.on("will-navigate", (event, next) => {
    if (!/^https?:\/\//.test(next)) event.preventDefault();
  });
  try {
    await Promise.race([
      shot.loadURL(url),
      new Promise((_, reject) => setTimeout(() => reject(new Error("The page did not load in 30 seconds")), 30_000)),
    ]);
    // Scripts of single-page apps draw after the load event.
    await new Promise((r) => setTimeout(r, 1000));
    return (await shot.webContents.capturePage()).toPNG();
  } finally {
    shot.destroy();
  }
}

function fromOurPage(url: string | undefined): boolean {
  return !!url && new URL(url).origin === new URL(origin).origin;
}

function registerIpc() {
  ipcMain.handle("artel:token", (event) => {
    if (!fromOurPage(event.senderFrame?.url)) throw new Error("Forbidden");
    return token;
  });

  ipcMain.handle("artel:pick-folder", async (event) => {
    if (!fromOurPage(event.senderFrame?.url)) throw new Error("Forbidden");
    // Tests cannot click a native dialog; they hand the folder over through the environment.
    if (process.env.ARTEL_TEST_PICK_FOLDER) return process.env.ARTEL_TEST_PICK_FOLDER;
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = { properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[] };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  // Only this one folder: the page cannot ask the main process to open arbitrary paths.
  ipcMain.on("artel:open-skills", (event) => {
    if (!fromOurPage(event.senderFrame?.url)) return;
    const dir = join(app.getPath("userData"), "skills");
    mkdirSync(dir, { recursive: true });
    void shell.openPath(dir);
  });

  ipcMain.on("artel:notify", (event, notice: { title?: unknown; body?: unknown; taskId?: unknown }) => {
    if (!fromOurPage(event.senderFrame?.url)) return;
    const { title, body, taskId } = notice ?? {};
    if (typeof title !== "string" || typeof body !== "string" || typeof taskId !== "string") return;
    // Tests cannot take the focus away from the window; they say it is elsewhere.
    const away = process.env.ARTEL_TEST_UNFOCUSED === "1" || !win?.isFocused();
    if (!away || !Notification.isSupported()) return;
    const toast = new Notification({ title: title.slice(0, 120), body: body.slice(0, 300), silent: false });
    toast.on("click", () => {
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      win.webContents.send("artel:open-task", taskId);
    });
    if (process.env.ARTEL_TEST_UNFOCUSED === "1") {
      // Tests read and click notifications here instead of on the desktop.
      const shown = ((globalThis as { artelNotices?: unknown[] }).artelNotices ??= []);
      shown.push({ title, body, taskId, click: () => toast.emit("click") });
      return;
    }
    toast.show();
  });

  const hex = /^#[0-9a-f]{6}$/i;
  ipcMain.on("artel:titlebar", (event, colors: { background?: unknown; symbols?: unknown }) => {
    const { background, symbols } = colors ?? {};
    if (typeof background !== "string" || typeof symbols !== "string") return;
    if (!hex.test(background) || !hex.test(symbols)) return;
    const target = BrowserWindow.fromWebContents(event.sender);
    if (process.platform !== "darwin") target?.setTitleBarOverlay({ color: background, symbolColor: symbols });
    target?.setBackgroundColor(background);
  });
}

async function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors;
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: "Artel",
    backgroundColor: dark ? "#1b1b19" : "#e4e5e0",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: dark ? "#222220" : "#eeefea", symbolColor: dark ? "#e9e8e2" : "#22211e", height: 44 },
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Task updates keep coming while the window is in the background; notifications depend on them.
      backgroundThrottling: false,
    },
  });

  win.once("ready-to-show", () => win?.show());
  win.on("closed", () => (win = null));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!fromOurPage(url)) event.preventDefault();
  });

  await win.loadURL(origin);
}

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  core?.kill();
  core = null;
});
