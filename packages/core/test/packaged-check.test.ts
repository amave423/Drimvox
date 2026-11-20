import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { electronApp, packagedNote } from "../src/work/packaged-check";

const folder = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "drimvox-packaged-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
};

// Seen live: Nexus crashed for its users on "Notification is not defined" — code behind app.isPackaged, which the
// tester's dev run never reached. An Electron project's tester is told to try the built app too.
describe("the built app of an Electron project", () => {
  it("finds the Electron app at the root or one folder down, and only there", () => {
    const nexus = folder({
      "server/package.json": JSON.stringify({ dependencies: { fastify: "5" } }),
      "app/package.json": JSON.stringify({ devDependencies: { electron: "39", "electron-builder": "26" }, scripts: { dist: "vite build && electron-builder" } }),
    });
    expect(electronApp(nexus)).toEqual({ dir: "app", builder: true, dist: "dist" });
    expect(electronApp(folder({ "package.json": JSON.stringify({ dependencies: { react: "19" } }) }))).toBeNull();
    expect(electronApp(folder({ "package.json": "{" }))).toBeNull();
  });

  it("tells the tester to build and try the packaged app, and points at what only runs there", () => {
    const app = { dir: "app", builder: true, dist: "dist" };
    const patch = [
      "diff --git a/app/electron/main.cjs b/app/electron/main.cjs",
      "+++ b/app/electron/main.cjs",
      "+  if (!payload.action && app.isPackaged && showNativeNotify(payload)) return;",
      "diff --git a/app/src/lib/Chat.svelte b/app/src/lib/Chat.svelte",
      "+  let x = 1;",
    ].join("\n");
    const note = packagedNote(app, patch)!;
    expect(note).toMatch(/electron-builder --dir/);
    expect(note).toMatch(/win-unpacked/);
    expect(note).toMatch(/minimi[sz]ed/);
    expect(note).toContain("app/electron/main.cjs");
    expect(note).not.toContain("Chat.svelte");
    expect(packagedNote(null, patch)).toBeNull();
  });
});
