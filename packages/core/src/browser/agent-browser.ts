import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { keyPress, type BrowserDriver, type BrowserState } from "./driver";
import { findBrowser, userAgent } from "./launch";

export { findBrowser, playwrightArgs } from "./launch";
export type { BrowserState, BrowserTab } from "./driver";

/** One picture of the page the agent's browser shows, with the page's size in its own pixels. */
export interface BrowserFrame {
  data: string;
  /** The page's size in its own (CSS) pixels; the picture is `scale` times larger, for a dense screen. */
  width: number;
  height: number;
  scale: number;
}

/** What the user does in the browser's panel, in the page's own pixels. */
export type BrowserInput =
  | { type: "mouse"; action: "down" | "up" | "move"; x: number; y: number; button?: "left" | "right" | "middle"; clicks?: number; buttons?: number }
  | { type: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
  | { type: "key"; key: string; modifiers?: number }
  | { type: "text"; text: string };

type Listener = { frame(f: BrowserFrame): void; state(s: BrowserState): void };

const WIDTH = 1280;
const HEIGHT = 860;
/**
 * The agent's own browser (asked for: not a window jumping in front, but a panel in Drimvox, like Claude's): Chrome or
 * Edge without a window, with a profile of its own that keeps sign-ins and passed checks. The Playwright server drives
 * it over the DevTools protocol; Drimvox's panel watches its current tab and lets the user click and type in it.
 */
export class AgentBrowser implements BrowserDriver {
  private proc: ChildProcess | null = null;
  private starting: Promise<string> | null = null;
  private ws: WebSocket | null = null;
  private next = 1;
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private readonly pages: { id: string; url: string; title: string }[] = [];
  private active: string | null = null;
  private session: string | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly stateListeners = new Set<(s: BrowserState) => void>();
  private lastFrame: BrowserFrame | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  /** The panel's size: the page takes it (asked for: a browser, not a picture of one squeezed into the panel). */
  private size = { width: WIDTH, height: HEIGHT, scale: 1 };

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
    return {
      running: !!this.proc && !!this.ws,
      url: page?.url ?? "",
      title: page?.title ?? "",
      tabs: this.pages.map((p) => ({ ...p })),
      active: this.active,
    };
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
      // A move with a button held is a drag or a selection: the browser is told which button.
      const held = e.action === "move" && (e.buttons ?? 0) > 0;
      const button = e.action === "move" ? (held ? (e.buttons! & 1 ? "left" : e.buttons! & 2 ? "right" : "middle") : "none") : (e.button ?? "left");
      await this.send("Input.dispatchMouseEvent", { type, x: e.x, y: e.y, button, buttons: e.buttons ?? (e.action === "down" ? 1 : 0), clickCount: e.action === "move" ? 0 : (e.clicks ?? 1) }, this.session);
    } else if (e.type === "wheel") {
      await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: e.x, y: e.y, deltaX: e.deltaX, deltaY: e.deltaY }, this.session);
    } else if (e.type === "text") {
      await this.send("Input.insertText", { text: e.text }, this.session);
    } else {
      // A named key, or a letter or digit with Ctrl and the like (a plain one comes as text).
      const press = keyPress(e.key, e.modifiers ?? 0);
      if (!press) return;
      for (const event of press) await this.send("Input.dispatchKeyEvent", event, this.session);
    }
  }

  available(): boolean {
    return !!(this.o.find ?? findBrowser)();
  }

  onState(listener: (s: BrowserState) => void): () => void {
    this.stateListeners.add(listener);
    return () => void this.stateListeners.delete(listener);
  }

  async command(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    await this.endpoint();
    await this.ensurePage();
    if (!this.session) throw new Error("The browser has no tab");
    return this.send(method, params, this.session);
  }

  restoreSize(): Promise<void> {
    return this.applySize();
  }

  /** Opens an address in the current tab; starts the browser first if needed. */
  async open(url: string): Promise<void> {
    await this.endpoint();
    await this.ensurePage();
    if (this.session) await this.send("Page.navigate", { url }, this.session);
  }

  /** The page takes the panel's size, in CSS pixels, with the screen's density for sharp pictures. */
  async resize(width: number, height: number, scale: number): Promise<void> {
    const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);
    this.size = { width: Math.round(clamp(width, 320, 3840)), height: Math.round(clamp(height, 200, 2400)), scale: clamp(scale, 1, 3) };
    await this.applySize();
  }

  /** A value from the shown tab's page. */
  async evaluate(expression: string): Promise<unknown> {
    if (!this.session) return undefined;
    const r = (await this.send("Runtime.evaluate", { expression, returnByValue: true }, this.session)) as { result?: { value?: unknown } };
    return r.result?.value;
  }

  /** A new tab, shown at once. */
  async newTab(url = "about:blank"): Promise<void> {
    await this.endpoint();
    const { targetId } = (await this.send("Target.createTarget", { url })) as { targetId: string };
    await this.follow(targetId);
  }

  /** Shows another tab in the panel and brings it to the front of the browser. */
  async select(id: string): Promise<void> {
    if (!this.pages.some((p) => p.id === id)) return;
    await this.send("Target.activateTarget", { targetId: id }).catch(() => {});
    await this.follow(id);
    await this.refresh();
  }

  async close(id: string): Promise<void> {
    if (!this.pages.some((p) => p.id === id)) return;
    await this.send("Target.closeTarget", { targetId: id });
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
      this.lastFrame = { data: params.data as string, width: meta.deviceWidth, height: meta.deviceHeight, scale: this.size.scale };
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
      await this.applySize();
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
    const { width, height, scale } = this.size;
    await this.send("Page.startScreencast", { format: "jpeg", quality: 80, maxWidth: Math.round(width * scale), maxHeight: Math.round(height * scale), everyNthFrame: 1 }, this.session).catch(() => {});
  }

  /** The shown tab's window and page at the panel's size; the pictures follow it. */
  private async applySize(): Promise<void> {
    const session = this.session;
    const target = this.active;
    if (!session || !target) return;
    const { width, height, scale } = this.size;
    try {
      const { windowId } = (await this.send("Browser.getWindowForTarget", { targetId: target })) as { windowId: number };
      await this.send("Browser.setWindowBounds", { windowId, bounds: { width, height } });
    } catch {
      // Some builds keep the window's size; the page's own size below is what counts.
    }
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false }, session).catch(() => {});
    if (this.listeners.size) {
      await this.send("Page.stopScreencast", {}, session).catch(() => {});
      await this.show();
    }
  }

  private async hide(): Promise<void> {
    if (this.session) await this.send("Page.stopScreencast", {}, this.session).catch(() => {});
  }

  private broadcastState(): void {
    const s = this.state();
    for (const l of this.listeners) l.state(s);
    for (const l of this.stateListeners) l(s);
  }
}
