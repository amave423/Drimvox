import { build } from "esbuild";
import { noNative } from "./no-native.mjs";
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
  define: { __DRIMVOX_VERSION__: JSON.stringify(version) },
  // A name of its own: bundled code (pdf.js in unpdf) declares its own createRequire.
  // CommonJS packages bundled in (ssh2) look for __dirname too, which an ES module does not have.
  banner: {
    js: "import { createRequire as drimvoxCreateRequire } from 'node:module'; import { fileURLToPath as drimvoxFileUrl } from 'node:url'; import { dirname as drimvoxDirname } from 'node:path'; const require = drimvoxCreateRequire(import.meta.url); const __filename = drimvoxFileUrl(import.meta.url); const __dirname = drimvoxDirname(__filename);",
  },
  plugins: [noNative],
  sourcemap: true,
  logLevel: "info",
});
