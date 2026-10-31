import { isFreeToRun } from "../budget";
import { chatMarkdown } from "../chats/export";
import { zValidator } from "@hono/zod-validator";
import { type MonthUsage, type ModelSpending,
  approvalDecisionSchema,
  chatCreateSchema,
  attachmentUploadSchema,
  chatFolderSchema,
  chatUpdateSchema,
  estimateCost,
  messageBranchSchema, messageSendSchema,
  needsConfirmation,
  presets,
  type ActivityEntry,
  type FollowEvent,
  type StreamEvent,
} from "@drimvox/shared";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { extract, imageType } from "../chats/attachments";
import { restore } from "../chats/checkpoint";
import { folderTools } from "../chats/folder";
import { reply } from "../chats/reply";
import { makeTitle } from "../chats/title";
import { isCli } from "../cli/kinds";
import type { ChatRepo } from "../chats/repo";
import { mediaModel } from "../media/catalog";
import { findModel, listModels } from "../providers/catalog";
import type { ChatApprovals } from "../chats/approvals";
import type { WebAccess } from "../internet/web";
import type { McpHub } from "../mcp/hub";
import type { Studio } from "../media/studio";
import type { ProviderRepo } from "../providers/repo";
import type { ProjectPlan } from "@drimvox/shared";
import type { BacklogService } from "../backlog/service";
import { resolveVision } from "../visual/look";
import { visualTools, type VisualKit } from "../visual/tools";
import { WORK_STEPS, workRules } from "../work/prompt";
import { findSkills, projectSkillRoots, skillsInstructions, skillTools } from "../skills/skills";

/** What the activity line shows of a tool's input. */
/** The one thing of a call worth a line under the answer: the page, the command, the skill and its file. */
const describeInput = (input: unknown) => {
  const i = (input ?? {}) as { url?: unknown; command?: unknown; name?: unknown; path?: unknown };
  if (typeof i.url === "string") return i.url;
  if (typeof i.command === "string") return i.command;
  if (typeof i.name === "string") return typeof i.path === "string" ? `${i.name}/${i.path}` : i.name;
  return "";
};

const notFound = { error: { code: "not_found" } } as const;
/** Models on this computer answer one request at a time. */
const LOCAL_PRESETS = new Set(["ollama", "lmstudio"]);
/** How often an answer being written is saved: what a window coming back to the chat sees. */
const PROGRESS_MS = 1000;

/** What a project task's conversation needs beyond a chat with a folder (docs/specs/project-work.md). */
export interface WorkDeps {
  service: BacklogService;
  plan(projectId: string): ProjectPlan | null;
  visualKit: VisualKit;
  visionModel(): { providerId: string; model: string } | null;
  /** The settings' switch: commands in a chat's folder run without asking. */
  folderAutoApprove?(): boolean;
  /** Drimvox's shared skills; a folder's own (.drimvox/skills, .claude/skills) come first. */
  skillsDir: string;
  /** This month's spending against the app's budget. */
  month(): MonthUsage;
}

