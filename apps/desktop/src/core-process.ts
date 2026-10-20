/** Entry of the Electron utility process that runs the core. Same core runs headless in server mode. */
import type { PageAction } from "@artel/shared";
import { startServer, type RunningServer } from "@artel/core";

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

/** Screenshots and pages read in a browser come from the main process, which has one; the core asks by message. */
const pending = new Map<number, { resolve(data: { png?: string; page?: unknown }): void; reject(err: Error): void }>();
let nextRequest = 1;
let running: RunningServer | null = null;
process.parentPort.on("message", ({ data }: { data: { type?: string; id?: number; png?: string; page?: unknown; error?: string } }) => {
  // The app is closing: stop what the core started (agents, the Ollama it runs), then go.
  if (data?.type === "quit") {
    setTimeout(() => process.exit(0), 2_500).unref();
    void (running?.close() ?? Promise.resolve()).finally(() => process.exit(0));
    return;
  }
  if ((data?.type !== "screenshot-done" && data?.type !== "page-text-done") || typeof data.id !== "number") return;
  const waiting = pending.get(data.id);
  pending.delete(data.id);
  if (data.png || data.page) waiting?.resolve(data);
  else waiting?.reject(new Error(data.error ?? "No answer from the browser"));
});

/** Asks the main process's browser and waits; a scenario of a few steps takes its time on top of loading the page. */
function askBrowser(message: Record<string, unknown>, timeoutMs: number): Promise<{ png?: string; page?: unknown }> {
  return new Promise((resolve, reject) => {
    const id = nextRequest++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("The page did not load in time"));
    }, timeoutMs);
    pending.set(id, {
      resolve: (data) => (clearTimeout(timer), resolve(data)),
      reject: (err) => (clearTimeout(timer), reject(err)),
    });
    process.parentPort.postMessage({ ...message, id });
  });
}

async function screenshot(url: string, size: { width: number; height: number }, actions?: PageAction[]): Promise<Buffer> {
  const data = await askBrowser({ type: "screenshot", url, ...size, ...(actions ? { actions } : {}) }, actions?.length ? 180_000 : 60_000);
  return Buffer.from(data.png!, "base64");
}

async function readPage(url: string, actions?: PageAction[]): Promise<{ url: string; title: string; text: string }> {
  const data = await askBrowser({ type: "page-text", url, ...(actions ? { actions } : {}) }, actions?.length ? 180_000 : 60_000);
  return data.page as { url: string; title: string; text: string };
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
    readPage,
    // Tests pin the dollar rate instead of asking the Central Bank.
    usdRub: process.env.ARTEL_TEST_USD_RUB ? async () => Number(process.env.ARTEL_TEST_USD_RUB) : undefined,
    // Tests run a fake Claude Code, Codex or Gemini CLI: {"claude-code": ["node", "fake-cli.mjs", "claude"]}.
    cliCommands: process.env.ARTEL_TEST_CLI ? JSON.parse(process.env.ARTEL_TEST_CLI) : undefined,
    // Tests: a fake public model catalog and a fake page to check the proxy against.
    presetUrls: {
      ...(process.env.ARTEL_TEST_OPENROUTER_URL ? { openrouter: process.env.ARTEL_TEST_OPENROUTER_URL } : {}),
      ...(process.env.ARTEL_TEST_OLLAMA_URL ? { ollama: process.env.ARTEL_TEST_OLLAMA_URL } : {}),
    },
    proxyCheckUrl: process.env.ARTEL_TEST_PROXY_CHECK_URL,
    // Tests: a fake Ollama program, fixed hardware and fake catalogs, as JSON of LocalOptions.
    local: process.env.ARTEL_TEST_LOCAL ? JSON.parse(process.env.ARTEL_TEST_LOCAL) : undefined,
    // Tests: a fake GitHub, as JSON of GithubOptions.
    github: process.env.ARTEL_TEST_GITHUB ? JSON.parse(process.env.ARTEL_TEST_GITHUB) : undefined,
  })
    .then((server) => {
      running = server;
      process.parentPort.postMessage({ type: "ready", port: server.port });
    })
    .catch((err: unknown) => {
      process.parentPort.postMessage({ type: "error", error: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    });
});
