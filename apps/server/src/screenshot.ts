import { PAGE_HEIGHT_SCRIPT, PAGE_TEXT_SCRIPT, pageActionScript, type PageAction } from "@drimvox/shared";
import type { Browser, Page } from "playwright-core";

/** As tall as the desktop app photographs. */
const MAX_SHOT_HEIGHT = 8000;

let browser: Promise<Browser> | null = null;

/**
 * Screenshots of pages for the agents' visual checks: headless Chromium through Playwright, started on the first
 * shot and kept open. The desktop app uses a hidden Electron window instead.
 */
export function screenshot(url: string, size: { width: number; height: number }, actions: PageAction[] = []): Promise<Buffer> {
  return withPage(url, size, actions, async (page) => {
    // The whole page, as on the desktop: a check of a long page needs what is further down too. A page that scrolls
    // inside its own full-screen container shows all of it only in a window that tall.
    const height = Math.min(Number(await page.evaluate(PAGE_HEIGHT_SCRIPT)), MAX_SHOT_HEIGHT);
    if (height > size.height) {
      await page.setViewportSize({ width: size.width, height });
      await page.waitForTimeout(300);
    }
    return await page.screenshot({ type: "png", fullPage: true });
  });
}

/** A page read as a person sees it, scripts run (browse_page): its title, address and visible text. */
export function readPage(url: string, actions: PageAction[] = []): Promise<{ url: string; title: string; text: string }> {
  return withPage(url, { width: 1280, height: 900 }, actions, async (page) => JSON.parse(String(await page.evaluate(PAGE_TEXT_SCRIPT))));
}

/** Opens a page, goes through the steps as a person would, and hands it to `read`. */
async function withPage<T>(url: string, size: { width: number; height: number }, actions: PageAction[], read: (page: Page) => Promise<T>): Promise<T> {
  browser ??= import("playwright-core")
    .then(({ chromium }) => chromium.launch({ headless: true }))
    .catch((err: unknown) => {
      browser = null;
      throw new Error(
        `Chromium is not installed on the server; run "npx playwright install --with-deps chromium" in the Drimvox folder. (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`,
      );
    });
  const page = await (await browser).newPage({ viewport: size });
  try {
    await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    // Let fonts and the first animation frame settle; scripts of single-page apps draw after the load event.
    await page.waitForTimeout(1000);
    // A scenario first, as a person would go through it (docs/specs/project-work.md); the page settles after each step.
    for (const [n, step] of actions.entries()) {
      try {
        // Text and keys as real input: pages ignore made-up events (seen: WIPO's search field stayed empty).
        const run = () =>
          page.evaluate(pageActionScript(step)).catch((err: unknown) => {
            // The page went to another address: the old one cannot answer.
            if (err instanceof Error && /context was destroyed|navigation/i.test(err.message)) return "left";
            throw err;
          });
        let answer = await run();
        // A click is expected to leave; anything else was the page redirecting itself (seen: WIPO), so the step goes again.
        if (answer === "left" && step.action !== "click") {
          await page.waitForLoadState("load", { timeout: 30_000 }).catch(() => {});
          answer = await run();
        }
        if (answer === "keyboard") {
          if (step.action === "type") await page.keyboard.insertText(step.text ?? "");
          else await page.keyboard.press(step.text ?? "Enter");
        }
        if (answer === "left") await page.waitForLoadState("load", { timeout: 30_000 }).catch(() => {});
      } catch (err) {
        throw new Error(`Step ${n + 1} (${step.action} ${step.target ?? step.text ?? ""}): ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      }
      await page.waitForTimeout(700);
    }
    return await read(page);
  } finally {
    await page.close();
  }
}

export async function closeBrowser(): Promise<void> {
  const open = browser;
  browser = null;
  await (await open?.catch(() => null))?.close();
}
