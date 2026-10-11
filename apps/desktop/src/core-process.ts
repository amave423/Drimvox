/** Entry of the Electron utility process that runs the core. Same core runs headless in server mode. */
import { startServer } from "@artel/core";

const env = process.env;

function required(name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

startServer({
  token: required("ARTEL_TOKEN"),
  dataDir: required("ARTEL_DATA_DIR"),
  version: env.ARTEL_VERSION ?? "0.0.0",
  port: Number(env.ARTEL_PORT ?? 0),
  webDir: env.ARTEL_WEB_DIR || undefined,
})
  .then((server) => process.parentPort.postMessage({ type: "ready", port: server.port }))
  .catch((err: unknown) => {
    process.parentPort.postMessage({ type: "error", error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
