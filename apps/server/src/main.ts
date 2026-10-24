import { startServer } from "@drimvox/core";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { forgetSetupCode, loadSecretKey, loadSetupCode, readConfig, tailscaleName } from "./config";
import { closeBrowser, readPage, screenshot } from "./screenshot";

/** Injected by build.mjs. */
declare const __DRIMVOX_VERSION__: string;

/** The machine's name in the tailnet, when Tailscale runs here; `tailscale serve` sends requests under it. */
function tailscale(): Promise<string | null> {
  return new Promise((done) =>
    execFile("tailscale", ["status", "--json"], { timeout: 10_000 }, (err, stdout) => done(err ? null : tailscaleName(stdout))),
  );
}

async function main() {
  const config = readConfig(process.env, homedir());
  const here = fileURLToPath(new URL(".", import.meta.url));
  const webDir = resolve(here, "..", "..", "web", "dist");
  if (!existsSync(join(webDir, "index.html"))) throw new Error(`The UI is not built: ${webDir}. Run "npm run server" from the Drimvox folder.`);

  const name = await tailscale();
  const secretKey = loadSecretKey(config.dataDir);
  const code = loadSetupCode(config.dataDir);
  const server = await startServer({
    host: "127.0.0.1",
    port: config.port,
    dataDir: config.dataDir,
    webDir,
    secretKey,
    version: __DRIMVOX_VERSION__,
    allowedHosts: ["127.0.0.1", "localhost", "[::1]", ...(name ? [name] : []), ...config.hosts],
    password: { setupCode: code },
    screenshot,
    readPage,
  });

  console.log(`Drimvox ${__DRIMVOX_VERSION__} listens on http://127.0.0.1:${server.port}, data in ${config.dataDir}`);
  console.log(name ? `Open https://${name} (after "tailscale serve --bg ${server.port}")` : "Tailscale is not running: only this machine can open Drimvox.");
  if (server.needsPassword()) console.log(`No password yet. The code to set it in the browser: ${code}`);
  else forgetSetupCode(config.dataDir);

  const stop = async () => {
    await server.close();
    await closeBrowser();
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
