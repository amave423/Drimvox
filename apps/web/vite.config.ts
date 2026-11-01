import react from "@vitejs/plugin-react";
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";

/** The Mermaid the chat draws with, also as one script in dist/vendor: the agent draws diagrams into files with it. */
function mermaidFile(): Plugin {
  return {
    name: "drimvox-mermaid-file",
    apply: "build",
    writeBundle(options) {
      const out = join(options.dir ?? "dist", "vendor");
      mkdirSync(out, { recursive: true });
      copyFileSync(createRequire(import.meta.url).resolve("mermaid/dist/mermaid.min.js"), join(out, "mermaid.min.js"));
    },
  };
}

/** Core port in development; the desktop dev script starts core on it. */
export const DEV_CORE_PORT = 47800;

export default defineConfig({
  plugins: [react(), mermaidFile()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": `http://127.0.0.1:${DEV_CORE_PORT}` },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
