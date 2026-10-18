import { zValidator } from "@hono/zod-validator";
import {
  approvalDecisionSchema,
  chatCreateSchema,
  attachmentUploadSchema,
  chatFolderSchema,
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
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { extract, imageType } from "../chats/attachments";
import { restore } from "../chats/checkpoint";
import { folderTools } from "../chats/folder";
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
/** One attached file at most; the window sends ten at most. */
const MAX_ATTACHMENT = 20 * 1024 * 1024;

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
    // A folder the model works in (docs/specs/chat-folder.md); null disconnects it.
    .patch("/:id/folder", zValidator("json", chatFolderSchema), async (c) => {
      const chat = chats.get(c.req.param("id"));
      if (!chat) return c.json(notFound, 404);
      const asked = c.req.valid("json").folder;
      if (asked === null) return c.json(chats.setFolder(chat.id, null)!, 200);
      const folder = resolve(asked);
      if (!existsSync(folder) || !statSync(folder).isDirectory()) return c.json({ error: { code: "not_found" as const } }, 400);
      const conn = chat.providerId ? providers.connection(chat.providerId) : null;
      if (conn && chat.model && (await findModel(conn, chat.model))?.tools === false) return c.json({ error: { code: "no_tools" as const } }, 409);
      return c.json(chats.setFolder(chat.id, folder)!, 200);
    })
    // A file for the next message: kept, and read out at once (docs/specs/chat-attachments.md).
    .post("/:id/attachments", zValidator("json", attachmentUploadSchema), async (c) => {
      const chat = chats.get(c.req.param("id"));
      if (!chat) return c.json(notFound, 404);
      const { name, type, data } = c.req.valid("json");
      const bytes = Buffer.from(data, "base64");
      if (bytes.length > MAX_ATTACHMENT) return c.json({ error: { code: "too_big" as const } }, 413);
      const read = await extract(name, type, bytes);
      return c.json(chats.attachments.add(chat.id, { name, type, data: bytes, ...read }), 201);
    })
    .get("/:id/attachments/:attachmentId", (c) => {
      const file = chats.attachments.get(c.req.param("attachmentId"));
      if (!file || file.chatId !== c.req.param("id")) return c.json(notFound, 404);
      const type = file.kind === "image" ? imageType(file.type, file.name) : "application/octet-stream";
      return c.body(new Uint8Array(chats.attachments.file(file.id)), 200, { "content-type": type, "cache-control": "private, max-age=86400" });
    })
    // Puts the folder back as it was before this answer.
    .post("/:id/messages/:messageId/undo", async (c) => {
      const chat = chats.get(c.req.param("id"));
      const message = chat?.messages.find((m) => m.id === c.req.param("messageId"));
      const snapshot = message ? chats.checkpoint(message.id) : null;
      if (!chat?.folder || !message || !snapshot) return c.json(notFound, 404);
      await restore(chat.folder, snapshot);
      chats.setCheckpoint(message.id, null);
      return c.json({ ok: true as const }, 200);
    })
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
      const { content, options, confirm, web: webMode, attachments } = c.req.valid("json");
      const files = attachments.map((id) => chats.attachments.get(id));
      if (files.some((f) => !f || f.chatId !== chat.id)) return c.json(notFound, 404);

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
      const info = await findModel(conn, chat.model);
      const toolsOk = info?.tools !== false;
      const vision = info?.vision !== false;
      if (!vision && files.some((f) => f!.kind === "image")) return c.json({ error: { code: "no_vision" as const } }, 409);
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
          // With a folder the model reads, writes and runs commands in it; risky commands ask in the answer.
          extraTools: {
            ...mcpTools,
            ...(chat.folder && toolsOk
              ? folderTools(
                  chat.folder,
                  emit,
                  async (command, reason, signal) => (await approvals.ask(chat.id, emit, { server: "", tool: command, input: null, reason, signal })) !== false,
                  { list: () => chats.attachments.ofChat(chat.id), file: (id) => chats.attachments.file(id) },
                )
              : {}),
          },
          folder: toolsOk ? chat.folder : null,
          attachments,
          vision,
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
