import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { projectMap } from "../src/agent/repo-map";
import { makeRepo } from "./git-repo";

let repo = "";
afterEach(() => rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

// As Aider's repo map: a ready project's files with what each one defines, so the agent goes to the right file at once
// instead of listing folders and reading files to find it.
describe("a project's map", () => {
  it("lists the project's files with their size and what each defines, without dependencies or build output", async () => {
    const files: Record<string, string> = {
      "src/cart.ts": "export function addItem(id: string) {}\nexport class Cart {}\nconst inner = 1;\n",
      "src/api/orders.py": "class Order:\n    pass\n\ndef place_order(cart):\n    return 1\n",
      "server/main.go": "package main\n\nfunc Serve() {}\n",
      "README.md": "# Магазин\n",
      "node_modules/x/index.js": "export function hidden() {}\n",
      "dist/bundle.js": "function built() {}\n",
    };
    for (let n = 1; n <= 12; n++) files[`src/parts/part${n}.js`] = `export const part${n} = () => ${n};\n`;
    repo = makeRepo(files);
    const map = await projectMap(repo);
    expect(map).toContain("src/cart.ts (3 lines): addItem, Cart");
    expect(map).toContain("src/api/orders.py (5 lines): Order, place_order");
    expect(map).toContain("server/main.go (3 lines): Serve");
    expect(map).toContain("README.md (1 lines)");
    expect(map).not.toContain("node_modules");
    expect(map).not.toContain("bundle.js");
    expect(map).not.toContain("inner");
  });

  it("has nothing to say about a small project, and stays short for a large one", async () => {
    repo = makeRepo({ "index.html": "<h1>Сайт</h1>\n", "app.js": "function go() {}\n" });
    expect(await projectMap(repo)).toBe("");
    rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    const many: Record<string, string> = {};
    const fns = (n: number) => Array.from({ length: 12 }, (_, k) => `export function handleSomethingLong${n}x${k}() {}`).join("\n");
    for (let n = 1; n <= 120; n++) many[`src/features/module${n}/handlers${n}.ts`] = `${fns(n)}\n`;
    repo = makeRepo(many);
    const map = await projectMap(repo);
    expect(map.length).toBeLessThanOrEqual(12_500);
    expect(map).toMatch(/more files not shown/);
  }, 30_000);
});
