import type { BrowserDriver, BrowserState } from "./driver";

/**
 * One agent's way into the shared browser: a tab of its own, which its tools drive whatever tab the panel shows (seen
 * live: three projects at once, and one agent's screenshot "took someone else's tab"). The tab is made at the first
 * action; a blank tab nobody owns is taken instead of a new one.
 */
export class OwnTab implements BrowserDriver {
  private tab: string | null = null;
  /** The tab was seen in the browser's list: missing from it later, it was closed. */
  private seen = false;

  constructor(
    private readonly d: BrowserDriver,
    /** Whether another agent works in that tab. */
    private readonly taken: (tab: string) => boolean,
  ) {
    d.onState((s) => {
      if (!this.tab) return;
      if (s.tabs.some((t) => t.id === this.tab)) this.seen = true;
      else if (this.seen) this.forget();
    });
  }

  /** The agent's tab, if it has one now. */
  get id(): string | null {
    return this.tab;
  }

  private own(id: string): string {
    this.tab = id;
    this.seen = this.d.state().tabs.some((t) => t.id === id);
    return id;
  }

  private forget(): void {
    this.tab = null;
    this.seen = false;
  }

  private async mine(): Promise<string> {
    if (this.tab) return this.tab;
    const blank = this.d.state().tabs.find((t) => (t.url === "" || t.url === "about:blank") && !this.taken(t.id));
    return this.own(blank ? blank.id : await this.d.newTab("about:blank"));
  }

  available(): boolean {
    return this.d.available();
  }

  state(): BrowserState {
    return { ...this.d.state(), active: this.tab };
  }

  onState(listener: (state: BrowserState) => void): () => void {
    return this.d.onState(() => listener(this.state()));
  }

  async open(url: string): Promise<void> {
    await this.d.open(url, await this.mine());
  }

  /** A new tab, shown; the agent works in it from now on. */
  async newTab(url = "about:blank"): Promise<string> {
    return this.own(await this.d.newTab(url));
  }

  /** Shows a tab in the panel; the agent works in it from now on. */
  async select(id: string): Promise<void> {
    await this.d.select(id);
    this.own(id);
  }

  async close(id: string): Promise<void> {
    await this.d.close(id);
    if (id === this.tab) this.forget();
  }

  /** The agent's tab in the panel, where the user does what it asks (a check, a sign-in). */
  async show(): Promise<void> {
    if (this.tab) await this.d.select(this.tab).catch(() => {});
  }

  async back(): Promise<void> {
    await this.d.back(await this.mine());
  }

  async reload(): Promise<void> {
    await this.d.reload(await this.mine());
  }

  async command(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.d.command(method, params, await this.mine());
  }

  async restoreSize(): Promise<void> {
    await this.d.restoreSize?.(await this.mine());
  }

  async useProxy(proxy: string | null, hosts: string[]): Promise<void> {
    await this.d.useProxy?.(proxy, hosts);
  }

  stop(): Promise<void> {
    return this.d.stop();
  }
}
