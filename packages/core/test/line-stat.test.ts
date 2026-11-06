import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lineStat } from "../src/work/line-stat";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "drimvox-lines-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Seen live: one edit changed src/styles.css and src/main.js, and both showed only "changed", without their lines.
describe("the lines a call changes", () => {
  it("counts each file of one edit that changes several", () => {
    const stat = lineStat(dir, "edit_file", {
      edits: [
        { path: "src/styles.css", old: "a {}\n", new: "a {}\nb {}\nc {}\n" },
        { path: "src/main.js", old: "x();\ny();\n", new: "x();\n" },
      ],
    });
    expect(stat).toEqual({ added: 2, removed: 1, perFile: { "src/styles.css": { added: 2, removed: 0 }, "src/main.js": { added: 0, removed: 1 } } });
  });

  it("gives one file's lines without a breakdown", () => {
    expect(lineStat(dir, "edit_file", { path: "a.js", old: "1\n", new: "1\n2\n" })).toEqual({ added: 1, removed: 0 });
  });
});
