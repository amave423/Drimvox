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

// Secrets arrive by message rather than environment variables, which other processes can read.
process.parentPort.once("message", ({ data }: { data: InitMessage }) => {
  startServer({
    token: data.token,
    secretKey: Buffer.from(data.secretKey, "base64"),
    dataDir: data.dataDir,
    version: data.version,
    port: data.port,
    webDir: data.webDir,
    // Tests pin the dollar rate instead of asking the Central Bank.
    usdRub: process.env.ARTEL_TEST_USD_RUB ? async () => Number(process.env.ARTEL_TEST_USD_RUB) : undefined,
  })
    .then((server) => process.parentPort.postMessage({ type: "ready", port: server.port }))
    .catch((err: unknown) => {
      process.parentPort.postMessage({ type: "error", error: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    });
});
