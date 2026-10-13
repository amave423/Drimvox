import { serve } from "@hono/node-server";
import { join } from "node:path";
import { createCore, type AppOptions } from "./app";
import { openDatabase } from "./db";

export interface ServerOptions extends Omit<AppOptions, "db"> {
  host?: string;
  /** 0 picks a free port. */
  port?: number;
}

export interface RunningServer {
  port: number;
  /** Server mode: no password yet, so the setup code is needed to set one. */
  needsPassword(): boolean;
  close(): Promise<void>;
}

export function startServer(o: ServerOptions): Promise<RunningServer> {
  const db = openDatabase(join(o.dataDir, "artel.db"));
  const { app, shutdown, needsPassword } = createCore({ ...o, db });

  return new Promise((resolvePromise, reject) => {
    const server = serve({ fetch: app.fetch, hostname: o.host ?? "127.0.0.1", port: o.port ?? 0 }, (info) => {
      resolvePromise({
        port: info.port,
        needsPassword,
        close: async () => {
          await shutdown();
          // Live task streams stay open forever; cut them so close() can finish.
          (server as { closeAllConnections?: () => void }).closeAllConnections?.();
          await new Promise<void>((done) => server.close(() => done()));
          db.close();
        },
      });
    });
    server.once("error", (err) => {
      db.close();
      reject(err);
    });
  });
}
