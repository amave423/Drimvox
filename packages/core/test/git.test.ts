import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commitAll, discardChanges } from "../src/agent/git";
import { git, makeRepo } from "./git-repo";

let repo: string | undefined;
afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  repo = undefined;
});

const put = (path: string, content = "x\n") => {
  mkdirSync(dirname(join(repo!, path)), { recursive: true });
  writeFileSync(join(repo!, path), content);
};
const committed = () => git(repo!, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).sort();

describe("commitAll", () => {
  // Seen live: a new project without .gitignore, after npm install, put node_modules into the work and broke the commit.
  it("leaves installed dependencies and tool caches out unless the project tracks them", async () => {
    repo = makeRepo({ "README.md": "# Demo\n" });
    put("src/app.js");
    put("node_modules/vite/index.js");
    put("node_modules/.vite/vitest/results.json");
    put("web/node_modules/react/index.js");
    put("__pycache__/app.cpython-312.pyc");
    put(".venv/bin/python");
    expect(await commitAll(repo, "Work")).toBe(true);
    expect(committed()).toEqual(["src/app.js"]);
  });

  it("still commits a dependency folder the project keeps in git", async () => {
    repo = makeRepo({ "node_modules/local/index.js": "a\n" });
    put("node_modules/local/index.js", "b\n");
    put("node_modules/local/extra.js");
    expect(await commitAll(repo, "Work")).toBe(true);
    expect(committed()).toEqual(["node_modules/local/extra.js", "node_modules/local/index.js"]);
  });

  it("says there was nothing to commit when only ignored folders changed", async () => {
    repo = makeRepo({ "README.md": "# Demo\n" });
    put("node_modules/vite/index.js");
    expect(await commitAll(repo, "Work")).toBe(false);
  });

  it.runIf(process.platform === "win32")("commits files whose full path is longer than Windows' 260 characters", async () => {
    repo = makeRepo({ "README.md": "# Demo\n" });
    const deep = `assets/${Array(6).fill("a-rather-long-folder-name-for-deep-nesting").join("/")}/icon.svg`;
    expect(join(repo, deep).length).toBeGreaterThan(260);
    put(deep);
    expect(await commitAll(repo, "Work")).toBe(true);
    expect(committed()).toEqual([deep]);
  });
});

describe("git under a busy repository", () => {
  // Seen in the team tests: a subtask failed on "unable to access .git/config: Permission denied" while another
  // agent's git rewrote it. Such a moment passes; the command is tried again.
  it("waits out another git holding the repository for a moment", async () => {
    repo = makeRepo({ "README.md": "# Demo\n" });
    put("src/app.js");
    const lock = join(repo, ".git", "index.lock");
    writeFileSync(lock, "");
    setTimeout(() => rmSync(lock, { force: true }), 200);
    expect(await commitAll(repo, "Work")).toBe(true);
    expect(committed()).toEqual(["src/app.js"]);
  });
});

describe("discardChanges", () => {
  // Seen live: after acceptance threw away its leftovers, node_modules went with them and the dev server would not start.
  it("throws away leftovers but keeps installed dependencies", async () => {
    repo = makeRepo({ "README.md": "# Demo\n" });
    put("node_modules/vite/index.js");
    put(".venv/bin/python");
    put("scratch.txt");
    put("README.md", "changed\n");
    await discardChanges(repo);
    expect(existsSync(join(repo, "node_modules/vite/index.js"))).toBe(true);
    expect(existsSync(join(repo, ".venv/bin/python"))).toBe(true);
    expect(existsSync(join(repo, "scratch.txt"))).toBe(false);
    expect(git(repo, "status", "--porcelain", "--untracked-files=no")).toBe("");
  });
});