/** Looks at pages per answer of a task: the desktop and the phone, then again after a fix. */
const WORK_LOOKS = { looks: 8, then: "You have looked enough: finish with what you have and say what is left." };
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
  work: WorkDeps,
) {
  /** Answers being written, by chat: "Stop" reaches them from any window (seen: back in the chat, nothing could stop it). */
  const running = new Map<string, AbortController>();
  /** What an answer being written has so far, and the windows following it (GET /:id/follow). */
  const live = new Map<string, { snapshot: Extract<FollowEvent, { type: "snapshot" }>; listeners: Set<(event: FollowEvent | null) => void> }>();
  return new Hono()
    .get("/", (c) => c.json(chats.list()))
    .post("/", zValidator("json", chatCreateSchema), (c) => {
      const { providerId, model, kind } = c.req.valid("json");
      if (!providers.get(providerId)) return c.json({ error: { code: "invalid", detail: "Unknown provider" } }, 400);
      return c.json(chats.create(providerId, model, kind), 201);
    })
    .get("/:id", (c) => {
      const chat = chats.get(c.req.param("id"));
      return chat ? c.json({ ...chat, approvals: approvals.open(chat.id) }, 200) : c.json(notFound, 404);
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
    // Back in a chat whose answer is still being written: what it has so far, then the rest as it comes.
    .get("/:id/follow", (c) =>
      streamSSE(c, async (stream) => {
        const answer = live.get(c.req.param("id"));
        if (!answer) return;
        const queue: (FollowEvent | null)[] = [{ ...answer.snapshot, activity: [...answer.snapshot.activity] }];
        let wake: (() => void) | null = null;
        const listener = (event: FollowEvent | null) => {
          queue.push(event);
          wake?.();
        };
        answer.listeners.add(listener);
        stream.onAbort(() => listener(null));
        try {
          for (;;) {
            if (queue.length === 0) await new Promise<void>((r) => (wake = r));
            wake = null;
            const event = queue.shift();
            if (event === null || event === undefined) break;
            await stream.writeSSE({ data: JSON.stringify(event) });
            if (event.type === "done") break;
          }
        } finally {
          answer.listeners.delete(listener);
        }
      }),
    )
    .post("/:id/seen", (c) => (chats.markSeen(c.req.param("id")) ? c.json({ ok: true as const }, 200) : c.json(notFound, 404)))
    // The chat as Markdown, to save (asked for: export a chat).
    .get("/:id/export.md", (c) => {
      const chat = chats.get(c.req.param("id"));
      if (!chat) return c.json(notFound, 404);
      return c.body(chatMarkdown(chat, c.req.query("you") ?? "You"), 200, { "Content-Type": "text/markdown; charset=utf-8" });
    })
    // Another version of an edited message: the chat shows that branch and goes on from it.
    .post("/:id/branch", zValidator("json", messageBranchSchema), (c) => {
      const id = c.req.param("id");
      if (!chats.get(id)) return c.json(notFound, 404);
      if (running.has(id)) return c.json({ error: { code: "busy" } }, 409);
      return chats.branch(id, c.req.valid("json").messageId) ? c.json(chats.get(id)!, 200) : c.json(notFound, 404);
    })
    .post("/:id/stop", (c) => {
      const answer = running.get(c.req.param("id"));
      if (!answer) return c.json(notFound, 404);
      answer.abort();
      return c.json({ ok: true as const }, 200);
    })
    .post("/:id/approvals/:approvalId", zValidator("json", approvalDecisionSchema), (c) => {
      const { allow, always, server } = c.req.valid("json");
      const known = approvals.answer(c.req.param("id"), c.req.param("approvalId"), allow, always, server);
      return known ? c.json({ ok: true as const }, 200) : c.json(notFound, 404);
    })
    .post("/:id/messages", zValidator("json", messageSendSchema), async (c) => {
      const chat = chats.get(c.req.param("id"));
      if (!chat) return c.json(notFound, 404);
      const conn = chat.providerId ? providers.connection(chat.providerId) : null;
      if (!conn || !chat.model) return c.json({ error: { code: "invalid", detail: "Choose a model first" } }, 400);
      // The month's budget is used up: nothing new is paid for until it is raised (free and local models still answer).
      const month = work.month();
      if (month.over && !isFreeToRun(conn)) return c.json({ error: { code: "month_budget" as const, spentUsd: month.spentUsd, budgetUsd: month.budgetUsd } }, 409);
      if (!conn.apiKey && presets[conn.preset].keyRequired) return c.json({ error: { code: "no_key" } }, 400);
      const { content, options, confirm, web: webMode, attachments, thinking, editOf, director } = c.req.valid("json");
      // An edit: a text chat's own message, while nothing is being answered; a program on a subscription keeps its own
      // session and cannot go back in it.
      const edited = editOf ? chats.userMessage(chat.id, editOf) : null;
      if (editOf && (!edited || chat.kind !== "text" || isCli(conn.preset))) return c.json({ error: { code: "invalid", detail: "Only your own message in a text chat can be edited" } }, 400);
      if (edited && running.has(chat.id)) return c.json({ error: { code: "busy" } }, 409);
      const files = attachments.map((id) => chats.attachments.get(id));
      if (files.some((f) => !f || f.chatId !== chat.id)) return c.json(notFound, 404);

      if (chat.kind !== "text") {
        const model = await mediaModel(conn, chat.kind, chat.model);
        if (!model) return c.json({ error: { code: "invalid", detail: "Unknown media model" } }, 400);
        // Video, dear pictures and unknown prices start only after the user saw the price.
        // Photos only to a model that takes them; one that needs one gets none without it (docs/specs/media.md).
        const photos = files.filter((f) => f!.kind === "image");
        if (files.length > photos.length) return c.json({ error: { code: "no_photo_input" as const } }, 409);
        if (photos.length > 0 && !model.photos) return c.json({ error: { code: "no_photo_input" as const } }, 409);
        if (model.photos && photos.length < model.photos.min) return c.json({ error: { code: "photo_required" as const } }, 409);
        if (model.photos && photos.length > model.photos.max) return c.json({ error: { code: "too_many_photos" as const, max: model.photos.max } }, 409);
        // With a director every attempt is paid: the price asked about is all of them (a clip is one per message).
        const tries = director ? (model.kind === "video" ? 1 : director.attempts) : 1;
        const one = estimateCost(model, options);
        const estimateUsd = one === null ? null : one * tries;
        if (needsConfirmation(model, estimateUsd) && !confirm) return c.json({ error: { code: "confirm", estimateUsd } }, 409);
        const photoFiles = { ids: photos.map((f) => f!.id), files: photos.map((f) => ({ mime: f!.type, data: chats.attachments.file(f!.id) })) };
        if (director) {
          const dconn = providers.connection(director.providerId);
          if (!dconn) return c.json({ error: { code: "invalid", detail: "Unknown provider" } }, 400);
          const info = await findModel(dconn, director.model);
          // Seen: a director without eyes cannot tell what it made, and keeps redrawing blindly.
          if (info?.vision === false) return c.json({ error: { code: "no_vision" as const } }, 409);
          return streamSSE(c, async (stream) => {
            const controller = new AbortController();
            stream.onAbort(() => controller.abort());
            await studio.direct({
              chatId: chat.id,
              director: { conn: dconn, model: director.model, price: info },
              painter: { conn, model },
              attempts: director.attempts,
              sketches: director.sketches,
              content,
              options,
              photos: photoFiles,
              signal: controller.signal,
              emit: async (event) => {
                if (!controller.signal.aborted) await stream.writeSSE({ data: JSON.stringify(event) });
              },
            });
          });
        }
        return streamSSE(c, async (stream) => {
          await studio.reply({
            chatId: chat.id,
            conn,
            model,
            prompt: content,
            options,
            photos: { ids: photos.map((f) => f!.id), files: photos.map((f) => ({ mime: f!.type, data: chats.attachments.file(f!.id) })) },
            emit: async (event) => {
              await stream.writeSSE({ data: JSON.stringify(event) });
            },
          });
        });
      }

      // A model that cannot call tools gets none: no free search, no MCP. The provider's own search needs no tools.
      // A chat's first message: while the model answers, it also names the chat in a few words (seen live: the whole
      // first message became the name). Claude Code and Codex cannot be asked aside, and a model on this computer would
      // make the answer itself wait: their chats keep the short title.
      if (chat.messages.length === 0 && !chat.title && !isCli(conn.preset) && !LOCAL_PRESETS.has(conn.preset)) {
        void makeTitle(conn, chat.model, content)
          .then((title) => title && chats.retitle(chat.id, content, title))
          .catch(() => {});
      }
      const info = await findModel(conn, chat.model);
      const toolsOk = info?.tools !== false;
      const vision = info?.vision !== false;
      if (!vision && files.some((f) => f!.kind === "image")) return c.json({ error: { code: "no_vision" as const } }, 409);
      return streamSSE(c, async (stream) => {
        const controller = new AbortController();
        stream.onAbort(() => controller.abort());
        running.set(chat.id, controller);
        // What the model does is kept with its answer, not only streamed (seen: it vanished once the chat reloaded), and
        // saved as it goes, so a window that comes back to the chat sees how far the answer got.
        const activity: ActivityEntry[] = [];
        const partial = { id: "", content: "", reasoning: "", savedAt: 0 };
        const saveProgress = (force = false) => {
          if (!partial.id || (!force && Date.now() - partial.savedAt < PROGRESS_MS)) return;
          partial.savedAt = Date.now();
          chats.saveProgress(partial.id, { content: partial.content, reasoning: partial.reasoning || null, activity });
        };
        const following = { snapshot: { type: "snapshot" as const, assistantMessageId: "", content: "", reasoning: "", activity }, listeners: new Set<(event: FollowEvent | null) => void>() };
        live.set(chat.id, following);
        const emit = async (event: StreamEvent) => {
          if (event.type === "start") partial.id = following.snapshot.assistantMessageId = event.assistantMessageId;
          if (event.type === "text") partial.content += event.text;
          if (event.type === "reasoning") partial.reasoning += event.text;
          if (event.type === "tool") activity.push({ name: event.name, input: event.input, at: partial.content.length });
          following.snapshot.content = partial.content;
          following.snapshot.reasoning = partial.reasoning;
          for (const listener of following.listeners) listener(event);
          saveProgress(event.type === "tool");
          if (!controller.signal.aborted) await stream.writeSSE({ data: JSON.stringify(event) });
        };
        // MCP tools of the user's servers; each new tool asks in the answer first.
        const mcpTools = toolsOk
          ? await mcp.toolsFor((call) => approvals.ask(chat.id, emit, call), {
              onCall: (call) => void emit({ type: "tool", name: call.name, input: JSON.stringify(call.input) }),
              onResult: () => {},
            })
          : {};
        // A task of a project's list: its rules, more steps, a dev server in the background and a look at the pages.
        const task = chat.itemId && chat.projectId && chat.folder && toolsOk ? chat : null;
        if (task) work.service.working(chat.id);
        const workTools =
          task && task.folder
            ? visualTools(
                {
                  kit: work.visualKit,
                  taskId: chat.id,
                  worktree: task.folder,
                  vision: await resolveVision(work.visionModel(), providers, { providerId: conn.id, model: chat.model! }, findModel, listModels),
                  hooks: { onCall: (call) => void emit({ type: "tool", name: call.name, input: describeInput(call.input) }), onResult: () => {}, askApproval: async () => false },
                  onSpend: () => {},
                  event: () => {},
                },
                WORK_LOOKS,
              )
            : {};
        // Skills for a chat with a folder: the folder's own first, then the shared ones.
        const skills = chat.folder && toolsOk ? findSkills([...projectSkillRoots(chat.folder), { dir: work.skillsDir, scope: "shared" }]) : [];
        const skillHooks = { onCall: (call: { name: string; input: unknown }) => void emit({ type: "tool", name: call.name, input: describeInput(call.input) }), onResult: () => {} };
        await reply({
          chats,
          chatId: chat.id,
          work: task || skills.length ? { system: [task ? workRules(work.plan(task.projectId!)) : "", skillsInstructions(skills)].filter(Boolean).join("\n"), steps: task ? WORK_STEPS : 0 } : undefined,
          conn,
          model: chat.model!,
          content,
          ...(edited ? { edit: { parentId: edited.parentId, from: edited.id } } : {}),
          signal: controller.signal,
          idleTimeoutMs,
          web: !toolsOk && webMode === "free" ? "off" : webMode,
          thinking,
          webAccess: web,
          // With a folder the model reads, writes and runs commands in it; risky commands ask in the answer.
          extraTools: {
            ...mcpTools,
            ...workTools,
            ...(chat.folder ? skillTools(skills, chat.folder, skillHooks) : {}),
            ...(chat.folder && toolsOk
              ? folderTools(
                  chat.folder,
                  emit,
                  async (command, reason, signal, purpose) =>
                    // Asked for: with the switch on, the folder's commands run without a card to click.
                    work.folderAutoApprove?.() ||
                    (await approvals.ask(chat.id, emit, { server: "", tool: command, input: null, reason, purpose, signal })) !== false,
                  { list: () => chats.attachments.ofChat(chat.id), file: (id) => chats.attachments.file(id) },
                  // Pictures in the folder: the settings' vision model, else the chat's own when it sees them.
                  await resolveVision(work.visionModel(), providers, { providerId: conn.id, model: chat.model! }, findModel, listModels),
                )
              : {}),
          },
          folder: toolsOk ? chat.folder : null,
          attachments,
          vision,
          cliDir,
          emit,
          activity: () => activity,
        }).finally(() => {
          if (running.get(chat.id) === controller) running.delete(chat.id);
          if (live.get(chat.id) === following) live.delete(chat.id);
          // A stopped answer sends no "done": its followers end here.
          for (const listener of following.listeners) listener(null);
        });
        if (task) {
          // A dev server the agent started does not hold the port once it answered (seen: "npm run dev" failed after).
          work.visualKit.background.stopAll(chat.id);
          const last = chats.get(chat.id)?.messages.at(-1);
          if (last?.role === "assistant" && last.status === "done") work.service.answered(chat.id);
        }
      });
    });
}

export function usageRoutes(chats: ChatRepo, month: () => MonthUsage, byModel: (since: number) => Promise<ModelSpending[]>) {
  return new Hono()
    .get("/", zValidator("query", z.object({ since: z.coerce.number().int().min(0) })), (c) => c.json(chats.usageSince(c.req.valid("query").since)))
    .get("/month", (c) => c.json(month()))
    .get("/models", zValidator("query", z.object({ since: z.coerce.number().int().min(0) })), async (c) => c.json(await byModel(c.req.valid("query").since)));
}
