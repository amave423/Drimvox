// Development: Vite with hot reload for the UI, Electron restarted whenever main/preload/core change.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { context } from "esbuild";
import { options } from "../apps/desktop/build.mjs";

const DEV_URL = "http://localhost:5173";
const electronPath = createRequire(new URL("../apps/desktop/package.json", import.meta.url))("electron");
const isWindows = process.platform === "win32";

// npm is a .cmd shim on Windows, so it needs a shell; a single command string avoids Node's DEP0190 warning.
const vite = isWindows
  ? spawn("npm run dev -w @artel/web", { stdio: "inherit", shell: true })
  : spawn("npm", ["run", "dev", "-w", "@artel/web"], { stdio: "inherit" });
await waitFor(DEV_URL);

let electron = null;
let restarting = false;

function startElectron() {
  electron = spawn(electronPath, ["apps/desktop/dist/main.cjs"], {
    stdio: "inherit",
    env: { ...process.env, ARTEL_DEV_SERVER_URL: DEV_URL },
  });
  electron.on("exit", () => {
    if (!restarting) void shutdown();
  });
}

const restartOnBuild = {
  name: "restart-electron",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length) return;
      if (!electron) return startElectron();
      restarting = true;
      electron.once("exit", () => {
        restarting = false;
        startElectron();
      });
      electron.kill();
    });
  },
};

const ctx = await context({ ...options, plugins: [restartOnBuild] });
await ctx.watch();

process.on("SIGINT", () => void shutdown());

async function shutdown() {
  await ctx.dispose();
  killTree(vite);
  process.exit(0);
}

function killTree(child) {
  if (child.exitCode !== null) return;
  if (isWindows) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill();
}

async function waitFor(url, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${url} did not start in ${timeoutMs / 1000}s`);
}
