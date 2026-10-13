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
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  sourcemap: true,
  logLevel: "info",
});
