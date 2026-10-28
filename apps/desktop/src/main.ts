import { coreGitEnv } from "./git-env";
import { attachContextMenu } from "./context-menu";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, screen, session, shell, utilityProcess, type UtilityProcess } from "electron";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InitMessage } from "./core-process";
import { MAX_WAIT_MS, PAGE_HEIGHT_SCRIPT, PAGE_TEXT_SCRIPT, pageActionScript, type PageAction } from "@drimvox/shared";
import { INSTALLER_ID } from "./installer-id";
import { loadSecretKey } from "./keyring";
import { startUpdates } from "./updates";
import { keepInTray, notifyWith, offerUpdate } from "./tray";
import { noticeRequest, setupNotices, showNotice, type NoticeRequest } from "./notices";
import { AgentView } from "./agent-view";

/** Must match DEV_CORE_PORT in apps/web/vite.config.ts (Vite proxies /api there). */
const DEV_CORE_PORT = 47800;
/** Injected by build.mjs; app.getVersion() reports Electron's version when running unpackaged. */
declare const __DRIMVOX_VERSION__: string;
const devServerUrl = process.env.DRIMVOX_DEV_SERVER_URL;
const token = randomBytes(32).toString("hex");

// Unpackaged Electron would otherwise store data under %APPDATA%\Electron. Dev keeps its own folder;
// DRIMVOX_USER_DATA lets tests isolate theirs.
app.setName(devServerUrl ? "Drimvox Dev" : "Drimvox");
app.setPath("userData", process.env.DRIMVOX_USER_DATA ?? join(app.getPath("appData"), app.getName()));
// Windows shows toasts only for apps with an identity. The installed app has the installer's (electron-builder.yml),
// a run from the sources its own, so their Start menu shortcuts do not overwrite each other.
const appId = app.isPackaged ? INSTALLER_ID : devServerUrl ? "Drimvox Dev" : "Drimvox";
app.setAppUserModelId(appId);

/**
 * Windows 10 shows an app's notifications only when a Start menu shortcut carries its AppUserModelID. An installer makes
 * one; `npm start` does not, and then every notification vanishes without an error. Drimvox keeps its own shortcut.
 */
function ensureShortcut(): void {
  if (process.platform !== "win32" || app.isPackaged || process.env.DRIMVOX_USER_DATA) return;
  const link = join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", `${appId} (npm start).lnk`);
  const wanted = { target: process.execPath, args: app.isPackaged ? "" : `"${app.getAppPath()}"`, appUserModelId: appId, description: appId };
  try {
    const now = existsSync(link) ? shell.readShortcutLink(link) : null;
    if (now && now.target === wanted.target && now.args === wanted.args && now.appUserModelId === appId) return;
    shell.writeShortcutLink(link, now ? "replace" : "create", wanted);
  } catch {
    // Without the shortcut Drimvox still works; only the notifications stay away.
  }
}

let core: UtilityProcess | null = null;
let win: BrowserWindow | null = null;
let origin = "";
/** The agent's browser: its tabs live in the window; the core drives them by message. */
const agentView = new AgentView(
  () => win,
  (state) => core?.postMessage({ type: "browser-state", state }),
);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    // From the tray too: starting Drimvox again shows the window it keeps.
    win.show();
    win.focus();
  });
  app.whenReady().then(() => {
    ensureShortcut();
    const ru = app.getLocale().startsWith("ru");
    startUpdates(
      () => win,
      (event) => fromOurPage(event.senderFrame?.url),
      (version, install) =>
        offerUpdate(
          ru ? `Перезапустить и обновить до ${version}` : `Restart and update to ${version}`,
          ru ? `Drimvox ${version} скачан` : `Drimvox ${version} is downloaded`,
          ru ? "Установится при выходе, или перезапусти из значка в трее." : "It installs on quit, or restart from the tray icon.",
          install,
        ),
    );
    return launch();
  });
}

async function launch() {
  try {
    const port = await startCore();
    origin = devServerUrl ?? `http://127.0.0.1:${port}`;
    registerIpc();
    const ollama = takeInstallerNote("install-ollama");
    const images = takeInstallerNote("install-images");
    if (ollama) void callCore(port, "/api/local/install");
    if (images) void callCore(port, "/api/local/images/engine");
    await createWindow(ollama ? "local" : images ? "local-images" : undefined);
  } catch (err) {
    dialog.showErrorBox("Drimvox не запустился", err instanceof Error ? err.message : String(err));
    app.quit();
  }
}

