import type { BrowserDriver, BrowserState } from "./driver";
import { OwnTab } from "./own-tab";

/** How long the agent waits for the user to pass a check in the browser before it goes on without. */
const ASK_MS = 30 * 60_000;

/** What an agent's browser tools use: the shared browser, or one agent's own tab in it (Browser.own). */
export type BrowserView = Pick<Browser, "driver" | "state" | "askUser" | "done">;

/**
 * The agent's browser as Drimvox shares it: whatever drives it, plus what the agent waits for the user to do there (a
 * captcha, a sign-in), shown in the panel until the user says it is done.
 */
export class Browser {
  private waiting: { reason: string; done(): void } | null = null;
  private readonly listeners = new Set<(s: BrowserState) => void>();
  /** Each agent's own tab, by its chat or task: the same one in its next answer. */
  private readonly tabs = new Map<string, OwnTab>();

  constructor(readonly driver: BrowserDriver) {
    driver.onState(() => this.broadcast());
  }

  state(): BrowserState {
    return { ...this.driver.state(), waiting: this.waiting?.reason ?? null };
  }

  onState(listener: (s: BrowserState) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** The browser as one agent sees it: its tools drive its own tab, whatever the panel shows. */
  own(owner: string): BrowserView {
    let tab = this.tabs.get(owner);
    if (!tab) {
      tab = new OwnTab(this.driver, (id) => [...this.tabs.values()].some((t) => t !== tab && t.id === id));
      this.tabs.set(owner, tab);
    }
    const mine = tab;
    return {
      driver: mine,
      state: () => ({ ...mine.state(), waiting: this.waiting?.reason ?? null }),
      // The user does what the agent asks in the agent's tab.
      askUser: async (reason, signal) => {
        await mine.show();
        return this.askUser(reason, signal);
      },
      done: () => this.done(),
    };
  }

  /** Waits until the user says they did what `reason` asks, the agent is stopped, or half an hour passes. */
  askUser(reason: string, signal?: AbortSignal): Promise<"done" | "timeout"> {
    this.waiting?.done();
    return new Promise((resolve) => {
      const finish = (how: "done" | "timeout") => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (this.waiting === entry) this.waiting = null;
        this.broadcast();
        resolve(how);
      };
      const abort = () => finish("timeout");
      const timer = setTimeout(() => finish("timeout"), ASK_MS);
      const entry = { reason, done: () => finish("done") };
      this.waiting = entry;
      signal?.addEventListener("abort", abort, { once: true });
      this.broadcast();
    });
  }

  /** The user did what the agent asked. */
  done(): void {
    this.waiting?.done();
  }

  private broadcast(): void {
    const s = this.state();
    for (const l of this.listeners) l(s);
  }
}
