import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * An Electron project's tester also tries the built app (asked for, after Nexus crashed for its users on "Notification
 * is not defined": the code ran only behind `app.isPackaged`, and the tester's dev run never reached it).
 */
export interface ElectronApp {
  /** Its folder inside the project ("" for the root). */
  dir: string;
  /** electron-builder is there: `--dir` builds the unpacked app without an installer. */
  builder: boolean;
  /** The project's own build script, when it has one ("dist", "build:win"…). */
  dist: string | null;
}

function readPackage(file: string): { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> } | null {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The Electron app of a project: at its root or one folder down (Nexus keeps it in app/); null when there is none. */
export function electronApp(folder: string): ElectronApp | null {
  const places = [""];
  try {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") places.push(entry.name);
    }
  } catch {
    return null;
  }
  for (const dir of places) {
    const file = join(folder, dir, "package.json");
    if (!existsSync(file)) continue;
    const pkg = readPackage(file);
    const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
    if (!pkg || !deps.electron) continue;
    const scripts = pkg.scripts ?? {};
    const dist = Object.keys(scripts).find((name) => /electron-builder|electron-forge|make|package/.test(scripts[name] ?? "")) ?? null;
    return { dir, builder: !!deps["electron-builder"], dist };
  }
  return null;
}

/** Files of the turn whose added lines run only in the built app. */
function packagedOnly(patch: string): string[] {
  const files = new Set<string>();
  let file = "";
  for (const line of patch.split("\n")) {
    const head = /^diff --git a\/(.+?) b\//.exec(line);
    if (head) file = head[1]!;
    else if (line.startsWith("+") && !line.startsWith("+++") && /app\.isPackaged|process\.resourcesPath|autoUpdater|new Notification\(|\bTray\b/.test(line)) files.add(file);
  }
  return [...files];
}

/** What the tester of an Electron project is told on top of its usual work; null for other projects. */
export function packagedNote(app: ElectronApp | null, patch: string): string | null {
  if (!app) return null;
  const where = app.dir ? `in ${app.dir}/` : "at the project's root";
  const build = app.builder ? `\`npx electron-builder --dir\`` : app.dist ? `\`npm run ${app.dist}\`` : "the project's packaging command";
  const only = packagedOnly(patch);
  return [
    `This is an Electron app (${where}). Some of its code runs only in the built app (behind app.isPackaged: native`,
    "notifications, the tray, auto-update, paths inside app.asar), and a dev run never reaches it. After the dev run, build",
    `the unpacked app with ${build} ${where} (no installer), start the .exe from its win-unpacked folder (dist/ or out/),`,
    "and try what this turn changed there too: with the window minimized and hidden in the tray, have a message or an event",
    'arrive; watch for "A JavaScript error occurred in the main process" and other error windows. Stop the app afterwards.',
    only.length ? `This turn changed code that runs only in the built app: ${only.join(", ")}. Try it there for sure.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
