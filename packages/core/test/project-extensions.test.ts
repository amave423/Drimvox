import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src";
import { ProjectExtensions } from "../src/projects/extensions";

describe("a project's skills and MCP servers", () => {
  const dir = mkdtempSync(join(tmpdir(), "dvx-ext-"));
  const db = openDatabase(join(dir, "drimvox.db"));

  it("uses all of them until chosen, then only the chosen ones, each project its own", () => {
    const ext = new ProjectExtensions(db);
    expect(ext.get("a")).toEqual({ skills: null, mcp: null });
    ext.set("a", { skills: ["frontend"] });
    ext.set("a", { mcp: [] });
    expect(ext.get("a")).toEqual({ skills: ["frontend"], mcp: [] });
    expect(ext.get("b")).toEqual({ skills: null, mcp: null });
    db.sql.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
