/** Entry of the Electron utility process that runs the core. Same core runs headless in server mode. */
import { startServer } from "@artel/core";

export interface InitMessage {
  type: "init";
  token: string;
  /** base64 of the 32-byte key that encrypts provider keys. */
  secretKey: string;
  dataDir: string;
  version: string;
  port: number;
  webDir?: string;
}

/** Screenshots come from the main process, which has a browser; the core asks for them by message. */
const shots = new Map<number, { resolve(png: Buffer): void; reject(err: Error): void }>();
let nextShot = 1;
process.parentPort.on("message", ({ data }: { data: { type?: string; id?: number; png?: string; error?: string } }) => {
  if (data?.type !== "screenshot-done" || typeof data.id !== "number") return;
  const waiting = shots.get(data.id);
  shots.delete(data.id);
  if (data.png) waiting?.resolve(Buffer.from(data.png, "base64"));
  else waiting?.reject(new Error(data.error ?? "No screenshot"));
});

function screenshot(url: string, size: { width: number; height: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const id = nextShot++;
    const timer = setTimeout(() => {
      shots.delete(id);
      reject(new Error("The page did not load in time"));
    }, 60_000);
    shots.set(id, {
      resolve: (png) => (clearTimeout(timer), resolve(png)),
      reject: (err) => (clearTimeout(timer), reject(err)),
    });
    process.parentPort.postMessage({ type: "screenshot", id, url, ...size });
  });
}

// Secrets arrive by message rather than environment variables, which other processes can read.
process.parentPort.once("message", ({ data }: { data: InitMessage }) => {
  startServer({
    token: data.token,
    secretKey: Buffer.from(data.secretKey, "base64"),
    dataDir: data.dataDir,
    version: data.version,
    port: data.port,
    webDir: data.webDir,
    screenshot,
    // Tests pin the dollar rate instead of asking the Central Bank.
    usdRub: process.env.ARTEL_TEST_USD_RUB ? async () => Number(process.env.ARTEL_TEST_USD_RUB) : undefined,
    // Tests run a fake Claude Code, Codex or Gemini CLI: {"claude-code": ["node", "fake-cli.mjs", "claude"]}.
    cliCommands: process.env.ARTEL_TEST_CLI ? JSON.parse(process.env.ARTEL_TEST_CLI) : undefined,
  })
    .then((server) => process.parentPort.postMessage({ type: "ready", port: server.port }))
    .catch((err: unknown) => {
      process.parentPort.postMessage({ type: "error", error: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    });
});
