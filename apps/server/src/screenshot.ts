import { PAGE_HEIGHT_SCRIPT, pageActionScript, type PageAction } from "@artel/shared";
import type { Browser } from "playwright-core";

/** As tall as the desktop app photographs. */
const MAX_SHOT_HEIGHT = 8000;

let browser: Promise<Browser> | null = null;

/**
 * Screenshots of pages for the agents' visual checks: headless Chromium through Playwright, started on the first
 * shot and kept open. The desktop app uses a hidden Electron window instead.
 */
export async function screenshot(url: string, size: { width: number; height: number }, actions: PageAction[] = []): Promise<Buffer> {
  browser ??= import("playwright-core")
    .then(({ chromium }) => chromium.launch({ headless: true }))
    .catch((err: unknown) => {
      browser = null;
      throw new Error(
        `Chromium is not installed on the server; run "npx playwright install --with-deps chromium" in the Artel folder. (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`,
      );
    });
  const page = await (await browser).newPage({ viewport: size });
  try {
    await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    // Let fonts and the first animation frame settle.
    await page.waitForTimeout(500);
    // A scenario first, as a person would go through it (docs/specs/project-work.md); the page settles after each step.
    for (const [n, step] of actions.entries()) {
      try {
        await page.evaluate(pageActionScript(step));
      } catch (err) {
        throw new Error(`Step ${n + 1} (${step.action} ${step.target ?? step.text ?? ""}): ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      }
      await page.waitForTimeout(700);
    }
    // The whole page, as on the desktop: a check of a long page needs what is further down too. A page that scrolls
    // inside its own full-screen container shows all of it only in a window that tall.
    const height = Math.min(Number(await page.evaluate(PAGE_HEIGHT_SCRIPT)), MAX_SHOT_HEIGHT);
    if (height > size.height) {
      await page.setViewportSize({ width: size.width, height });
      await page.waitForTimeout(300);
    }
    return await page.screenshot({ type: "png", fullPage: true });
  } finally {
    await page.close();
  }
}

export async function closeBrowser(): Promise<void> {
  const open = browser;
  browser = null;
  await (await open?.catch(() => null))?.close();
}
