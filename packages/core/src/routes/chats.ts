import { zValidator } from "@hono/zod-validator";
import {
  approvalDecisionSchema,
  chatCreateSchema,
  chatUpdateSchema,
  estimateCost,
  messageSendSchema,
  needsConfirmation,
  presets,
  type StreamEvent,
} from "@artel/shared";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { reply } from "../chats/reply";
import type { ChatRepo } from "../chats/repo";
import { mediaModel } from "../media/catalog";
import { findModel } from "../providers/catalog";
import type { ChatApprovals } from "../chats/approvals";
import type { WebAccess } from "../internet/web";
import type { McpHub } from "../mcp/hub";
import type { Studio } from "../media/studio";
import type { ProviderRepo } from "../providers/repo";

const notFound = { error: { code: "not_found" } } as const;

export function chatRoutes(
  chats: ChatRepo,
  providers: ProviderRepo,
  studio: Studio,
  web: WebAccess,
  mcp: McpHub,
  approvals: ChatApprovals,
  idleTimeoutMs: number,
  cliDir: string,
) {
  return new Hono()
    .get("/", (c) => c.json(chats.list()))
    .post("/", zValidator("json", chatCreateSchema), (c) => {
      const { providerId, model, kind } = c.req.valid("json");
      if (!providers.get(providerId)) return c.json({ error: { code: "invalid", detail: "Unknown provider" } }, 400);
      return c.json(chats.create(providerId, model, kind), 201);
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
    .post("/:id/approvals/:approvalId", zValidator("json", approvalDecisionSchema), (c) => {
      const { allow, always } = c.req.valid("json");
      const known = approvals.answer(c.req.param("id"), c.req.param("approvalId"), allow, always);
      return known ? c.json({ ok: true as const }, 200) : c.json(notFound, 404);
    })
    .post("/:id/messages", zValidator("json", messageSendSchema), async (c) => {
      const chat = chats.get(c.req.param("id"));
      if (!chat) return c.json(notFound, 404);
      const conn = chat.providerId ? providers.connection(chat.providerId) : null;
      if (!conn || !chat.model) return c.json({ error: { code: "invalid", detail: "Choose a model first" } }, 400);
      if (!conn.apiKey && presets[conn.preset].keyRequired) return c.json({ error: { code: "no_key" } }, 400);
      const { content, options, confirm, web: webMode } = c.req.valid("json");

      if (chat.kind !== "text") {
        const model = await mediaModel(conn, chat.kind, chat.model);
        if (!model) return c.json({ error: { code: "invalid", detail: "Unknown media model" } }, 400);
        // Video, dear pictures and unknown prices start only after the user saw the price.
        const estimateUsd = estimateCost(model, options);
        if (needsConfirmation(model, estimateUsd) && !confirm) return c.json({ error: { code: "confirm", estimateUsd } }, 409);
        return streamSSE(c, async (stream) => {
          await studio.reply({
            chatId: chat.id,
            conn,
            model,
            prompt: content,
            options,
            emit: async (event) => {
              await stream.writeSSE({ data: JSON.stringify(event) });
            },
          });
        });
      }

      // A model that cannot call tools gets none: no free search, no MCP. The provider's own search needs no tools.
      const toolsOk = (await findModel(conn, chat.model))?.tools !== false;
      return streamSSE(c, async (stream) => {
        const controller = new AbortController();
        stream.onAbort(() => controller.abort());
        const emit = async (event: StreamEvent) => {
          if (!controller.signal.aborted) await stream.writeSSE({ data: JSON.stringify(event) });
        };
        // MCP tools of the user's servers; each new tool asks in the answer first.
        const mcpTools = toolsOk
          ? await mcp.toolsFor((call) => approvals.ask(chat.id, emit, call), {
              onCall: (call) => void emit({ type: "tool", name: call.name, input: JSON.stringify(call.input) }),
              onResult: () => {},
            })
          : {};
        await reply({
          chats,
          chatId: chat.id,
          conn,
          model: chat.model!,
          content,
          signal: controller.signal,
          idleTimeoutMs,
          web: !toolsOk && webMode === "free" ? "off" : webMode,
          webAccess: web,
          extraTools: mcpTools,
          cliDir,
          emit,
        });
      });
    });
}

export function usageRoutes(chats: ChatRepo) {
  return new Hono().get("/", zValidator("query", z.object({ since: z.coerce.number().int().min(0) })), (c) =>
    c.json(chats.usageSince(c.req.valid("query").since)),
  );
}
