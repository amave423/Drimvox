import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

/** Bundles main, preload and the core process into CommonJS files Electron loads directly. */
export const options = {
  absWorkingDir: here,
  entryPoints: { main: "src/main.ts", preload: "src/preload.ts", "notice-preload": "src/notice-preload.ts", core: "src/core-process.ts" },
  outdir: "dist",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
  define: { __DRIMVOX_VERSION__: JSON.stringify(version) },
  sourcemap: true,
  logLevel: "info",
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await build(options);
