// Bundles scripts/live-check.ts (it imports the TypeScript core) and runs it.
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const outfile = join(mkdtempSync(join(tmpdir(), "artel-live-build-")), "live-check.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("./live-check.ts", import.meta.url))],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
await import(pathToFileURL(outfile).href);
