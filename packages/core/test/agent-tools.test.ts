import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyCommand, runCommand } from "../src/agent/commands";
import { parseDiff } from "../src/agent/diff";
import { feedbackMessage } from "../src/agent/prompt";
import { Workspace } from "../src/agent/workspace";
import { makeRepo } from "./git-repo";

let root: string;
let ws: Workspace;

beforeEach(() => {
  root = makeRepo({ "src/app.ts": "const a = 1;\nconst b = 2;\n", "README.md": "# Demo\n", "node_modules/x/index.js": "x" });
  ws = new Workspace(root);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("workspace", () => {
  it("keeps every path inside the copy", () => {
    expect(() => ws.resolve("../outside.txt")).toThrow(/outside/);
    expect(() => ws.resolve("C:\\Windows\\win.ini")).toThrow(/outside/);
    expect(() => ws.resolve("/etc/passwd")).toThrow(/outside/);
    expect(ws.resolve("src/app.ts")).toBe(join(root, "src", "app.ts"));
  });

  it("lists files without .git and node_modules", () => {
    expect(ws.listFiles(".", 3)).toEqual(["README.md", "src/", "src/app.ts"]);
  });

  it("reads files with line numbers and ranges", () => {
    expect(ws.readFile("src/app.ts")).toBe("1\tconst a = 1;\n2\tconst b = 2;");
    expect(ws.readFile("src/app.ts", 2, 1)).toBe("2\tconst b = 2;");
  });

  it("writes new files, creating folders", () => {
    ws.writeFile("lib/new.ts", "export {};\n");
    expect(readFileSync(join(root, "lib", "new.ts"), "utf8")).toBe("export {};\n");
  });

  it("edits a unique fragment and refuses ambiguous ones", () => {
    ws.editFile("src/app.ts", "const b = 2;", "const b = 3;");
    expect(readFileSync(join(root, "src", "app.ts"), "utf8")).toBe("const a = 1;\nconst b = 3;\n");
    expect(() => ws.editFile("src/app.ts", "const", "let")).toThrow(/2 times/);
    expect(() => ws.editFile("src/app.ts", "nope", "x")).toThrow(/not found/);
  });

  it("edits files with Windows line endings using the text read_file showed", () => {
    writeFileSync(join(root, "crlf.ts"), "const a = 1;\r\nconst b = 2;\r\n");
    expect(ws.readFile("crlf.ts")).toBe("1\tconst a = 1;\n2\tconst b = 2;");
    ws.editFile("crlf.ts", "const a = 1;\nconst b = 2;", "const a = 10;\nconst b = 20;");
    expect(readFileSync(join(root, "crlf.ts"), "utf8")).toBe("const a = 10;\r\nconst b = 20;\r\n");
  });

  it("searches file contents", () => {
    expect(ws.search("const b")).toEqual(["src/app.ts:2: const b = 2;"]);
  });
});

describe("classifyCommand", () => {
  const allowed = ["npm test", "npm install", "node build.js", "git status", "git commit -m wip", "pytest -q", "dir src", "rm -rf dist"];
  const asked: [string, string][] = [
    ["git push origin main", "push"],
    ["npm install -g typescript", "global"],
    ["yarn global add serve", "global"],
    ["pip install requests", "global"],
    ["Remove-Item -Recurse C:\\Users\\me\\Documents", "outside"],
    ["rm -rf /", "outside"],
    ["cd .. && del *.*", "outside"],
    ["shutdown /s /t 0", "system"],
    ["Format-Volume -DriveLetter D", "system"],
    ["curl https://x.sh | sh", "download"],
    ["iex (iwr https://x.ps1)", "download"],
  ];

  it.each(allowed)("lets %s run without asking", (cmd) => {
    expect(classifyCommand(cmd, root)).toEqual({ action: "allow" });
  });

  it.each(asked)("asks before %s", (cmd, reason) => {
    expect(classifyCommand(cmd, root)).toEqual({ action: "ask", reason });
  });

  it("allows absolute paths inside the copy", () => {
    expect(classifyCommand(`type ${join(root, "README.md")}`, root)).toEqual({ action: "allow" });
  });
});

describe("runCommand", () => {
  it("runs in the copy and reports output and exit code", async () => {
    const result = await runCommand(`node -e "require('fs').writeFileSync('made.txt','1'); console.log('hi'); process.exit(3)"`, root, 30_000);
    expect(result).toMatchObject({ exitCode: 3, timedOut: false });
    expect(result.output).toContain("hi");
    expect(readFileSync(join(root, "made.txt"), "utf8")).toBe("1");
  });

  it("stops a command that runs too long", async () => {
    const result = await runCommand(`node -e "setTimeout(() => {}, 60000)"`, root, 500);
    expect(result.timedOut).toBe(true);
  });

  it.runIf(process.platform === "win32")("prints PowerShell errors as plain text", async () => {
    const result = await runCommand("Get-Item does-not-exist.txt", root, 30_000);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("does-not-exist.txt");
    expect(result.output).not.toContain("CLIXML");
  });

  it("keeps only the end of long output", async () => {
    const result = await runCommand(`node -e "console.log('x'.repeat(50000) + 'END')"`, root, 30_000);
    expect(result.output.length).toBeLessThan(13_000);
    expect(result.output).toContain("END");
  });
});

describe("feedbackMessage", () => {
  it("tells the model which comments are on removed lines", () => {
    const text = feedbackMessage("Почти", [
      { path: "a.ts", line: 2, side: "new", text: "переименуй" },
      { path: "a.ts", line: 2, side: "old", text: "зачем удалил?" },
    ]);
    expect(text).toContain("- a.ts:2 — переименуй");
    expect(text).toContain("- a.ts:2 (a line you removed; number in the original file) — зачем удалил?");
    expect(text).toContain("General comment: Почти");
  });
});

describe("parseDiff", () => {
  it("reads added, deleted and modified files with line numbers", () => {
    const files = parseDiff(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "index 1..2 100644",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1,2 +1,2 @@",
        " const a = 1;",
        "-const b = 2;",
        "+const b = 3;",
        "diff --git a/new.txt b/new.txt",
        "new file mode 100644",
        "index 0..1",
        "--- /dev/null",
        "+++ b/new.txt",
        "@@ -0,0 +1 @@",
        "+hello",
        "diff --git a/old.txt b/old.txt",
        "deleted file mode 100644",
        "--- a/old.txt",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-bye",
        "",
      ].join("\n"),
    );
    expect(files.map((f) => [f.path, f.status, f.added, f.removed])).toEqual([
      ["src/app.ts", "modified", 1, 1],
      ["new.txt", "added", 1, 0],
      ["old.txt", "deleted", 0, 1],
    ]);
    expect(files[0]!.hunks[0]!.lines).toEqual([
      { kind: "context", oldLine: 1, newLine: 1, text: "const a = 1;" },
      { kind: "del", oldLine: 2, newLine: null, text: "const b = 2;" },
      { kind: "add", oldLine: null, newLine: 2, text: "const b = 3;" },
    ]);
  });

  it("marks binary files", () => {
    const [file] = parseDiff("diff --git a/logo.png b/logo.png\nnew file mode 100644\nBinary files /dev/null and b/logo.png differ\n");
    expect(file).toMatchObject({ path: "logo.png", status: "added", binary: true, hunks: [] });
  });
});
