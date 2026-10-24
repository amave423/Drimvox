import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { moveLegacyData } from "../src/legacy";
import { openDatabase } from "../src/db";

// The app was called Artel before Drimvox: what it kept under the old names comes along on the first start.
let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("data from before the rename", () => {
  it("takes the old database file, with its journal, under the new name", () => {
    dir = mkdtempSync(join(tmpdir(), "drimvox-legacy-"));
    writeFileSync(join(dir, "artel.db"), "db");
    writeFileSync(join(dir, "artel.db-wal"), "wal");
    moveLegacyData(dir);
    expect(readFileSync(join(dir, "drimvox.db"), "utf8")).toBe("db");
    expect(readFileSync(join(dir, "drimvox.db-wal"), "utf8")).toBe("wal");
    expect(existsSync(join(dir, "artel.db"))).toBe(false);
  });

  it("leaves a database that already has the new name alone", () => {
    dir = mkdtempSync(join(tmpdir(), "drimvox-legacy-"));
    writeFileSync(join(dir, "artel.db"), "old");
    writeFileSync(join(dir, "drimvox.db"), "new");
    moveLegacyData(dir);
    expect(readFileSync(join(dir, "drimvox.db"), "utf8")).toBe("new");
  });

  it("points the local picture engine of an old database at its new address", () => {
    dir = mkdtempSync(join(tmpdir(), "drimvox-legacy-"));
    const db = openDatabase(join(dir, "drimvox.db"));
    db.sql.prepare("insert into providers (id, preset, name, base_url, created_at, updated_at) values ('p', 'sdcpp', 'Картинки', 'artel://sdcpp', 1, 1)").run();
    db.close();
    const again = openDatabase(join(dir, "drimvox.db"));
    expect((again.sql.prepare("select base_url from providers where id = 'p'").get() as { base_url: string }).base_url).toBe("drimvox://sdcpp");
    again.close();
  });
});
