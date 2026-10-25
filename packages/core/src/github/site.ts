import { exec } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Where builds usually put a site, most likely first; the project's own folder last, for a plain site. */
const FOLDERS = ["dist", "build", "out", "docs", "public", "."];
const BUILD_MS = 10 * 60_000;

/** The folder with the built site: the first of the usual ones that has an index.html; null when there is none. */
export function siteFolder(dir: string): string | null {
  return FOLDERS.find((f) => existsSync(join(dir, f, "index.html"))) ?? null;
}

/** A project with a build script and no built site yet: built once, then looked for again. */
export async function builtSite(dir: string): Promise<string | null> {
  const found = siteFolder(dir);
  if (found && found !== ".") return found;
  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return found;
  }
  if (!scripts.build) return found;
  await new Promise<void>((resolve) => exec("npm run build", { cwd: dir, timeout: BUILD_MS, windowsHide: true }, () => resolve()));
  return siteFolder(dir);
}

/** GitHub Pages serves folders starting with _ (Next.js, Astro) only without Jekyll. */
export function markNoJekyll(folder: string): void {
  const file = join(folder, ".nojekyll");
  if (!existsSync(file)) writeFileSync(file, "");
}
