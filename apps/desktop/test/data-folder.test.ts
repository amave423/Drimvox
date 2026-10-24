import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dataFolder } from "../src/data-folder";

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the data folder after the rename from Artel", () => {
  it("becomes the new folder, with what was in it", () => {
    root = mkdtempSync(join(tmpdir(), "drimvox-folder-"));
    mkdirSync(join(root, "Artel"));
    writeFileSync(join(root, "Artel", "artel.db"), "chats");
    expect(dataFolder(join(root, "Drimvox"), join(root, "Artel"))).toBe(join(root, "Drimvox"));
    expect(readFileSync(join(root, "Drimvox", "artel.db"), "utf8")).toBe("chats");
    expect(existsSync(join(root, "Artel"))).toBe(false);
  });

  it("keeps a new folder that already exists, and starts fresh when there was nothing before", () => {
    root = mkdtempSync(join(tmpdir(), "drimvox-folder-"));
    mkdirSync(join(root, "Drimvox"));
    mkdirSync(join(root, "Artel"));
    expect(dataFolder(join(root, "Drimvox"), join(root, "Artel"))).toBe(join(root, "Drimvox"));
    expect(existsSync(join(root, "Artel"))).toBe(true);
    expect(dataFolder(join(root, "Other"), join(root, "Nothing"))).toBe(join(root, "Other"));
  });
});
