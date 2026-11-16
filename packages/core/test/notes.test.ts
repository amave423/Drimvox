import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mirrorNotes, NOTES_LIMIT, notesBlock, notesChangedSince, writeNotes, writeState } from "../src/agent/notes";
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
    // Seen live: a wrong server address in the notes outweighed the user saying three times it was gone.
    expect(block).toMatch(/may be out of date[\s\S]*user says[\s\S]*update_notes/);
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

  // Asked for (2026-11-16, after 2026-11-10's "no files of Drimvox's in the project"): an AGENTS.md in the folder, so a
  // new conversation or another agent (Codex, Claude Code) can go on, kept current.
  it("copies the notes into the project's AGENTS.md, in a section of its own, and sends them once", () => {
    writeNotes(dir, "Запуск: npm start");
    mirrorNotes(dir);
    const file = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(file).toContain("<!-- drimvox -->");
    expect(file).toContain("Запуск: npm start");
    writeNotes(dir, "Запуск: npm run dev");
    mirrorNotes(dir);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).not.toContain("npm start");
    const block = notesBlock(dir);
    expect(block.match(/npm run dev/g)).toHaveLength(1);
    expect(block).not.toContain("The project's AGENTS.md");
  });

  it("keeps the user's own text in AGENTS.md around its section", () => {
    writeFileSync(join(dir, "AGENTS.md"), "# Правила\nКоммиты по-английски.\n");
    writeNotes(dir, "Сборка: pnpm build");
    writeNotes(dir, "Сборка: pnpm build --prod");
    mirrorNotes(dir);
    const file = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(file.startsWith("# Правила\nКоммиты по-английски.\n")).toBe(true);
    expect(file.match(/<!-- drimvox -->/g)).toHaveLength(1);
    const block = notesBlock(dir);
    expect(block).toContain("Коммиты по-английски.");
    expect(block.match(/pnpm build --prod/g)).toHaveLength(1);
  });

  it("takes notes an earlier version left in AGENTS.md as its own, and leaves the file", () => {
    writeFileSync(join(dir, "AGENTS.md"), "# Notes for agents\n\n<!-- drimvox -->\nСтарые заметки\n<!-- /drimvox -->\n");
    expect(notesBlock(dir)).toContain("Старые заметки");
    expect(readFileSync(join(storeOf(dir), "notes.md"), "utf8")).toContain("Старые заметки");
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
  });

  it("knows when the notes were last changed", () => {
    const before = Date.now() - 1000;
    expect(notesChangedSince(dir, before)).toBe(false);
    writeNotes(dir, "Что-то");
    expect(notesChangedSince(dir, before)).toBe(true);
    expect(notesChangedSince(dir, Date.now() + 60_000)).toBe(false);
  });

  it("refuses notes too long to keep in every request", () => {
    expect(() => writeNotes(dir, "x".repeat(NOTES_LIMIT + 1))).toThrow(/shorter/);
  });
});
