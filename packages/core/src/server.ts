import { serve } from "@hono/node-server";
import { join } from "node:path";
import { createCore, type AppOptions } from "./app";
import { DB_FILE } from "./db-file";
import { openDatabase } from "./db";

export interface ServerOptions extends Omit<AppOptions, "db"> {
  host?: string;
  /** 0 picks a free port. */
  port?: number;
  /** The port is a wish: when it is taken, a free one is used instead. */
  portFallback?: boolean;
}

export interface RunningServer {
  port: number;
  /** Server mode: no password yet, so the setup code is needed to set one. */
  needsPassword(): boolean;
  close(): Promise<void>;
}

export function startServer(o: ServerOptions): Promise<RunningServer> {
  const db = openDatabase(join(o.dataDir, DB_FILE));
  const { app, shutdown, needsPassword } = createCore({ ...o, db });

  const listen = (port: number) =>
    new Promise<RunningServer>((resolvePromise, reject) => {
      const server = serve({ fetch: app.fetch, hostname: o.host ?? "127.0.0.1", port }, (info) => {
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
      server.once("error", reject);
    });
  // A port taken by another program: any free one, when the caller allows it.
  return listen(o.port ?? 0)
    .catch((err: NodeJS.ErrnoException) => (o.portFallback && err.code === "EADDRINUSE" ? listen(0) : Promise.reject(err)))
    .catch((err: unknown) => {
      db.close();
      throw err;
    });
}
