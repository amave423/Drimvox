import { zValidator } from "@hono/zod-validator";
import { settingsPatchSchema } from "@artel/shared";
import { Hono } from "hono";
import { ChatRepo } from "./chats/repo";
import type { Database } from "./db";
import { hostGuard, tokenGuard } from "./guards";
import { ProviderRepo } from "./providers/repo";
import { chatRoutes, usageRoutes } from "./routes/chats";
import { providerRoutes } from "./routes/providers";
import { createCipher } from "./secrets";
import { readSettings, writeSettings } from "./settings";
import { webHandler } from "./web";

export interface AppOptions {
  db: Database;
  /** Shared secret the UI sends as `Authorization: Bearer <token>`. */
  token: string;
  /** 32 bytes that encrypt provider keys at rest. */
  secretKey: Buffer;
  version: string;
  dataDir: string;
  /** Built UI to serve. Omitted in development, where Vite serves it. */
  webDir?: string;
  allowedHosts?: string[];
}

const defaultHosts = ["127.0.0.1", "localhost", "[::1]"];

export function createApp(o: AppOptions) {
  const providers = new ProviderRepo(o.db, createCipher(o.secretKey));
  const chats = new ChatRepo(o.db);

  const api = new Hono()
    .get("/health", (c) => c.json({ ok: true as const }))
    .get("/status", (c) =>
      c.json({
        version: o.version,
        dataDir: o.dataDir,
        schemaVersion: o.db.schemaVersion(),
        node: process.versions.node,
      }),
    )
    .get("/settings", (c) => c.json(readSettings(o.db)))
    .patch("/settings", zValidator("json", settingsPatchSchema), (c) =>
      c.json(writeSettings(o.db, c.req.valid("json"))),
    )
    .route("/providers", providerRoutes(providers))
    .route("/chats", chatRoutes(chats, providers))
    .route("/usage", usageRoutes(chats));

  const app = new Hono()
    .use("*", hostGuard(new Set(o.allowedHosts ?? defaultHosts)))
    .use("/api/*", tokenGuard(o.token, new Set(["/api/health"])))
    .route("/api", api);

  app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
  if (o.webDir) app.get("*", webHandler(o.webDir));
  return app;
}

export type AppType = ReturnType<typeof createApp>;
