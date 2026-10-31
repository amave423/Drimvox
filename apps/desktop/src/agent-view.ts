import { app, session, WebContentsView, type BrowserWindow, type Session } from "electron";
import { join } from "node:path";

export interface AgentTabState {
  running: boolean;
  url: string;
  title: string;
  tabs: { id: string; url: string; title: string }[];
  active: string | null;
}

/** Where the panel's page box is in the window, in its CSS pixels; null while the panel is closed. */
export type Place = { x: number; y: number; width: number; height: number } | null;

/** The size a tab has while nobody looks: the page is laid out as on a desktop screen. */
const UNSEEN = { width: 1280, height: 860 };

/**
 * Chromium's errors of the connection itself — reset, refused, timed out, no name, closed in the middle — as a block
 * shows up from Russia; an answer of the site (404, 500) or a stopped load is not one of them.
 */
const CONNECTION_ERRORS = new Set([-7, -15, -100, -101, -102, -104, -105, -106, -107, -109, -118, -137, -324]);

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
};

/**
 * A PAC script: the listed sites (and their subdomains) through the proxy, everything else directly (asked for: some
 * Russian sites refuse visitors through a proxy).
 */
export function pacScript(proxyUrl: string, hosts: string[]): string {
  const u = new URL(proxyUrl);
  const kind = u.protocol.startsWith("socks") ? "SOCKS5" : u.protocol === "https:" ? "HTTPS" : "PROXY";
  const port = u.port || (u.protocol === "https:" ? "443" : u.protocol.startsWith("socks") ? "1080" : "80");
  const list = JSON.stringify(hosts);
  return `function FindProxyForURL(url, host) {
  host = host.toLowerCase();
  var sites = ${list};
  for (var i = 0; i < sites.length; i++) {
    if (host === sites[i] || host === "www." + sites[i] || dnsDomainIs(host, "." + sites[i])) return "${kind} ${u.hostname}:${port}";
  }
  return "DIRECT";
}`;
}

/**
 * The agent's browser on the desktop (asked for: a browser exactly like Claude's, not a picture of one): real Chromium
 * tabs inside Drimvox's window, in a session of their own that keeps sign-ins and passed checks. The core drives the
 * shown tab over the DevTools protocol; the panel puts the tab over its page box, where the user clicks, types and passes
 * a captcha as in any browser. While the panel is closed the tab works on, out of sight, at a desktop's size.
 */
export class AgentView {
  private readonly tabs: { id: string; view: WebContentsView }[] = [];
  private active: string | null = null;
  private place: Place = null;
  private next = 1;
  private profile: Session | null = null;
  /** The proxy and the sites that go through it; null: everything directly. */
  private proxy: { url: string; hosts: string[] } | null = null;
  /** Sites tried through the proxy after they did not open directly, by the tab trying. */
  private readonly trials = new Map<number, string>();

  constructor(
    private readonly window: () => BrowserWindow | null,
    private readonly changed: (state: AgentTabState) => void,
    /** A site that opened only through the proxy: the core remembers it. */
    private readonly blocked: (host: string) => void = () => {},
  ) {}

  state(): AgentTabState {
    const shown = this.shown();
    const describe = (t: { id: string; view: WebContentsView }) => ({ id: t.id, url: t.view.webContents.getURL(), title: t.view.webContents.getTitle() });
    return {
      running: this.tabs.length > 0,
      url: shown ? shown.view.webContents.getURL() : "",
      title: shown ? shown.view.webContents.getTitle() : "",
      tabs: this.tabs.map(describe),
      active: this.active,
    };
  }

  /** One of the core's requests, by name. */
  async call(op: string, args: unknown[]): Promise<unknown> {
    const str = (i: number) => (typeof args[i] === "string" ? (args[i] as string) : "");
    switch (op) {
      case "open":
        return this.open(str(0));
      case "newTab":
        return void this.newTab(str(0) || "about:blank");
      case "select":
        return this.select(str(0));
      case "close":
        return this.close(str(0));
      case "back":
        return void this.shown()?.view.webContents.navigationHistory.goBack();
      case "reload":
        return void this.shown()?.view.webContents.reload();
      case "command":
        return this.command(str(0), (args[1] ?? {}) as Record<string, unknown>);
      case "stop":
        for (const t of [...this.tabs]) this.close(t.id);
        return;
      case "proxy":
        return this.useProxy(typeof args[0] === "string" ? args[0] : null, Array.isArray(args[1]) ? args[1].filter((h): h is string => typeof h === "string") : []);
      default:
        throw new Error(`Unknown browser request ${op}`);
    }
  }

  /** The panel's page box moved, changed its size, opened or closed. */
  setPlace(place: Place): void {
    this.place = place;
    this.layout();
  }

  private async useProxy(url: string | null, hosts: string[]): Promise<void> {
    this.proxy = url ? { url, hosts } : null;
    await this.applyProxy();
  }

  /** The session's proxy: the listed sites and those on trial through it, the rest directly. */
  private async applyProxy(): Promise<void> {
    const s = this.session();
    if (!this.proxy) return s.setProxy({ mode: "direct" });
    const hosts = [...new Set([...this.proxy.hosts, ...this.trials.values()])];
    const pac = pacScript(this.proxy.url, hosts);
    await s.setProxy({ mode: "pac_script", pacScript: `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(pac).toString("base64")}` });
  }

