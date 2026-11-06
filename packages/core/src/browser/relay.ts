import type { BrowserDriver, BrowserState } from "./driver";

/** What the desktop's main process does with the browser it holds, asked by name. */
export type BrowserCall = (op: "open" | "newTab" | "select" | "close" | "back" | "reload" | "command" | "stop" | "proxy", args: unknown[]) => Promise<unknown>;

/**
 * The desktop's browser (asked for: a real browser inside Drimvox, like Claude's): its tabs live in the window, in the
 * main process; the core asks for everything by message and hears of every change.
 */
export class RelayBrowser implements BrowserDriver {
  private now: BrowserState = { running: false, url: "", title: "", tabs: [], active: null };
  private readonly listeners = new Set<(s: BrowserState) => void>();
  private readonly blockedListeners = new Set<(host: string) => void>();

  private readonly call: BrowserCall;

  /**
   * Every request answers within `timeoutMs` or fails (seen live: a tab out of sight never answered a device emulation,
   * and a project's agent waited on it for twenty minutes while the run said "working").
   */
  constructor(call: BrowserCall, timeoutMs = 30_000) {
    this.call = (op, args) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`The browser did not answer "${op}" within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
        call(op, args).then(
          (v) => (clearTimeout(timer), resolve(v)),
          (e: unknown) => (clearTimeout(timer), reject(e)),
        );
      });
  }

  /** The main process tells what its tabs are now. */
  update(state: BrowserState): void {
    this.now = state;
    for (const l of this.listeners) l(state);
  }

  /** The main process found a site that opens only through the proxy. */
  blocked(host: string): void {
    for (const l of this.blockedListeners) l(host);
  }

  onBlocked(listener: (host: string) => void): () => void {
    this.blockedListeners.add(listener);
    return () => void this.blockedListeners.delete(listener);
  }

  async useProxy(proxy: string | null, hosts: string[]): Promise<void> {
    await this.call("proxy", [proxy, hosts]);
  }

  available(): boolean {
    return true;
  }

  state(): BrowserState {
    return this.now;
  }

  onState(listener: (s: BrowserState) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  async open(url: string, tab?: string): Promise<void> {
    await this.call("open", [url, tab]);
  }

  async newTab(url = "about:blank"): Promise<string> {
    return String(await this.call("newTab", [url]));
  }

  async select(id: string): Promise<void> {
    await this.call("select", [id]);
  }

  async close(id: string): Promise<void> {
    await this.call("close", [id]);
  }

  async back(tab?: string): Promise<void> {
    await this.call("back", [tab]);
  }

  async reload(tab?: string): Promise<void> {
    await this.call("reload", [tab]);
  }

  command(method: string, params: Record<string, unknown> = {}, tab?: string): Promise<unknown> {
    return this.call("command", [method, params, tab]);
  }

  async stop(): Promise<void> {
    await this.call("stop", []).catch(() => {});
  }
}
