import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

/** One picture of the page the agent's browser shows, with the page's size in its own pixels. */
export interface BrowserFrame {
  data: string;
  width: number;
  height: number;
}

export interface BrowserState {
  running: boolean;
  url: string;
  title: string;
}

/** What the user does in the browser's panel, in the page's own pixels. */
export type BrowserInput =
  | { type: "mouse"; action: "down" | "up" | "move"; x: number; y: number; button?: "left" | "right" | "middle"; clicks?: number }
  | { type: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
  | { type: "key"; key: string }
  | { type: "text"; text: string };

type Listener = { frame(f: BrowserFrame): void; state(s: BrowserState): void };

const WIDTH = 1280;
const HEIGHT = 860;
/** Keys that are not text, as the browser wants them. */
const KEYS: Record<string, { code: string; vk: number }> = {
  Enter: { code: "Enter", vk: 13 },
  Backspace: { code: "Backspace", vk: 8 },
  Tab: { code: "Tab", vk: 9 },
  Escape: { code: "Escape", vk: 27 },
  Delete: { code: "Delete", vk: 46 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
  PageUp: { code: "PageUp", vk: 33 },
  PageDown: { code: "PageDown", vk: 34 },
};

/** Chrome or Edge on this computer, or the Chromium Playwright downloaded; null when there is none. */
export function findBrowser(): string | null {
  const env = process.env;
  const candidates =
    process.platform === "win32"
      ? [
          join(env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
          join(env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
          join(env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
          join(env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
          join(env.PROGRAMFILES ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
        ]
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge", "/snap/bin/chromium"];
  const found = candidates.find((p) => p && existsSync(p));
  if (found) return found;
  // Playwright's own Chromium, when the browser server has downloaded it.
  const cache = process.platform === "win32" ? join(env.LOCALAPPDATA ?? "", "ms-playwright") : join(env.HOME ?? "", process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
  try {
    const dirs = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    for (const d of dirs) {
      const exe = process.platform === "win32" ? join(cache, d, "chrome-win", "chrome.exe") : process.platform === "darwin" ? join(cache, d, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium") : join(cache, d, "chrome-linux", "chrome");
      if (existsSync(exe)) return exe;
    }
  } catch {
    // No cache.
  }
  return null;
}

/**
 * A user agent without "Headless" in it (sites turn such visitors away): the version from the folder next to the
 * browser, as Chrome and Edge install themselves on Windows; none where it cannot be told.
 */
function userAgent(exe: string): string | null {
  try {
    const version = readdirSync(dirname(exe)).find((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d));
    if (!version) return null;
    const edge = /msedge/i.test(exe);
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36${edge ? ` Edg/${version}` : ""}`;
  } catch {
    return null;
  }
}

/**
 * The agent's own browser (asked for: not a window jumping in front, but a panel in Drimvox, like Claude's): Chrome or
 * Edge without a window, with a profile of its own that keeps sign-ins and passed checks. The Playwright server drives
 * it over the DevTools protocol; Drimvox's panel watches its current tab and lets the user click and type in it.
 */
export class AgentBrowser {
  private proc: ChildProcess | null = null;
  private starting: Promise<string> | null = null;
  private ws: WebSocket | null = null;
  private next = 1;
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private readonly pages: { id: string; url: string; title: string }[] = [];
  private active: string | null = null;
  private session: string | null = null;
  private readonly listeners = new Set<Listener>();
  private lastFrame: BrowserFrame | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly o: { profileDir: string; find?: () => string | null }) {}

  /** Where the Playwright server keeps its page snapshots. */
  get outputDir(): string {
    return join(dirname(this.o.profileDir), "playwright-output");
  }

  /** Starts the browser when it is not running; its DevTools address. */
  endpoint(): Promise<string> {
    if (this.starting) return this.starting;
    this.starting = this.launch().catch((err) => {
      this.starting = null;
      throw err;
    });
    return this.starting;
  }

  /** The current tab's title and address, read from the page itself (the browser does not always say them). */
  async refresh(): Promise<void> {
    const session = this.session;
    const page = this.pages.find((p) => p.id === this.active);
    if (!session || !page) return;
    try {
      const r = (await this.send("Runtime.evaluate", { expression: "JSON.stringify([document.title, location.href])", returnByValue: true }, session)) as { result?: { value?: string } };
      const [title, url] = JSON.parse(r.result?.value ?? "[]") as [string?, string?];
      if ((title !== undefined && title !== page.title) || (url !== undefined && url !== page.url)) {
        Object.assign(page, { title: title ?? page.title, url: url ?? page.url });
        this.broadcastState();
      }
    } catch {
      // The page is between documents.
    }
  }

  state(): BrowserState {
    const page = this.pages.find((p) => p.id === this.active);
    return { running: !!this.proc && !!this.ws, url: page?.url ?? "", title: page?.title ?? "" };
  }

  /** Pictures of the current tab while someone watches; returns the way to stop watching. */
  watch(listener: Listener): () => void {
    this.listeners.add(listener);
    listener.state(this.state());
    if (this.lastFrame) listener.frame(this.lastFrame);
    if (this.listeners.size === 1) {
      void this.show();
      this.ticker = setInterval(() => void this.refresh(), 1000);
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        if (this.ticker) clearInterval(this.ticker);
        this.ticker = null;
        void this.hide();
      }
    };
  }

  async input(e: BrowserInput): Promise<void> {
    if (!this.session) return;
    if (e.type === "mouse") {
      const type = e.action === "down" ? "mousePressed" : e.action === "up" ? "mouseReleased" : "mouseMoved";
      await this.send("Input.dispatchMouseEvent", { type, x: e.x, y: e.y, button: e.action === "move" ? "none" : (e.button ?? "left"), clickCount: e.action === "move" ? 0 : (e.clicks ?? 1) }, this.session);
    } else if (e.type === "wheel") {
      await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: e.x, y: e.y, deltaX: e.deltaX, deltaY: e.deltaY }, this.session);
    } else if (e.type === "text") {
      await this.send("Input.insertText", { text: e.text }, this.session);
    } else {
      const k = KEYS[e.key];
      if (!k) return;
      const key = { key: e.key, code: k.code, windowsVirtualKeyCode: k.vk };
      await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...key, ...(e.key === "Enter" ? { text: "\r" } : {}) }, this.session);
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }, this.session);
    }
  }

  /** Opens an address in the current tab; starts the browser first if needed. */
  async open(url: string): Promise<void> {
    await this.endpoint();
    await this.ensurePage();
    if (this.session) await this.send("Page.navigate", { url }, this.session);
  }

  async back(): Promise<void> {
    if (this.session) await this.send("Runtime.evaluate", { expression: "history.back()" }, this.session);
  }

  async reload(): Promise<void> {
    if (this.session) await this.send("Page.reload", {}, this.session);
  }

  async stop(): Promise<void> {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.ws?.close();
    this.ws = null;
    this.proc?.kill();
    this.proc = null;
    this.starting = null;
    this.session = null;
    this.active = null;
    this.pages.length = 0;
    this.broadcastState();
  }

  private async launch(): Promise<string> {
    const exe = (this.o.find ?? findBrowser)();
    if (!exe) throw new Error("No Chrome or Edge on this computer");
    mkdirSync(this.o.profileDir, { recursive: true });
    const portFile = join(this.o.profileDir, "DevToolsActivePort");
    rmSync(portFile, { force: true });
    const ua = userAgent(exe);
    const args = [
      `--user-data-dir=${this.o.profileDir}`,
      "--remote-debugging-port=0",
      "--headless=new",
      `--window-size=${WIDTH},${HEIGHT}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      ...(ua ? [`--user-agent=${ua}`] : []),
      "about:blank",
    ];
    const proc = spawn(exe, args, { stdio: "ignore", windowsHide: true });
    this.proc = proc;
    proc.once("exit", () => {
      if (this.proc === proc) void this.stop();
    });
    // The browser says its port in a file in its profile once it listens.
    let port = 0;
    for (let i = 0; i < 100 && !port; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (existsSync(portFile)) port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
    }
    if (!port) {
      proc.kill();
      throw new Error("The browser did not start");
    }
    const endpoint = `http://127.0.0.1:${port}`;
    const version = (await (await fetch(`${endpoint}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    await this.connect(version.webSocketDebuggerUrl);
    return endpoint;
  }

  private connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => {
        this.ws = ws;
        void this.send("Target.setDiscoverTargets", { discover: true }).then(() => resolve(), reject);
      };
      ws.onerror = () => reject(new Error("No connection to the browser"));
      ws.onclose = () => {
        if (this.ws === ws) this.ws = null;
      };
      ws.onmessage = (ev) => this.receive(JSON.parse(String(ev.data)) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string }; sessionId?: string });
    });
  }

  private receive(m: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string }; sessionId?: string }): void {
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) p?.reject(new Error(m.error.message));
      else p?.resolve(m.result);
      return;
    }
    const params = m.params ?? {};
    if (m.method === "Target.targetCreated" || m.method === "Target.targetInfoChanged") {
      const info = params.targetInfo as { targetId: string; type: string; url: string; title: string };
      if (info.type !== "page") return;
      const known = this.pages.find((p) => p.id === info.targetId);
      if (known) {
        const moved = known.url !== info.url;
        Object.assign(known, { url: info.url, title: info.title });
        // The tab the agent works in is the one that just went somewhere.
        if (moved && info.url !== "about:blank") void this.follow(info.targetId);
      } else {
        this.pages.push({ id: info.targetId, url: info.url, title: info.title });
        void this.follow(info.targetId);
      }
      this.broadcastState();
    } else if (m.method === "Target.targetDestroyed") {
      const id = params.targetId as string;
      const i = this.pages.findIndex((p) => p.id === id);
      if (i >= 0) this.pages.splice(i, 1);
      if (this.active === id) void this.follow(this.pages.at(-1)?.id ?? null);
      this.broadcastState();
    } else if ((m.method === "Page.loadEventFired" || m.method === "Page.domContentEventFired") && m.sessionId === this.session) {
      void this.refresh();
    } else if (m.method === "Page.screencastFrame" && m.sessionId === this.session) {
      const meta = params.metadata as { deviceWidth: number; deviceHeight: number };
      this.lastFrame = { data: params.data as string, width: meta.deviceWidth, height: meta.deviceHeight };
      for (const l of this.listeners) l.frame(this.lastFrame);
      void this.send("Page.screencastFrameAck", { sessionId: params.sessionId }, this.session).catch(() => {});
    }
  }

  private send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    const ws = this.ws;
    if (!ws) return Promise.reject(new Error("The browser is not running"));
    const id = this.next++;
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 15_000);
    });
  }

  /** The tab the panel shows: attached to, watched while someone looks. */
  private async follow(targetId: string | null): Promise<void> {
    if (targetId === this.active && this.session) return;
    const old = this.session;
    this.active = targetId;
    this.session = null;
    if (old) void this.send("Target.detachFromTarget", { sessionId: old }).catch(() => {});
    if (!targetId) return this.broadcastState();
    try {
      const { sessionId } = (await this.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
      if (this.active !== targetId) return;
      this.session = sessionId;
      await this.send("Page.enable", {}, sessionId);
      if (this.listeners.size) await this.show();
    } catch {
      // The tab went away meanwhile.
    }
    this.broadcastState();
  }

  private async ensurePage(): Promise<void> {
    if (this.session) return;
    const page = this.pages.at(-1);
    if (page) return this.follow(page.id);
    const { targetId } = (await this.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
    await this.follow(targetId);
  }

  private async show(): Promise<void> {
    if (!this.ws) return;
    await this.ensurePage().catch(() => {});
    if (!this.session) return;
    await this.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1 }, this.session).catch(() => {});
  }

  private async hide(): Promise<void> {
    if (this.session) await this.send("Page.stopScreencast", {}, this.session).catch(() => {});
  }

  private broadcastState(): void {
    const s = this.state();
    for (const l of this.listeners) l.state(s);
  }
}

/**
 * The Playwright server's command pointed at the agent's browser: its own browser options taken out, the DevTools
 * address put in.
 */
export function playwrightArgs(args: string[], endpoint: string, outputDir?: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--headless" || a === "--headed" || a === "--isolated") continue;
    if (a === "--cdp-endpoint" || a === "--browser" || a === "--user-data-dir" || (outputDir && a === "--output-dir")) {
      i++;
      continue;
    }
    if (/^--(cdp-endpoint|browser|user-data-dir)=/.test(a) || (outputDir && a.startsWith("--output-dir="))) continue;
    out.push(a);
  }
  // Its page snapshots go to Drimvox's data, not to whatever folder the app was started in (seen: a folder of them in
  // the sources).
  return [...out, "--cdp-endpoint", endpoint, ...(outputDir ? ["--output-dir", outputDir] : [])];
}
