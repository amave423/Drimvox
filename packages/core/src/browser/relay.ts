import type { BrowserDriver, BrowserState } from "./driver";

/** What the desktop's main process does with the browser it holds, asked by name. */
export type BrowserCall = (op: "open" | "newTab" | "select" | "close" | "back" | "reload" | "command" | "stop", args: unknown[]) => Promise<unknown>;

/**
 * The desktop's browser (asked for: a real browser inside Drimvox, like Claude's): its tabs live in the window, in the
 * main process; the core asks for everything by message and hears of every change.
 */
export class RelayBrowser implements BrowserDriver {
  private now: BrowserState = { running: false, url: "", title: "", tabs: [], active: null };
  private readonly listeners = new Set<(s: BrowserState) => void>();

  constructor(private readonly call: BrowserCall) {}

  /** The main process tells what its tabs are now. */
  update(state: BrowserState): void {
    this.now = state;
    for (const l of this.listeners) l(state);
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

  async open(url: string): Promise<void> {
    await this.call("open", [url]);
  }

  async newTab(url = "about:blank"): Promise<void> {
    await this.call("newTab", [url]);
  }

  async select(id: string): Promise<void> {
    await this.call("select", [id]);
  }

  async close(id: string): Promise<void> {
    await this.call("close", [id]);
  }

  async back(): Promise<void> {
    await this.call("back", []);
  }

  async reload(): Promise<void> {
    await this.call("reload", []);
  }

  command(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.call("command", [method, params]);
  }

  async stop(): Promise<void> {
    await this.call("stop", []).catch(() => {});
  }
}
