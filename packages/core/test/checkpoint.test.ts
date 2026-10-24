import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changedSince, checkpoint, restore } from "../src/chats/checkpoint";
import { git, makeRepo } from "./git-repo";

let repo: string;
beforeEach(() => {
  repo = makeRepo({ "app.js": "const a = 1;\n", "keep.txt": "keep\n", ".gitignore": "out/\n" });
});
afterEach(() => rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const REF = "refs/drimvox/chat/c1/m1";

describe("chat folder snapshots", () => {
  it("snapshots without touching branches, history or the user's staged work", async () => {
    writeFileSync(join(repo, "staged.txt"), "staged\n");
    git(repo, "add", "staged.txt");
    const before = { head: git(repo, "rev-parse", "HEAD"), status: git(repo, "status", "--porcelain"), branches: git(repo, "branch") };
    const commit = await checkpoint(repo, REF);
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect({ head: git(repo, "rev-parse", "HEAD"), status: git(repo, "status", "--porcelain"), branches: git(repo, "branch") }).toEqual(before);
    expect(await changedSince(repo, commit!)).toBe(false);
  });

  it("undoes the model's work: changed files come back, created ones go, ignored ones stay", async () => {
    const commit = (await checkpoint(repo, REF))!;
    writeFileSync(join(repo, "app.js"), "const a = 2;\n");
    rmSync(join(repo, "keep.txt"));
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "new.js"), "new\n");
    mkdirSync(join(repo, "out"));
    writeFileSync(join(repo, "out", "build.js"), "built\n");
    expect(await changedSince(repo, commit)).toBe(true);

    await restore(repo, commit);
    expect(readFileSync(join(repo, "app.js"), "utf8")).toBe("const a = 1;\n");
    expect(readFileSync(join(repo, "keep.txt"), "utf8")).toBe("keep\n");
    expect(existsSync(join(repo, "src", "new.js"))).toBe(false);
    expect(existsSync(join(repo, "out", "build.js"))).toBe(true);
    expect(await changedSince(repo, commit)).toBe(false);
  });

  it("has no snapshot for a folder without git", async () => {
    rmSync(join(repo, ".git"), { recursive: true, force: true });
    expect(await checkpoint(repo, REF)).toBeNull();
  });
});
