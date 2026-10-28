import type { BrowserDriver, BrowserState } from "./driver";

/** How long the agent waits for the user to pass a check in the browser before it goes on without. */
const ASK_MS = 30 * 60_000;

/**
 * The agent's browser as Drimvox shares it: whatever drives it, plus what the agent waits for the user to do there (a
 * captcha, a sign-in), shown in the panel until the user says it is done.
 */
export class Browser {
  private waiting: { reason: string; done(): void } | null = null;
  private readonly listeners = new Set<(s: BrowserState) => void>();

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
