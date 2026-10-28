import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** Chrome or Edge on this computer, or the Chromium Playwright downloaded; null when there is none. */
export function findBrowser(): string | null {
  const env = process.env;
  const candidates =
    process.platform === "win32"
      ? [
          join(env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
          join(env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
          join(env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
          join(env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
          join(env.PROGRAMFILES ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
        ]
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge", "/snap/bin/chromium"];
  const found = candidates.find((p) => p && existsSync(p));
  if (found) return found;
  // Playwright's own Chromium, when the browser server has downloaded it.
  const cache = process.platform === "win32" ? join(env.LOCALAPPDATA ?? "", "ms-playwright") : join(env.HOME ?? "", process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
  try {
    const dirs = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    for (const d of dirs) {
      const exe = process.platform === "win32" ? join(cache, d, "chrome-win", "chrome.exe") : process.platform === "darwin" ? join(cache, d, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium") : join(cache, d, "chrome-linux", "chrome");
      if (existsSync(exe)) return exe;
    }
  } catch {
    // No cache.
  }
  return null;
}

/**
 * A user agent without "Headless" in it (sites turn such visitors away): the version from the folder next to the
 * browser, as Chrome and Edge install themselves on Windows; none where it cannot be told.
 */
export function userAgent(exe: string): string | null {
  try {
    const version = readdirSync(dirname(exe)).find((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d));
    if (!version) return null;
    const edge = /msedge/i.test(exe);
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36${edge ? ` Edg/${version}` : ""}`;
  } catch {
    return null;
  }
}

/**
 * The Playwright server's command pointed at the agent's browser: its own browser options taken out, the DevTools
 * address put in.
 */
export function playwrightArgs(args: string[], endpoint: string, outputDir?: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--headless" || a === "--headed" || a === "--isolated") continue;
    if (a === "--cdp-endpoint" || a === "--browser" || a === "--user-data-dir" || (outputDir && a === "--output-dir")) {
      i++;
      continue;
    }
    if (/^--(cdp-endpoint|browser|user-data-dir)=/.test(a) || (outputDir && a.startsWith("--output-dir="))) continue;
    out.push(a);
  }
  // Its page snapshots go to Drimvox's data, not to whatever folder the app was started in (seen: a folder of them in
  // the sources).
  return [...out, "--cdp-endpoint", endpoint, ...(outputDir ? ["--output-dir", outputDir] : [])];
}
