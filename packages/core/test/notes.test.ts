import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOTES_LIMIT, notesBlock, writeNotes, writeState } from "../src/agent/notes";
import { setStoreDir, storeOf } from "../src/agent/store";

let dir: string;
let store: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "drimvox-notes-"));
  store = mkdtempSync(join(tmpdir(), "drimvox-store-"));
  setStoreDir(store);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(store, { recursive: true, force: true });
});

// Asked for: no AGENTS.md, .drimvox or other files of Drimvox's in the user's project; they are kept in Drimvox's data.
describe("the agent's notes, kept outside the project", () => {
  it("keeps the notes and the project's state in Drimvox's data, nothing in the folder", () => {
    writeNotes(dir, "Сайт-таймер. Проверки: node --test.");
    writeState(dir, { goal: "Сделай таймер", checklist: [], start: null, branch: "main", report: null, at: 0 });
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    expect(storeOf(dir).startsWith(store)).toBe(true);
    const block = notesBlock(dir);
    expect(block).toContain("Сайт-таймер");
    expect(block).toContain("Goal: Сделай таймер");
  });

  it("reads the user's own AGENTS.md or CLAUDE.md as it is, and never writes into it", () => {
    expect(notesBlock(dir)).toBe("");
    writeFileSync(join(dir, "CLAUDE.md"), "Use pnpm.\n");
    writeNotes(dir, "Сборка: pnpm build");
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe("Use pnpm.\n");
    expect(notesBlock(dir)).toContain("Use pnpm.");
    expect(notesBlock(dir)).toContain("Сборка: pnpm build");
  });

  it("takes its sections out of an AGENTS.md it wrote before, and removes the file when nothing of the user's is left", () => {
    writeFileSync(join(dir, "AGENTS.md"), "# Notes for agents\n\n<!-- drimvox -->\nСтарые заметки\n<!-- /drimvox -->\n");
    writeFileSync(join(dir, "CLAUDE.md"), "@AGENTS.md\n");
    expect(notesBlock(dir)).toContain("Старые заметки");
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
  });

  it("leaves the user's own text in AGENTS.md when it takes its sections out", () => {
    writeFileSync(join(dir, "AGENTS.md"), "# Правила\nКоммиты по-английски.\n\n<!-- drimvox -->\nСтарые заметки\n<!-- /drimvox -->\n");
    const block = notesBlock(dir);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8").trim()).toBe("# Правила\nКоммиты по-английски.");
    expect(block).toContain("Коммиты по-английски.");
    expect(block).toContain("Старые заметки");
  });

  it("refuses notes too long to keep in every request", () => {
    expect(() => writeNotes(dir, "x".repeat(NOTES_LIMIT + 1))).toThrow(/shorter/);
  });
});
