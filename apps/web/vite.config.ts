import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Core port in development; the desktop dev script starts core on it. */
export const DEV_CORE_PORT = 47800;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": `http://127.0.0.1:${DEV_CORE_PORT}` },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
