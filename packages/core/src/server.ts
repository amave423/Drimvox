import { serve } from "@hono/node-server";
import { join } from "node:path";
import { createApp, type AppOptions } from "./app";
import { openDatabase } from "./db";

export interface ServerOptions extends Omit<AppOptions, "db"> {
  host?: string;
  /** 0 picks a free port. */
  port?: number;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

export function startServer(o: ServerOptions): Promise<RunningServer> {
  const db = openDatabase(join(o.dataDir, "artel.db"));
  const app = createApp({ ...o, db });

  return new Promise((resolvePromise, reject) => {
    const server = serve({ fetch: app.fetch, hostname: o.host ?? "127.0.0.1", port: o.port ?? 0 }, (info) => {
      resolvePromise({
        port: info.port,
        close: () =>
          new Promise((done) => {
            server.close(() => {
              db.close();
              done();
            });
          }),
      });
    });
    server.once("error", (err) => {
      db.close();
      reject(err);
    });
  });
}
