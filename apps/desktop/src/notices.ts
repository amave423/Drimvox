import { BrowserWindow, ipcMain, screen } from "electron";
import { join } from "node:path";

/** What a notification opens when clicked. */
export interface NoticeTarget {
  taskId?: string;
  projectId?: string;
  chatId?: string;
}

/** What the page asks to show: checked here, it comes from the renderer. */
export interface NoticeRequest {
  title: string;
  body: string;
  dark: boolean;
  mode: "chat" | "projects";
  locale: "ru" | "en";
  sound: "drop" | "chime" | "soft" | "pop" | "off";
  volume: number;
}

const WIDTH = 380;
const EDGE = 8;
const SOUNDS = new Set(["drop", "chime", "soft", "pop", "off"]);

let win: BrowserWindow | null = null;
let loaded: Promise<unknown> | null = null;
const targets = new Map<string, NoticeTarget>();
let count = 0;

/** A request as the page sent it, or null when it is not one. */
export function noticeRequest(value: unknown): NoticeRequest | null {
  const v = (value ?? {}) as Record<string, unknown>;
  if (typeof v.title !== "string" || typeof v.body !== "string") return null;
  return {
    title: v.title.slice(0, 120),
    body: v.body.slice(0, 300),
    dark: v.dark === true,
    mode: v.mode === "chat" ? "chat" : "projects",
    locale: v.locale === "en" ? "en" : "ru",
    sound: typeof v.sound === "string" && SOUNDS.has(v.sound) ? (v.sound as NoticeRequest["sound"]) : "drop",
    volume: typeof v.volume === "number" && Number.isFinite(v.volume) ? Math.min(1, Math.max(0, v.volume)) : 0.6,
  };
}

/**
 * Drimvox's own notifications (asked for: like Telegram's, with its own sound): a see-through window at the bottom
 * right of the screen, over everything and never taking the focus, with the cards drawn by the page (apps/web/src/notice).
 * It is as tall as its cards and hides when they are gone; a click on one opens what it is about.
 */
export function setupNotices(open: (target: NoticeTarget) => void): void {
  ipcMain.on("drimvox:notice-size", (event, height: unknown) => {
    if (!win || event.sender !== win.webContents || typeof height !== "number") return;
    place(height);
  });
  ipcMain.on("drimvox:notice-open", (event, id: unknown) => {
    if (!win || event.sender !== win.webContents || typeof id !== "string") return;
    const target = targets.get(id);
    targets.delete(id);
    if (target) open(target);
  });
}

/** Shows one notification; `silent` while Windows' Focus Assist asks for quiet. */
export async function showNotice(origin: string, request: NoticeRequest, target: NoticeTarget, silent: boolean): Promise<void> {
  if (!win) create(origin);
  await loaded;
  if (!win) return;
  const id = `n${++count}`;
  targets.set(id, target);
  // A click is looked up by its id for a while; old ones are forgotten.
  if (targets.size > 50) targets.delete(targets.keys().next().value!);
  win.webContents.send("drimvox:notice", { ...request, id, silent });
}

function create(origin: string): void {
  win = new BrowserWindow({
    width: WIDTH,
    height: 10,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    title: "Drimvox",
    webPreferences: {
      preload: join(__dirname, "notice-preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  // Over full-screen windows too, like a messenger's.
  win.setAlwaysOnTop(true, "screen-saver");
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.on("closed", () => {
    win = null;
    loaded = null;
  });
  loaded = win.loadURL(`${origin}#notice`).catch(() => null);
}

/** Fits the window to its cards at the bottom right of the work area (above the taskbar); none: hidden. */
function place(height: number): void {
  if (!win) return;
  if (height <= 0) {
    win.hide();
    return;
  }
  const area = screen.getPrimaryDisplay().workArea;
  const h = Math.min(Math.ceil(height), area.height - EDGE * 2);
  win.setBounds({ x: area.x + area.width - WIDTH - EDGE, y: area.y + area.height - h - EDGE, width: WIDTH, height: h });
  if (!win.isVisible()) win.showInactive();
}
