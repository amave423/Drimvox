import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { clipPage, isPublicAddress } from "../internet/web";
import type { Browser } from "./browser";
import { keyPress } from "./driver";
import { chooseScript, focusScript, placeScript, READ_SCRIPT } from "./page-scripts";

export const BROWSER_HINT =
  "When you have the browser_ tools, you have a real browser, which the user sees in Drimvox's Browser panel. browser_open goes to an address, browser_read " +
  "reads the page with its controls numbered like [3 button \"Search\"], browser_click, browser_type, browser_choose, " +
  "browser_press and browser_scroll act on them, and every action answers with the page as it is after. Use it when " +
  "web_search and open_page are not enough: pages drawn by scripts, search forms, sign-ins, several steps. When a page " +
  "asks to prove a person is there (a captcha, a bot check) or needs the user's sign-in, call browser_ask_user and wait: " +
  "the user does it in the panel. Never try to pass such a check yourself. browser_look shows you the page as a picture, " +
  "at a phone's or a desktop's width, in the state your actions left it: never install Playwright, Puppeteer or another " +
  "browser into a project, and never write scripts that take screenshots. Check pages and scenarios in this browser, " +
  "which the user watches; browser servers among your tools (Chrome DevTools, Playwright) are for what it cannot do: " +
  "the console, network requests, performance.";

/** Looks at pages per answer; the next answer may look again. */
export const MAX_BROWSER_LOOKS = 12;
/** A whole page is photographed at most this tall: a picture taller than this tells a model little more. */
const MAX_LOOK_HEIGHT = 8000;

/** Runs one tool call with the chat's or the agent's hooks around it; what webTools gives. */
export type ToolRun = (callId: string, name: string, input: string, work: () => Promise<string>) => Promise<string>;

type Opts = { toolCallId: string; abortSignal?: AbortSignal };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The agent's own browser tools (asked for: a browser like Claude's, with full access): the same on the desktop, where
 * the tab is inside Drimvox's window, and on the server. `local` lets a project's agent open the app it runs on this
 * computer; a chat reads the public internet only.
 */
/** Asks a model that sees pictures about one: what browser_look needs; absent, there is no browser_look. */
export type See = (png: Buffer, question: string, signal?: AbortSignal) => Promise<string>;

