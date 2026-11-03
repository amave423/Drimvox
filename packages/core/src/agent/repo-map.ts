import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { runGit } from "./git";
import { Workspace } from "./workspace";

/** Below this many files the agent finds its way by itself: no map. */
const MIN_FILES = 15;
/** The map's size at most: a few thousand tokens at the start of every request. */
const MAX_CHARS = 12_000;
/** Files larger than this are listed without reading what they define. */
const MAX_READ = 300_000;
/** Names shown per file at most. */
const MAX_NAMES = 12;

/** Top-level definitions by language: functions, classes, types, exported constants. */
const DEFINES: Record<string, RegExp[]> = {
  js: [/^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm, /^(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/gm, /^class\s+([A-Za-z_$][\w$]*)/gm],
  py: [/^(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, /^class\s+([A-Za-z_]\w*)/gm],
  go: [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm, /^type\s+([A-Za-z_]\w*)/gm],
  rs: [/^\s*pub\s+(?:async\s+)?(?:fn|struct|enum|trait)\s+([A-Za-z_]\w*)/gm],
  java: [/^\s*(?:public\s+)?(?:abstract\s+|final\s+)?(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/gm],
  rb: [/^\s*(?:def|class|module)\s+([A-Za-z_][\w.?!]*)/gm],
  php: [/^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|function)\s+([A-Za-z_]\w*)/gm],
};
const LANGUAGE: Record<string, string> = {
  ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js", ".ts": "js", ".tsx": "js", ".vue": "js", ".svelte": "js",
  ".py": "py", ".go": "go", ".rs": "rs", ".java": "java", ".kt": "java", ".cs": "java", ".rb": "rb", ".php": "php",
};
/** Files that are not the project's own text: pictures, fonts, archives, locks. */
const SKIPPED =
  /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|eot|mp[34]|webm|zip|gz|pdf|lock|map|min\.js)$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|(^|\/)(node_modules|dist|build|\.next|target|vendor|\.venv|venv|__pycache__|\.drimvox)\//i;

/**
 * A ready project's map, as Aider gives one: its files with their length and what each defines, so the agent goes to the
 * right file at once instead of listing folders and reading files to find it (seen live: dozens of list_files, search
 * and read_file calls before the first change). Empty for a small project. The project's .gitignore is followed.
 */
export async function projectMap(folder: string): Promise<string> {
  const files = await projectFiles(folder);
  if (files.length < MIN_FILES) return "";
  const lines: string[] = [];
  let size = 0;
  let shown = 0;
  for (const path of files) {
    const line = describe(folder, path);
    if (size + line.length + 1 > MAX_CHARS - 200) break;
    lines.push(line);
    size += line.length + 1;
    shown++;
  }
  const more = files.length - shown;
  return [
    "The project's files, with their length and what each defines (read the ones you need; do not list folders to find them):",
    ...lines,
    ...(more > 0 ? [`… ${more} more files not shown; use list_files and search for them.`] : []),
  ].join("\n");
}

/** The project's own files: what git knows and would add, else a walk that skips dependencies and build output. */
async function projectFiles(folder: string): Promise<string[]> {
  if (existsSync(join(folder, ".git"))) {
    const r = await runGit(folder, ["ls-files", "--cached", "--others", "--exclude-standard"], true).catch(() => null);
    if (r?.code === 0) return r.stdout.split("\n").map((l) => l.trim()).filter((l) => l && !SKIPPED.test(l)).sort();
  }
  return new Workspace(folder).listFiles(".", 6).filter((p) => !p.endsWith("/") && !SKIPPED.test(p));
}

function describe(folder: string, path: string): string {
  const file = join(folder, path);
  let text = "";
  try {
    if (statSync(file).size <= MAX_READ) text = readFileSync(file, "utf8");
  } catch {
    return path;
  }
  const count = text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
  const language = LANGUAGE[extname(path).toLowerCase()];
  // In the order the file has them.
  const found: { at: number; name: string }[] = [];
  for (const pattern of language ? DEFINES[language]! : []) for (const m of text.matchAll(pattern)) found.push({ at: m.index, name: m[1]! });
  const names = [...new Set(found.sort((a, b) => a.at - b.at).map((f) => f.name))];
  const head = `${path} (${count} lines)`;
  if (!names.length) return head;
  return `${head}: ${names.slice(0, MAX_NAMES).join(", ")}${names.length > MAX_NAMES ? `, … ${names.length - MAX_NAMES} more` : ""}`;
}
