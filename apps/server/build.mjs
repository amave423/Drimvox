import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

/** Bundles the server and the core into one file Node runs; Playwright stays outside with its browsers. */
await build({
  absWorkingDir: here,
  entryPoints: { server: "src/main.ts" },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["playwright-core"],
  define: { __ARTEL_VERSION__: JSON.stringify(version) },
  // A name of its own: bundled code (pdf.js in unpdf) declares its own createRequire.
  banner: { js: "import { createRequire as artelCreateRequire } from 'node:module'; const require = artelCreateRequire(import.meta.url);" },
  sourcemap: true,
  logLevel: "info",
});
