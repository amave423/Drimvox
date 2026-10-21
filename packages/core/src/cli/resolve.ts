import { presets } from "@artel/shared";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join } from "node:path";
import type { CliId } from "./kinds";
import { forgetDefaults } from "./models";

let overrides: Partial<Record<CliId, string[]>> = {};

/** Tests run a fake CLI instead of the real one. */
export function setCliCommands(next: Partial<Record<CliId, string[]>> | undefined): void {
  overrides = { ...next };
  forgetDefaults();
}

/**
 * The program and leading arguments that start a CLI, or null when it is not installed.
 * On Windows npm installs a .cmd wrapper; Drimvox starts what it wraps directly, so no shell parses the arguments.
 */
export function resolveCli(id: CliId): string[] | null {
  const given = overrides[id];
  if (given) return isAbsolute(given[0]!) && !existsSync(given[0]!) ? null : given;
  const name = presets[id].cli!.command;
  if (process.platform !== "win32") {
    const found = onPath(name)[0] ?? installedAt(id);
    return found ? [found] : null;
  }
  const found = onPath(name);
  const exe = found.find((p) => extname(p).toLowerCase() === ".exe");
  if (exe) return [exe];
  for (const cmd of found.filter((p) => extname(p).toLowerCase() === ".cmd")) {
    const target = fromShim(cmd);
    if (target) return target;
  }
  const own = installedAt(id);
  return own ? [own] : null;
}

/**
 * Where a CLI's own installer puts it, for when PATH does not have it yet: Drimvox started before the install sees the
 * old PATH. Antigravity CLI goes to %LOCALAPPDATA%\agy\bin on Windows and ~/.local/bin elsewhere.
 */
function installedAt(id: CliId): string | null {
  if (id !== "antigravity") return null;
  const file =
    process.platform === "win32"
      ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "agy", "bin", "agy.exe")
      : join(process.env.HOME ?? homedir(), ".local", "bin", "agy");
  return existsSync(file) ? file : null;
}

/** What an npm .cmd wrapper starts: a native program, or a script for Node. */
function fromShim(cmd: string): string[] | null {
  let text: string;
  try {
    text = readFileSync(cmd, "utf8");
  } catch {
    return null;
  }
  const targets = [...text.matchAll(/"%~?dp0%?\\([^"%]+)"/g)].map((m) => join(dirname(cmd), m[1]!));
  const exe = targets.find((t) => t.toLowerCase().endsWith(".exe") && existsSync(t) && !/\\node\.exe$/i.test(t));
  if (exe) return [exe];
  const script = targets.find((t) => /\.(c|m)?js$/i.test(t) && existsSync(t));
  if (!script) return null;
  const local = join(dirname(cmd), "node.exe");
  const node = existsSync(local) ? local : onPath("node").find((p) => p.toLowerCase().endsWith(".exe"));
  return node ? [node, script] : null;
}

/**
 * Every file on PATH that runs as `name`, in PATH order. Searched here rather than with where.exe, which prints
 * in the console's code page and garbles folders with non-Latin names, such as a Cyrillic user name.
 */
export function onPath(name: string): string[] {
  const win = process.platform === "win32";
  const exts = win ? (process.env.PATHEXT ?? ".EXE;.CMD").split(";").filter(Boolean) : [""];
  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(delimiter).filter(Boolean);
  const found: string[] = [];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = join(dir.replace(/^"|"$/g, ""), name + ext.toLowerCase());
      try {
        if (!statSync(file).isFile()) continue;
        if (!win) accessSync(file, constants.X_OK);
        found.push(file);
      } catch {
        // Not in this folder.
      }
    }
  }
  return found;
}
