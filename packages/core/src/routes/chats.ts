import { zValidator } from "@hono/zod-validator";
import { chatCreateSchema, chatUpdateSchema, messageSendSchema, presets } from "@artel/shared";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { reply } from "../chats/reply";
import type { ChatRepo } from "../chats/repo";
import type { ProviderRepo } from "../providers/repo";

const notFound = { error: { code: "not_found" } } as const;

export function chatRoutes(chats: ChatRepo, providers: ProviderRepo) {
  return new Hono()
    .get("/", (c) => c.json(chats.list()))
    .post("/", zValidator("json", chatCreateSchema), (c) => {
      const { providerId, model } = c.req.valid("json");
      if (!providers.get(providerId)) return c.json({ error: { code: "invalid", detail: "Unknown provider" } }, 400);
      return c.json(chats.create(providerId, model), 201);
    })
    .get("/:id", (c) => {
      const chat = chats.get(c.req.param("id"));
      return chat ? c.json(chat, 200) : c.json(notFound, 404);
    })
    .patch("/:id", zValidator("json", chatUpdateSchema), (c) => {
      const patch = c.req.valid("json");
      if (patch.providerId && !providers.get(patch.providerId)) {
        return c.json({ error: { code: "invalid", detail: "Unknown provider" } }, 400);
      }
      const chat = chats.update(c.req.param("id"), patch);
      return chat ? c.json(chat, 200) : c.json(notFound, 404);
    })
    .delete("/:id", (c) => (chats.remove(c.req.param("id")) ? c.body(null, 204) : c.json(notFound, 404)))
    .post("/:id/messages", zValidator("json", messageSendSchema), (c) => {
      const chat = chats.get(c.req.param("id"));
      if (!chat) return c.json(notFound, 404);
      const conn = chat.providerId ? providers.connection(chat.providerId) : null;
      if (!conn || !chat.model) return c.json({ error: { code: "invalid", detail: "Choose a model first" } }, 400);
      if (!conn.apiKey && presets[conn.preset].keyRequired) return c.json({ error: { code: "no_key" } }, 400);

      return streamSSE(c, async (stream) => {
        const controller = new AbortController();
        stream.onAbort(() => controller.abort());
        await reply({
          chats,
          chatId: chat.id,
          conn,
          model: chat.model!,
          content: c.req.valid("json").content,
          signal: controller.signal,
          emit: async (event) => {
            if (!controller.signal.aborted) await stream.writeSSE({ data: JSON.stringify(event) });
          },
        });
      });
    });
}

export function usageRoutes(chats: ChatRepo) {
  return new Hono().get("/", zValidator("query", z.object({ since: z.coerce.number().int().min(0) })), (c) =>
    c.json(chats.usageSince(c.req.valid("query").since)),
  );
}
