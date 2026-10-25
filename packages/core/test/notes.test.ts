import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOTES_LIMIT, notesBlock, writeNotes } from "../src/agent/notes";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "drimvox-notes-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("AGENTS.md, the notes every request starts with", () => {
  it("starts the file with the agent's section when there is none", () => {
    writeNotes(dir, "Сайт-таймер. Проверки: node --test.");
    const text = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(text).toContain("<!-- drimvox -->\nСайт-таймер. Проверки: node --test.\n<!-- /drimvox -->");
    expect(notesBlock(dir)).toContain("Сайт-таймер");
  });

  it("rewrites only its own section and leaves the user's text as it is", () => {
    writeFileSync(join(dir, "AGENTS.md"), "# Правила\nКоммиты по-английски.\n");
    writeNotes(dir, "первая версия");
    writeNotes(dir, "вторая версия");
    const text = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(text.startsWith("# Правила\nКоммиты по-английски.\n")).toBe(true);
    expect(text).toContain("вторая версия");
    expect(text).not.toContain("первая версия");
    expect(notesBlock(dir)).toContain("Коммиты по-английски.");
  });

  it("refuses notes too long to keep in every request", () => {
    expect(() => writeNotes(dir, "x".repeat(NOTES_LIMIT + 1))).toThrow(/shorter/);
  });

  it("reads CLAUDE.md when there is no AGENTS.md, and nothing when neither is there", () => {
    expect(notesBlock(dir)).toBe("");
    writeFileSync(join(dir, "CLAUDE.md"), "Use pnpm.\n");
    expect(notesBlock(dir)).toContain("Use pnpm.");
  });
});
