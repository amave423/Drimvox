import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell, utilityProcess, type UtilityProcess } from "electron";
import { randomBytes } from "node:crypto";
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
    child.once("exit", (code) => {
      core = null;
      reject(new Error(`Ядро завершилось с кодом ${code}`));
    });
    core = child;
  });
}

function fromOurPage(url: string | undefined): boolean {
  return !!url && new URL(url).origin === new URL(origin).origin;
}

function registerIpc() {
  ipcMain.handle("artel:token", (event) => {
    if (!fromOurPage(event.senderFrame?.url)) throw new Error("Forbidden");
    return token;
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
