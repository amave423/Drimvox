// Bundles scripts/bench.ts (it imports the TypeScript core) and runs it. The bundle sits in node_modules/.cache so
// that playwright-core, left out of it, still resolves.
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
mkdirSync(join(root, "node_modules", ".cache"), { recursive: true });
const outfile = join(root, "node_modules", ".cache", "bench.mjs");
await build({
  entryPoints: [join(root, "scripts", "bench.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
  external: ["playwright-core", "electron"],
  // A name of its own: bundled code (pdf.js in unpdf) declares its own createRequire.
  banner: { js: "import { createRequire as drimvoxCreateRequire } from 'node:module'; const require = drimvoxCreateRequire(import.meta.url);" },
});
await import(pathToFileURL(outfile).href);
