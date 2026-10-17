import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const SKIP = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next", "target"]);
const MAX_READ_LINES = 2000;
const MAX_SEARCH_RESULTS = 100;

/** File access for the agent, locked to one folder: the task's copy of the project. */
export class Workspace {
  constructor(readonly root: string) {}

  /** Absolute path of `path` inside the copy; anything that escapes it throws. */
  resolve(path: string): string {
    const target = resolve(this.root, path);
    const rel = relative(this.root, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Path is outside the project copy: ${path}`);
    }
    return target;
  }

  listFiles(path = ".", depth = 2): string[] {
    const start = this.resolve(path);
    const results: string[] = [];
    const walk = (dir: string, level: number) => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (SKIP.has(entry.name)) continue;
        const full = join(dir, entry.name);
        const rel = relative(this.root, full).split(sep).join("/");
        if (entry.isDirectory()) {
          results.push(`${rel}/`);
          if (level < depth) walk(full, level + 1);
        } else {
          results.push(rel);
        }
        if (results.length >= 1000) return;
      }
    };
    walk(start, 1);
    return results;
  }

  readFile(path: string, offset = 1, limit = MAX_READ_LINES): string {
    const file = this.resolve(path);
    if (!existsSync(file)) throw new Error(`File not found: ${path}`);
    if (statSync(file).isDirectory()) throw new Error(`${path} is a folder; use list_files`);
    const lines = readFileSync(file, "utf8").replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
    const from = Math.max(1, offset);
    const slice = lines.slice(from - 1, from - 1 + Math.min(limit, MAX_READ_LINES));
    const body = slice.map((line, i) => `${from + i}\t${line}`).join("\n");
    const rest = lines.length - (from - 1 + slice.length);
    return rest > 0 ? `${body}\n… ${rest} more lines; read again with offset ${from + slice.length}` : body;
  }

  writeFile(path: string, content: string): void {
    const file = this.resolve(path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  /**
   * Replaces one exact, unique fragment. Refuses when it is missing or ambiguous. Matching ignores
   * Windows line endings, because read_file shows the model plain \n; the file keeps its own style.
   */
  editFile(path: string, oldText: string, newText: string): void {
    const file = this.resolve(path);
    if (!existsSync(file)) throw new Error(`File not found: ${path}`);
    const raw = readFileSync(file, "utf8");
    const crlf = raw.includes("\r\n");
    const content = crlf ? raw.replace(/\r\n/g, "\n") : raw;
    const find = oldText.replace(/\r\n/g, "\n");
    const count = find ? content.split(find).length - 1 : 0;
    if (count > 1) throw new Error(`Fragment occurs ${count} times in ${path}; include more surrounding lines`);
    // Seen live: many edits missed by an indent, and every miss sent the agent back to read the file in pieces.
    const edited = count === 1 ? content.replace(find, () => newText.replace(/\r\n/g, "\n")) : looseEdit(content, find, newText.replace(/\r\n/g, "\n"));
    if (edited === null) throw new Error(`Fragment not found in ${path}. ${nearby(content, find)}`);
    writeFileSync(file, crlf ? edited.replace(/\n/g, "\r\n") : edited);
  }

  /** Lines matching a regular expression (or plain text if it is not a valid one). */
  search(pattern: string, path = "."): string[] {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch {
      regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    }
    const results: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(entry.name) || results.length >= MAX_SEARCH_RESULTS) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (statSync(full).size < 1_000_000) {
          const rel = relative(this.root, full).split(sep).join("/");
          readFileSync(full, "utf8")
            .split(/\r?\n/)
            .forEach((line, i) => {
              if (results.length < MAX_SEARCH_RESULTS && regex.test(line)) results.push(`${rel}:${i + 1}: ${line.trim()}`);
            });
        }
      }
    };
    const start = this.resolve(path);
    // A file is searched on its own; models often pass one.
    if (statSync(start).isFile()) {
      const rel = relative(this.root, start).split(sep).join("/");
      readFileSync(start, "utf8")
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (results.length < MAX_SEARCH_RESULTS && regex.test(line)) results.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
      return results;
    }
    walk(start);
    return results;
  }
}

const indentOf = (line: string) => line.match(/^\s*/)![0];

/**
 * The fragment matched line by line with indentation and trailing spaces ignored, when exactly one place matches;
 * the new text takes the file's indentation there. Null when no place or several do.
 */
function looseEdit(content: string, find: string, replacement: string): string | null {
  const want = find.replace(/\n+$/, "").split("\n");
  if (want.every((l) => l.trim() === "")) return null;
  const lines = content.split("\n");
  const same = (a: string, b: string) => a.trim() === b.trim();
  const starts: number[] = [];
  for (let i = 0; i + want.length <= lines.length; i++) if (want.every((w, j) => same(w, lines[i + j]!))) starts.push(i);
  if (starts.length !== 1) return null;
  const at = starts[0]!;
  const first = want.findIndex((l) => l.trim() !== "");
  const theirs = indentOf(want[first]!);
  const ours = indentOf(lines[at + first]!);
  const placed = replacement
    .replace(/\n+$/, "")
    .split("\n")
    .map((l) => (l.trim() === "" ? "" : ours + (l.startsWith(theirs) ? l.slice(theirs.length) : l.trimStart())));
  return [...lines.slice(0, at), ...placed, ...lines.slice(at + want.length)].join("\n");
}

/** The file around the line most like the fragment, numbered as read_file shows it, so the next edit can hit. */
function nearby(content: string, find: string): string {
  const words = (s: string) => new Set(s.toLowerCase().split(/\W+/).filter((w) => w.length > 1));
  const wanted = find.split("\n").map(words).filter((w) => w.size > 0);
  const lines = content.split("\n");
  let best = -1;
  let bestScore = 0;
  lines.forEach((line, i) => {
    const have = words(line);
    if (have.size === 0) return;
    for (const w of wanted) {
      const shared = [...w].filter((x) => have.has(x)).length;
      const score = shared / (w.size + have.size - shared);
      if (score > bestScore) [best, bestScore] = [i, score];
    }
  });
  if (best < 0 || bestScore < 0.3) return "Read the file and copy the text exactly.";
  const from = Math.max(0, best - 8);
  const to = Math.min(lines.length, best + 9);
  const shown = lines.slice(from, to).map((l, i) => `${from + i + 1}\t${l}`).join("\n");
  return `Lines ${from + 1}-${to} as they are now, nearest to what you looked for:\n${shown}`;
}