/**
 * What the installer was asked besides the files (build/installer.nsh): it leaves a note beside the program, and the
 * first start acts on it once.
 */
function takeInstallerNote(name: string): boolean {
  const note = join(process.env.DRIMVOX_TEST_PROGRAM_DIR ?? dirname(process.execPath), name);
  if (!existsSync(note)) return false;
  rmSync(note, { force: true });
  return true;
}

/**
 * The installer's boxes ("Install Ollama", "the picture engine"): the core's own downloads, with their progress on the
 * local models' sheet.
 */
async function callCore(port: number, path: string): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  } catch {
    // The sheet still offers it.
  }
}

function webDir(): string {
  return app.isPackaged ? join(process.resourcesPath, "web") : join(__dirname, "..", "..", "web", "dist");
}

/** The bundled git: in the installed app beside the interface, while developing where npm put it. */
function gitDir(): string {
  return app.isPackaged ? join(process.resourcesPath, "git") : join(__dirname, "..", "..", "..", "node_modules", "dugite", "git");
}

function startCore(): Promise<number> {
  const dataDir = app.getPath("userData");
  const init: InitMessage = {
    type: "init",
    token,
    secretKey: loadSecretKey(dataDir).toString("base64"),
    dataDir,
    version: __DRIMVOX_VERSION__,
    port: devServerUrl ? DEV_CORE_PORT : 0,
    webDir: devServerUrl ? undefined : webDir(),
  };

  return new Promise((resolve, reject) => {
    // The git the app carries, when the system has none (git-env.ts).
    const env = { ...process.env, ...coreGitEnv(gitDir()) } as Record<string, string>;
    const child = utilityProcess.fork(join(__dirname, "core.cjs"), [], { serviceName: "Drimvox core", env });
    child.postMessage(init);
    child.once("message", (msg: { type: string; port?: number; error?: string }) => {
      if (msg.type === "ready" && msg.port) resolve(msg.port);
      else reject(new Error(msg.error ?? "Ядро ответило непонятным сообщением"));
    });
    child.on("message", (msg: { type?: string; id?: number; url?: string; width?: number; height?: number; actions?: PageAction[]; reason?: string; op?: string; args?: unknown[] }) => {
      if (msg.type === "browser" && typeof msg.id === "number" && typeof msg.op === "string") {
        const id = msg.id;
        agentView.call(msg.op, Array.isArray(msg.args) ? msg.args : []).then(
          (result) => child.postMessage({ type: "browser-done", id, result: result ?? null }),
          (err: unknown) => child.postMessage({ type: "browser-done", id, error: err instanceof Error ? err.message : String(err) }),
        );
        return;
      }
      if ((msg.type !== "screenshot" && msg.type !== "page-text" && msg.type !== "show-page") || typeof msg.id !== "number" || typeof msg.url !== "string") return;
      const id = msg.id;
      if (msg.type === "show-page") {
        showPage(msg.url, msg.reason ?? "").then(
          (page) => child.postMessage({ type: "page-text-done", id, page }),
          (err: unknown) => child.postMessage({ type: "page-text-done", id, error: err instanceof Error ? err.message : String(err) }),
        );
        return;
      }
      const steps = Array.isArray(msg.actions) ? msg.actions : [];
      if (msg.type === "page-text") {
        readPage(msg.url, steps).then(
          (page) => child.postMessage({ type: "page-text-done", id, page }),
          (err: unknown) => child.postMessage({ type: "page-text-done", id, error: err instanceof Error ? err.message : String(err) }),
        );
        return;
      }
      photograph(msg.url, msg.width ?? 1280, msg.height ?? 800, steps).then(
        (shot) => child.postMessage({ type: "screenshot-done", id, png: shot.png.toString("base64"), console: shot.console }),
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
 * A page an agent wants to see, in a hidden window of its own session: no preload, no access to Drimvox's
 * token or storage, no pop-ups, downloads or navigation away from http(s).
 */
/** Very long pages are cut here; a picture taller than this tells a model little more. */
const MAX_SHOT_HEIGHT = 8000;

async function photograph(url: string, width: number, height: number, actions: PageAction[] = []): Promise<{ png: Buffer; console: string[] }> {
  return withPage(url, width, height, actions, async (shot, errors) => {
    // The whole page, not only its first screen: a check of a long page needs what is further down too.
    const full = Number(await shot.webContents.executeJavaScript(PAGE_HEIGHT_SCRIPT));
    if (full > height) {
      shot.setContentSize(width, Math.min(full, MAX_SHOT_HEIGHT));
      await new Promise((r) => setTimeout(r, 500));
    }
    return { png: (await shot.webContents.capturePage()).toPNG(), console: errors };
  });
}

/** A page read as a person sees it, scripts run (browse_page): its title, address and visible text. */
function readPage(url: string, actions: PageAction[] = []): Promise<{ url: string; title: string; text: string }> {
  return withPage(url, 1280, 900, actions, async (shot) => JSON.parse(String(await shot.webContents.executeJavaScript(PAGE_TEXT_SCRIPT))));
}

/**
 * A page shown to the user in the agents' own browser (open_for_user): they pass a captcha or sign in, close the window,
 * and the model reads what the page shows then; browse_page goes on with the same cookies (seen live: sites answered the
 * hidden window with a check only a person may pass).
 */
function showPage(url: string, reason: string): Promise<{ url: string; title: string; text: string }> {
  if (!/^https?:\/\//.test(url)) return Promise.reject(new Error("Only http and https pages"));
  const page = new BrowserWindow({
    width: 1100,
    height: 800,
    title: reason ? `Drimvox — ${reason}` : "Drimvox",
    ...(win && !win.isDestroyed() ? { parent: win } : {}),
    autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, session: session.fromPartition("drimvox-preview") },
  });
  // The title says what to do in the window, not what the site calls itself.
  page.on("page-title-updated", (event) => event.preventDefault());
  page.webContents.setWindowOpenHandler(({ url: next }) => {
    if (/^https?:\/\//.test(next)) void page.loadURL(next);
    return { action: "deny" };
  });
  page.webContents.on("will-navigate", (event, next) => {
    if (!/^https?:\/\//.test(next)) event.preventDefault();
  });
  void page.loadURL(url).catch(() => {});
  page.focus();
  return new Promise((resolve) => {
    let read = false;
    page.on("close", (event) => {
      if (read) return;
      // What the page shows as the user leaves it goes to the model.
      event.preventDefault();
      read = true;
      page.webContents
        .executeJavaScript(PAGE_TEXT_SCRIPT)
        .then((text) => resolve(JSON.parse(String(text))))
        .catch(() => resolve({ url: page.webContents.getURL(), title: "", text: "" }))
        .finally(() => page.destroy());
    });
  });
}

/** Keys a page understands by name, with the codes the browser's input needs. */
const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
};

/** Types the step's text into the focused field, or presses its key, as real input through the DevTools protocol. */
async function realInput(shot: BrowserWindow, step: PageAction): Promise<void> {
  const tools = shot.webContents.debugger;
  if (!tools.isAttached()) {
    tools.attach("1.3");
    // A hidden window is never focused; the page must believe it is, or the typed text goes nowhere.
    await tools.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
  }
  if (step.action === "type") {
    await tools.sendCommand("Input.insertText", { text: step.text ?? "" });
    return;
  }
  const name = step.text ?? "Enter";
  const key = KEYS[name] ?? { code: name, keyCode: name.toUpperCase().charCodeAt(0), text: name.length === 1 ? name : undefined };
  const base = { key: name, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode };
  await tools.sendCommand("Input.dispatchKeyEvent", { type: key.text ? "keyDown" : "rawKeyDown", ...base, ...(key.text ? { text: key.text } : {}) });
  await tools.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

/** One step in the page; "left" when the page went to another address before it answered. */
async function runStep(shot: BrowserWindow, step: PageAction): Promise<unknown> {
  let onLeave: ((details: { isMainFrame: boolean; isSameDocument: boolean }) => void) | null = null;
  return Promise.race([
    shot.webContents.executeJavaScript(pageActionScript(step), true),
    new Promise((r) => setTimeout(() => r("left"), MAX_WAIT_MS + 5_000)),
    new Promise((r) => {
      onLeave = (details) => details.isMainFrame && !details.isSameDocument && r("left");
      shot.webContents.on("did-start-navigation", onLeave);
    }),
  ]).finally(() => onLeave && shot.webContents.off("did-start-navigation", onLeave));
}

/** Waits until a page that went to another address has loaded, 30 seconds at most. */
function settled(shot: BrowserWindow): Promise<void> {
  if (!shot.webContents.isLoading()) return new Promise((r) => setTimeout(r, 1000));
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 30_000);
    shot.webContents.once("did-stop-loading", () => {
      clearTimeout(timer);
      setTimeout(resolve, 1000);
    });
  });
}

/** Opens a page in a hidden window of its own session, goes through the steps, and hands the window to `read`. */
async function withPage<T>(url: string, width: number, height: number, actions: PageAction[], read: (shot: BrowserWindow, errors: string[]) => Promise<T>): Promise<T> {
  if (!/^https?:\/\//.test(url)) throw new Error("Only http and https pages");
  const preview = session.fromPartition("drimvox-preview");
  // Each look loads the page afresh (seen live: an agent added ?v=1, ?v=2… to every address to get past the cache).
  await preview.clearCache().catch(() => {});
  preview.removeAllListeners("will-download");
  preview.on("will-download", (_event, item) => item.cancel());
  const shot = new BrowserWindow({
    show: false,
    width,
    height,
    // The page gets exactly this width: 390 is a phone, not a phone minus the window frame.
    useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, session: preview },
  });
  shot.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  shot.webContents.on("will-navigate", (event, next) => {
    if (!/^https?:\/\//.test(next)) event.preventDefault();
  });
  // The page's own errors go with the picture (seen live: an agent wrote three diagnostic pages to see why its page
  // stayed empty, as the picture could not show a failed script).
  const errors: string[] = [];
  shot.webContents.on("console-message", (event) => {
    const e = event as unknown as { level?: string | number; message?: string; lineNumber?: number; sourceId?: string };
    if ((e.level === "error" || e.level === 3) && e.message && errors.length < 20) errors.push(`${e.message}${e.sourceId ? ` (${e.sourceId.split("/").pop()}:${e.lineNumber ?? ""})` : ""}`);
  });
  try {
    await Promise.race([
      shot.loadURL(url),
      new Promise((_, reject) => setTimeout(() => reject(new Error("The page did not load in 30 seconds")), 30_000)),
    ]);
    // Scripts of single-page apps draw after the load event.
    await new Promise((r) => setTimeout(r, 1000));
    // A scenario first, as a person would go through it (docs/specs/project-work.md); the page settles after each step.
    for (const [n, step] of actions.entries()) {
      try {
        // The page left for another address while the step ran: a click is expected to do that; anything else was the
        // page redirecting itself (seen: WIPO adds its parameters right after loading), so the step goes again.
        let answer = await runStep(shot, step);
        if (answer === "left" && step.action !== "click") {
          await settled(shot);
          answer = await runStep(shot, step);
        }
        // Text and keys as real input: pages ignore made-up events (seen: WIPO's search field stayed empty).
        if (answer === "keyboard") await realInput(shot, step);
        if (answer === "left" || shot.webContents.isLoading()) await settled(shot);
      } catch (err) {
        throw new Error(`Step ${n + 1} (${step.action} ${step.target ?? step.text ?? ""}): ${err instanceof Error ? err.message.replace(/^.*Error:\s*/, "") : String(err)}`);
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    return await read(shot, errors);
  } finally {
    shot.destroy();
  }
}

function fromOurPage(url: string | undefined): boolean {
  return !!url && new URL(url).origin === new URL(origin).origin;
}

function registerIpc() {
  ipcMain.handle("drimvox:token", (event) => {
    if (!fromOurPage(event.senderFrame?.url)) throw new Error("Forbidden");
    return token;
  });

  // The chat as it shows, saved as a PDF (asked for: export a chat). The page hides everything but the conversation for print.
  ipcMain.handle("drimvox:save-pdf", async (event, name: unknown) => {
    if (!fromOurPage(event.senderFrame?.url)) throw new Error("Forbidden");
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner) return null;
    const safe = (typeof name === "string" && name.trim() ? name : "chat").replace(/[\\/:*?"<>|]+/g, " ").slice(0, 80);
    const target = process.env.DRIMVOX_TEST_SAVE_PDF ?? (await dialog.showSaveDialog(owner, { defaultPath: `${safe}.pdf`, filters: [{ name: "PDF", extensions: ["pdf"] }] })).filePath;
    if (!target) return null;
    const pdf = await event.sender.printToPDF({ pageSize: "A4", printBackground: true });
    writeFileSync(target, pdf);
    return target;
  });
  ipcMain.handle("drimvox:pick-folder", async (event) => {
    if (!fromOurPage(event.senderFrame?.url)) throw new Error("Forbidden");
    // Tests cannot click a native dialog; they hand the folder over through the environment.
    if (process.env.DRIMVOX_TEST_PICK_FOLDER) return process.env.DRIMVOX_TEST_PICK_FOLDER;
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = { properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[] };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  // Only this one folder: the page cannot ask the main process to open arbitrary paths.
  ipcMain.on("drimvox:open-skills", (event) => {
    if (!fromOurPage(event.senderFrame?.url)) return;
    const dir = join(app.getPath("userData"), "skills");
    mkdirSync(dir, { recursive: true });
    void shell.openPath(dir);
  });

  // Drimvox's own notifications (notices.ts): a click brings the window forward on the task or the project.
  setupNotices((target) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (target.taskId) win.webContents.send("drimvox:open-task", target.taskId);
    else if (target.projectId) win.webContents.send("drimvox:open-project", target.projectId);
    else if (target.chatId) win.webContents.send("drimvox:open-chat", target.chatId);
  });

  // How the cards look and sound, as the window last said: the app's own notices (an update, the tray) look the same.
  let look: Omit<NoticeRequest, "title" | "body"> = { dark: nativeTheme.shouldUseDarkColors, mode: "projects", locale: app.getLocale().startsWith("ru") ? "ru" : "en", sound: "drop", volume: 0.6 };
  ipcMain.on("drimvox:notice-look", (event, value: unknown) => {
    if (!fromOurPage(event.senderFrame?.url)) return;
    const request = noticeRequest({ ...(value as object), title: "", body: "" });
    if (request) look = { dark: request.dark, mode: request.mode, locale: request.locale, sound: request.sound, volume: request.volume };
  });
  notifyWith((title, body) => {
    if (process.env.DRIMVOX_TEST_UNFOCUSED === "1") {
      ((globalThis as { drimvoxNotices?: unknown[] }).drimvoxNotices ??= []).push({ title, body, click: () => {} });
      return;
    }
    void showNotice(origin, { ...look, title, body }, {});
  });

  ipcMain.on("drimvox:notify", (event, notice: unknown) => {
    if (!fromOurPage(event.senderFrame?.url)) return;
    const request = noticeRequest(notice);
    if (!request) return;
    const { taskId, projectId, chatId } = (notice ?? {}) as { taskId?: unknown; projectId?: unknown; chatId?: unknown };
    const id = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    const target = { taskId: id(taskId), projectId: id(projectId), chatId: id(chatId) };
    // Tests cannot take the focus away from the window; they say it is elsewhere.
    const away = process.env.DRIMVOX_TEST_UNFOCUSED === "1" || !win?.isFocused();
    if (!away) return;
    if (process.env.DRIMVOX_TEST_UNFOCUSED === "1") {
      // Tests read and click notifications here instead of on the desktop.
      const shown = ((globalThis as { drimvoxNotices?: unknown[] }).drimvoxNotices ??= []);
      const click = () => {
        if (target.taskId) win?.webContents.send("drimvox:open-task", target.taskId);
        else if (target.projectId) win?.webContents.send("drimvox:open-project", target.projectId);
        else if (target.chatId) win?.webContents.send("drimvox:open-chat", target.chatId);
      };
      shown.push({ title: request.title, body: request.body, taskId: target.taskId ?? "", projectId: target.projectId ?? "", chatId: target.chatId ?? "", click });
      return;
    }
    void showNotice(origin, request, target);
    // The taskbar button blinks too, until the window is in front again.
    win?.flashFrame(true);
  });

  // The panel's page box: the agent's tab is put over it, or out of sight when the panel closes.
  ipcMain.on("drimvox:browser-place", (event, place: unknown) => {
    if (!fromOurPage(event.senderFrame?.url)) return;
    const p = place as Record<string, unknown> | null;
    const ok = p && ["x", "y", "width", "height"].every((k) => typeof p[k] === "number" && Number.isFinite(p[k]));
    // The page's pixels are the window's only at 100% zoom.
    const zoom = event.sender.getZoomFactor();
    const at = ok ? { x: (p.x as number) * zoom, y: (p.y as number) * zoom, width: (p.width as number) * zoom, height: (p.height as number) * zoom } : null;
    agentView.setPlace(at && at.width > 50 && at.height > 50 ? at : null);
  });
  // A click on Drimvox's own page takes the keyboard back from the agent's tab (seen: after the tab was shown, nothing
  // could be typed into the address or anywhere else).
  ipcMain.on("drimvox:focus-page", (event) => {
    if (!fromOurPage(event.senderFrame?.url) || event.sender.isFocused()) return;
    event.sender.focus();
  });

  // Settings: one notification now, whatever window is in front, to see and hear how they come.
  ipcMain.on("drimvox:notify-test", (event, notice: unknown) => {
    if (!fromOurPage(event.senderFrame?.url)) return;
    const request = noticeRequest(notice);
    if (request) void showNotice(origin, request, {});
  });

  const hex = /^#[0-9a-f]{6}$/i;
  ipcMain.on("drimvox:titlebar", (event, colors: { background?: unknown; symbols?: unknown }) => {
    const { background, symbols } = colors ?? {};
    if (typeof background !== "string" || typeof symbols !== "string") return;
    if (!hex.test(background) || !hex.test(symbols)) return;
    const target = BrowserWindow.fromWebContents(event.sender);
    if (process.platform !== "darwin") target?.setTitleBarOverlay({ color: background, symbolColor: symbols });
    target?.setBackgroundColor(background);
  });
}

async function createWindow(view?: "local" | "local-images") {
  const dark = nativeTheme.shouldUseDarkColors;
  // About 80% of the screen's width, as Claude Code opens (asked for); the height as before, within the screen.
  const area = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.max(960, Math.min(area.width, Math.round(area.width * 0.8))),
    height: Math.min(860, area.height),
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: "Drimvox",
    backgroundColor: dark ? "#1b1b19" : "#e4e5e0",
    titleBarStyle: "hidden",
    // A little lower than the 44px bar, so its bottom line runs under the window buttons at any display scale.
    titleBarOverlay: { color: dark ? "#222220" : "#eeefea", symbolColor: dark ? "#e9e8e2" : "#22211e", height: 42 },
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Task updates keep coming while the window is in the background; notifications depend on them.
      backgroundThrottling: false,
    },
  });

  attachContextMenu(win.webContents);
  const ru = app.getLocale().startsWith("ru");
  keepInTray(
    () => win,
    () => quitting,
    ru
      ? { open: "Открыть Drimvox", quit: "Выйти", hidden: "Drimvox работает в фоне", hiddenBody: "Агенты и запущенные проекты продолжают работать. Открыть или выйти — значок в трее." }
      : { open: "Open Drimvox", quit: "Quit", hidden: "Drimvox runs in the background", hiddenBody: "Agents and started projects go on. Open or quit from the tray icon." },
  )(win);
  win.once("ready-to-show", () => win?.show());
  win.on("closed", () => (win = null));
  win.on("focus", () => win?.flashFrame(false));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!fromOurPage(url)) event.preventDefault();
  });

  await win.loadURL(view ? `${origin}#${view}` : origin);
}

app.on("window-all-closed", () => app.quit());
let quitting = false;
let stopping = false;
app.on("before-quit", (event) => {
  // The window closes for good now, not into the tray.
  quitting = true;
  const child = core;
  if (!child || stopping) return;
  // The core stops what it started, such as Ollama, before it goes; a hung core is stopped hard.
  event.preventDefault();
  stopping = true;
  child.once("exit", () => {
    core = null;
    app.quit();
  });
  child.postMessage({ type: "quit" });
  setTimeout(() => child.kill(), 3_000).unref();
});