  private covered(host: string): boolean {
    return !!this.proxy?.hosts.some((site) => host === site || host.endsWith(`.${site}`));
  }

  private shown() {
    return this.tabs.find((t) => t.id === this.active) ?? null;
  }

  private session(): Session {
    if (this.profile) return this.profile;
    const s = session.fromPartition("persist:agent-browser");
    // Sites turn away a browser that says it is Electron or Drimvox: it says what Chrome says.
    s.setUserAgent(app.userAgentFallback.replace(/\s(Electron|drimvox|Drimvox[^/]*)\/\S+/gi, ""));
    // Downloads go to Drimvox's own folder, never anywhere else on the computer.
    s.on("will-download", (_event, item) => item.setSavePath(join(app.getPath("userData"), "browser-downloads", item.getFilename())));
    // No camera, microphone, location or notifications for pages the agent opens.
    s.setPermissionRequestHandler((_wc, permission, done) => done(permission === "clipboard-sanitized-write" || permission === "fullscreen"));
    this.profile = s;
    return s;
  }

  private async open(url: string): Promise<void> {
    const tab = this.shown() ?? this.newTab("about:blank");
    await tab.view.webContents.loadURL(url).catch(() => {
      // A page that failed or was left for another still shows; the agent reads what is there.
    });
  }

  private newTab(url: string): { id: string; view: WebContentsView } {
    const view = new WebContentsView({
      webPreferences: { session: this.session(), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    const tab = { id: `tab-${this.next++}`, view };
    const wc = view.webContents;
    const tell = () => this.changed(this.state());
    wc.on("page-title-updated", tell);
    wc.on("did-navigate", tell);
    wc.on("did-navigate-in-page", tell);
    wc.on("did-stop-loading", tell);
    // A link that opens a window opens a tab of this browser instead.
    wc.setWindowOpenHandler(({ url: next }) => {
      if (/^https?:\/\//.test(next)) this.newTab(next);
      return { action: "deny" };
    });
    wc.on("will-navigate", (event, next) => {
      if (!/^(https?|about|data|blob):/.test(next)) event.preventDefault();
    });
    // A page that does not connect directly is tried once through the proxy; opened, its site is remembered.
    wc.on("did-fail-load", (_event, code, _text, failed, mainFrame) => {
      const host = hostOf(failed);
      if (!mainFrame || !this.proxy || !host || !CONNECTION_ERRORS.has(code) || this.covered(host)) return;
      if (this.trials.get(wc.id) === host) {
        // Through the proxy it failed too: the site is down, not blocked.
        this.trials.delete(wc.id);
        void this.applyProxy();
        return;
      }
      this.trials.set(wc.id, host);
      void this.applyProxy().then(() => wc.loadURL(failed).catch(() => {}));
    });
    wc.on("did-finish-load", () => {
      const host = this.trials.get(wc.id);
      if (!host || hostOf(wc.getURL()) !== host) return;
      this.trials.delete(wc.id);
      if (this.proxy) this.proxy.hosts = [...this.proxy.hosts, host];
      this.blocked(host);
    });
    // The proxy's own password, from its address in the settings.
    wc.on("login", (event, _details, info, callback) => {
      if (!info.isProxy || !this.proxy) return;
      const u = new URL(this.proxy.url);
      if (!u.username) return;
      event.preventDefault();
      callback(decodeURIComponent(u.username), decodeURIComponent(u.password));
    });
    wc.on("destroyed", () => {
      this.trials.delete(wc.id);
      this.forget(tab.id);
    });
    this.tabs.push(tab);
    this.active = tab.id;
    this.layout();
    if (url !== "about:blank") void wc.loadURL(url).catch(() => {});
    tell();
    return tab;
  }

  private async select(id: string): Promise<void> {
    if (!this.tabs.some((t) => t.id === id)) return;
    this.active = id;
    this.layout();
    this.changed(this.state());
  }

  private close(id: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    this.window()?.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
    this.forget(id);
  }

  private forget(id: string): void {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    this.tabs.splice(i, 1);
    if (this.active === id) this.active = this.tabs.at(-1)?.id ?? null;
    this.layout();
    this.changed(this.state());
  }

  private async command(method: string, params: Record<string, unknown>): Promise<unknown> {
    const tab = this.shown() ?? this.newTab("about:blank");
    const tools = tab.view.webContents.debugger;
    if (!tools.isAttached()) {
      tools.attach("1.3");
      // Out of sight the page never has the focus; it must believe it does, or typed text goes nowhere.
      await tools.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    }
    return tools.sendCommand(method, params);
  }

  /**
   * The shown tab over the panel's page box, in front of the interface; out of sight, it stays in the window but past its
   * left edge, at a desktop's size, so it keeps drawing and the agent works on. Other tabs leave the window.
   */
  private layout(): void {
    const win = this.window();
    if (!win || win.isDestroyed()) return;
    const root = win.contentView;
    for (const t of this.tabs) {
      if (t.id !== this.active) root.removeChildView(t.view);
    }
    const shown = this.shown();
    if (!shown) return;
    root.addChildView(shown.view);
    const p = this.place;
    shown.view.setBounds(p ? { x: Math.round(p.x), y: Math.round(p.y), width: Math.round(p.width), height: Math.round(p.height) } : { x: -UNSEEN.width - 50, y: 0, ...UNSEEN });
  }
}