export function browserTools(browser: Browser, o: { local: boolean; see?: See }, run: ToolRun): ToolSet {
  const d = browser.driver;
  let looks = 0;

  async function evaluate(expression: string): Promise<unknown> {
    const r = (await d.command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "The page's script failed");
    return r.result?.value;
  }

  /** Waits for the page to load after an action, 15 seconds at most. */
  async function settle(signal?: AbortSignal): Promise<void> {
    await sleep(400);
    for (let i = 0; i < 50 && !signal?.aborted; i++) {
      const ready = await evaluate("document.readyState").catch(() => null);
      if (ready === "complete") break;
      await sleep(300);
    }
    // Scripts of single-page apps draw after the load event.
    await sleep(300);
  }

  async function read(signal?: AbortSignal): Promise<string> {
    await settle(signal);
    const page = JSON.parse(String(await evaluate(READ_SCRIPT))) as { url: string; title: string; text: string; below: number };
    const s = browser.state();
    const tabs =
      s.tabs.length > 1
        ? `\nTabs: ${s.tabs.map((t, i) => `${i + 1} "${(t.id === s.active ? page.title || t.title : t.title || t.url).slice(0, 60)}"${t.id === s.active ? " (shown)" : ""}`).join(", ")}`
        : "";
    const more = page.below > 50 ? `\n\n(the page goes on below: browser_scroll to see more)` : "";
    return `${page.title ? `${page.title}\n` : ""}${page.url}${tabs}\n\n${clipPage(page.text) || "(the page shows no text)"}${more}`;
  }

  /** Where control `ref` is, scrolled into view; a clear error when the numbers are out of date. */
  async function place(ref: number): Promise<{ x: number; y: number }> {
    const at = JSON.parse(String(await evaluate(placeScript(ref)))) as { x?: number; y?: number; error?: string };
    if (at.error === "gone") throw new Error(`There is no control ${ref} on the page now; call browser_read for fresh numbers.`);
    if (at.error === "hidden") throw new Error(`Control ${ref} is hidden now; call browser_read to see the page as it is.`);
    return { x: at.x!, y: at.y! };
  }

  async function click(ref: number): Promise<void> {
    const { x, y } = await place(ref);
    // A real click, as a person's: the pointer comes over the control, presses and lets go.
    await d.command("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
    await d.command("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await d.command("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  }

  async function press(key: string, modifiers = 0): Promise<void> {
    const events = keyPress(key, modifiers);
    if (!events) throw new Error(`Unknown key "${key}". Keys: Enter, Tab, Escape, Backspace, Delete, arrows (ArrowDown…), Home, End, PageUp, PageDown, a letter or digit.`);
    for (const e of events) await d.command("Input.dispatchKeyEvent", e);
  }

  /** The shown page as a picture: at a phone's or a desktop's width when asked, the whole page when asked. */
  async function photograph(width: number | undefined, full: boolean): Promise<Buffer> {
    if (width) {
      // Exactly this width, as the page's own media queries see it (a "mobile" override lays a page out at 980 instead).
      await d.command("Emulation.setDeviceMetricsOverride", { width, height: width < 768 ? 844 : 900, deviceScaleFactor: 1, mobile: false });
      await sleep(600);
    }
    try {
      let clip: Record<string, number> | undefined;
      if (full) {
        const [w, h] = (await evaluate("[innerWidth, document.documentElement.scrollHeight]")) as [number, number];
        clip = { x: 0, y: 0, width: w, height: Math.min(h, MAX_LOOK_HEIGHT), scale: 1 };
      }
      const shot = (await d.command("Page.captureScreenshot", { format: "png", ...(clip ? { clip, captureBeyondViewport: true } : {}) })) as { data: string };
      return Buffer.from(shot.data, "base64");
    } finally {
      // The page goes back to the size of its panel.
      if (width) {
        await d.command("Emulation.clearDeviceMetricsOverride").catch(() => {});
        await d.restoreSize?.().catch(() => {});
      }
    }
  }

  function checkAddress(url: string): void {
    if (!/^https?:\/\//i.test(url)) throw new Error("Only http and https addresses");
    // Tests serve their pages on this computer.
    if (!o.local && !isPublicAddress(url) && process.env.DRIMVOX_TEST_BROWSER_LOCAL !== "1") throw new Error("Only public internet addresses can be opened");
  }

  const ref = z.number().int().min(1).describe("The control's number from the last read, as in [3 button …]");

  return {
    browser_open: tool({
      description: "Open an address in the browser and read the page. new_tab keeps the current page in its own tab.",
      inputSchema: z.object({ url: z.string().url().max(2000), new_tab: z.boolean().optional() }),
      execute: ({ url, new_tab }, x: Opts) =>
        run(x.toolCallId, "browser_open", url, async () => {
          checkAddress(url);
          if (new_tab) await d.newTab(url);
          else await d.open(url);
          return read(x.abortSignal);
        }),
    }),
    browser_read: tool({
      description: "Read the page shown in the browser: its text and its controls, numbered.",
      inputSchema: z.object({}),
      execute: (_input, x: Opts) => run(x.toolCallId, "browser_read", "", () => read(x.abortSignal)),
    }),
    browser_click: tool({
      description: "Click a control of the page (a link, a button, a checkbox) by its number, then read the page.",
      inputSchema: z.object({ ref }),
      execute: ({ ref: n }, x: Opts) =>
        run(x.toolCallId, "browser_click", String(n), async () => {
          await click(n);
          return read(x.abortSignal);
        }),
    }),
    browser_type: tool({
      description: "Type text into a field by its number, replacing what it holds; submit presses Enter after. Then read the page.",
      inputSchema: z.object({ ref, text: z.string().max(5000), submit: z.boolean().optional() }),
      execute: ({ ref: n, text, submit }, x: Opts) =>
        run(x.toolCallId, "browser_type", `${n}: ${text.slice(0, 200)}`, async () => {
          await click(n);
          // The window may be in the background: the page must still believe it has the focus, or the text goes nowhere.
          await d.command("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
          await evaluate(focusScript(n));
          await d.command("Input.insertText", { text });
          if (submit) await press("Enter");
          return read(x.abortSignal);
        }),
    }),
    browser_choose: tool({
      description: "Choose an option of a select (a drop-down list) by its number and the option's text, then read the page.",
      inputSchema: z.object({ ref, option: z.string().min(1).max(300) }),
      execute: ({ ref: n, option }, x: Opts) =>
        run(x.toolCallId, "browser_choose", `${n}: ${option}`, async () => {
          const answer = String(await evaluate(chooseScript(n, option)));
          if (answer !== "ok") throw new Error(answer);
          return read(x.abortSignal);
        }),
    }),
    browser_press: tool({
      description: "Press a key in the page (Enter, Escape, Tab, ArrowDown…), optionally with Ctrl, then read the page.",
      inputSchema: z.object({ key: z.string().min(1).max(20), ctrl: z.boolean().optional(), shift: z.boolean().optional() }),
      execute: ({ key, ctrl, shift }, x: Opts) =>
        run(x.toolCallId, "browser_press", key, async () => {
          await press(key, (ctrl ? 2 : 0) | (shift ? 8 : 0));
          return read(x.abortSignal);
        }),
    }),
    browser_scroll: tool({
      description: "Scroll the page down or up by a screen, then read it.",
      inputSchema: z.object({ direction: z.enum(["down", "up"]) }),
      execute: ({ direction }, x: Opts) =>
        run(x.toolCallId, "browser_scroll", direction, async () => {
          const [w, h] = (await evaluate("[innerWidth, innerHeight]")) as [number, number];
          await d.command("Input.dispatchMouseEvent", { type: "mouseWheel", x: w / 2, y: h / 2, deltaX: 0, deltaY: (direction === "down" ? 1 : -1) * Math.round(h * 0.8) });
          return read(x.abortSignal);
        }),
    }),
    browser_back: tool({
      description: "Go back to the previous page, then read it.",
      inputSchema: z.object({}),
      execute: (_input, x: Opts) =>
        run(x.toolCallId, "browser_back", "", async () => {
          await d.back();
          return read(x.abortSignal);
        }),
    }),
    browser_tab: tool({
      description: "Show another tab by its number from the Tabs line, or close it; then read the shown page.",
      inputSchema: z.object({ tab: z.number().int().min(1), action: z.enum(["show", "close"]) }),
      execute: ({ tab, action }, x: Opts) =>
        run(x.toolCallId, "browser_tab", `${action} ${tab}`, async () => {
          const target = browser.state().tabs[tab - 1];
          if (!target) throw new Error(`There is no tab ${tab}`);
          if (action === "show") await d.select(target.id);
          else await d.close(target.id);
          return read(x.abortSignal);
        }),
    }),
    ...(o.see
      ? {
          // Seen live: out of looks, an agent installed Playwright into the project and wrote its own screenshot scripts.
          browser_look: tool({
            description:
              "Look at the page shown in the browser as a picture and ask about it (layout, colours, what is visible, what is " +
              "broken). width 390 is a phone, 1280 a desktop; full_page takes the whole page, not only the screen. The page " +
              "stays in the state your actions left it (an item added, a form sent).",
            inputSchema: z.object({
              question: z.string().min(1).max(2000),
              width: z.number().int().min(320).max(1920).optional(),
              full_page: z.boolean().optional(),
            }),
            execute: ({ question, width, full_page }, x: Opts) =>
              run(x.toolCallId, "browser_look", question, async () => {
                if (++looks > MAX_BROWSER_LOOKS) {
                  throw new Error(`You have looked ${MAX_BROWSER_LOOKS} times in this answer: go on with the work, you can look again in the next one.`);
                }
                return o.see!(await photograph(width, !!full_page), question, x.abortSignal);
              }),
          }),
        }
      : {}),
    browser_ask_user: tool({
      description:
        "Ask the user to do something in the browser themselves: pass a captcha or a bot check, sign in. The browser panel " +
        "opens for them; this waits until they say it is done, then reads the page.",
      inputSchema: z.object({ reason: z.string().min(1).max(300).describe("In the user's language: what to do in the browser") }),
      execute: ({ reason }, x: Opts) =>
        run(x.toolCallId, "browser_ask_user", reason, async () => {
          const how = await browser.askUser(reason, x.abortSignal);
          if (how === "timeout") return `The user did not answer. Go on without it or say what blocks you.\n\n${await read(x.abortSignal)}`;
          return `The user says it is done.\n\n${await read(x.abortSignal)}`;
        }),
    }),
  };
}
