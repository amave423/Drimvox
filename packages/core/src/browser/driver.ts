export interface BrowserTab {
  id: string;
  url: string;
  title: string;
}

export interface BrowserState {
  running: boolean;
  /** The tab the panel shows. */
  url: string;
  title: string;
  /** Every tab, in the order they were opened, and which one is shown (asked for: a switch between them). */
  tabs: BrowserTab[];
  active: string | null;
  /** What the agent waits for the user to do in the browser (a check, a sign-in), until they say it is done. */
  waiting?: string | null;
}

/**
 * The agent's browser, whatever runs it: on the desktop a real tab inside Drimvox's window (the main process holds it),
 * on the server Chrome without a window, watched as pictures. The agent's tools speak the DevTools protocol to the
 * shown tab through `command`, the same on both.
 */
export interface BrowserDriver {
  /** False where no browser can run (a server without Chrome): then the agent has no browser tools. */
  available(): boolean;
  state(): BrowserState;
  /** Every change of the tabs; returns the way to stop listening. */
  onState(listener: (state: BrowserState) => void): () => void;
  /** Opens an address in the shown tab; starts the browser and makes a tab first if needed. */
  open(url: string): Promise<void>;
  newTab(url?: string): Promise<void>;
  select(id: string): Promise<void>;
  close(id: string): Promise<void>;
  back(): Promise<void>;
  reload(): Promise<void>;
  /** A DevTools command in the shown tab's page; starts the browser and makes a tab first if needed. */
  command(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** The page back at the panel's size after a look at another width; where the panel sets no size, nothing to do. */
  restoreSize?(): Promise<void>;
  /** The proxy for the listed sites only, the rest directly (the desktop's browser); null: everything directly. */
  useProxy?(proxy: string | null, hosts: string[]): Promise<void>;
  /** A site that did not open directly but opened through the proxy: to remember; returns the way to stop listening. */
  onBlocked?(listener: (host: string) => void): () => void;
  stop(): Promise<void>;
}

/** Keys that are not text, as the DevTools protocol wants them. */
const KEYS: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
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
  " ": { code: "Space", vk: 32, text: " " },
};

/**
 * The two events of one key press: a named key, or a letter or digit with Ctrl and the like; null for keys it does not
 * know. Modifiers: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift.
 */
export function keyPress(key: string, modifiers = 0): [Record<string, unknown>, Record<string, unknown>] | null {
  const one = key.length === 1 ? key.toUpperCase() : "";
  const k = KEYS[key] ?? (/^[A-Z]$/.test(one) ? { code: `Key${one}`, vk: one.charCodeAt(0) } : /^[0-9]$/.test(one) ? { code: `Digit${one}`, vk: one.charCodeAt(0) } : null);
  if (!k) return null;
  const base = { key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers };
  // A plain key that types something says so; with Ctrl it is a shortcut, not text.
  const text = k.text ?? (modifiers & 6 ? undefined : key.length === 1 ? key : undefined);
  return [{ type: text ? "keyDown" : "rawKeyDown", ...base, ...(text ? { text } : {}) }, { type: "keyUp", ...base }];
}
