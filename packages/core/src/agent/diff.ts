import type { DiffFile, DiffHunk } from "@drimvox/shared";

/** Parses `git diff` output into files, hunks and numbered lines for the review screen. */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      file = {
        path: match?.[2] ?? "",
        oldPath: null,
        status: "modified",
        binary: false,
        added: 0,
        removed: 0,
        hunks: [],
      };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;

    if (!hunk) {
      if (line.startsWith("new file mode")) file.status = "added";
      else if (line.startsWith("deleted file mode")) file.status = "deleted";
      else if (line.startsWith("rename from ")) {
        file.status = "renamed";
        file.oldPath = line.slice("rename from ".length);
      } else if (line.startsWith("rename to ")) file.path = line.slice("rename to ".length);
      else if (line.startsWith("Binary files ")) file.binary = true;
    }

    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      continue;
    }
    if (!hunk) continue;

    if (line.startsWith("+")) {
      hunk.lines.push({ kind: "add", oldLine: null, newLine: newLine++, text: line.slice(1) });
      file.added++;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "del", oldLine: oldLine++, newLine: null, text: line.slice(1) });
      file.removed++;
    } else if (line.startsWith(" ")) {
      hunk.lines.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, text: line.slice(1) });
    }
  }
  return files;
}
