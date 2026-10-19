import { z } from "zod";
import { mediaOptionsSchema, type MediaItem } from "./media";
import type { ProviderError } from "./providers";

/** What the chat's model makes: text answers, pictures or clips. */
export const chatKinds = ["text", "image", "video"] as const;
export type ChatKind = (typeof chatKinds)[number];

export const webModes = ["off", "free", "provider"] as const;
export type WebMode = (typeof webModes)[number];

/** How much the model thinks before it answers; "auto" leaves it to the provider. */
export const thinkingLevels = ["auto", "off", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];

export const chatCreateSchema = z
  .object({
    providerId: z.string().min(1),
    model: z.string().min(1).max(200),
    kind: z.enum(chatKinds).default("text"),
  })
  .strict();

export const chatUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    providerId: z.string().min(1).optional(),
    model: z.string().min(1).max(200).optional(),
    kind: z.enum(chatKinds).optional(),
  })
  .strict();

export const messageSendSchema = z
  .object({
    content: z.string().trim().min(1).max(200_000),
    /** Picture and video chats: size, length, sound. */
    options: mediaOptionsSchema.default({}),
    /** The user saw the price and pressed "Start"; needed for video and dear pictures. */
    confirm: z.boolean().default(false),
    /** Internet for this answer: none, Artel's free search tools, or the provider's paid web search. */
    web: z.enum(webModes).default("off"),
    thinking: z.enum(thinkingLevels).default("auto"),
    /** Files uploaded to the chat for this message (docs/specs/chat-attachments.md). */
    attachments: z.array(z.string().min(1)).max(10).default([]),
  })
  .strict();

/** A file to attach, as the window reads it. */
export const attachmentUploadSchema = z.object({ name: z.string().trim().min(1).max(260), type: z.string().max(200).default(""), data: z.string().min(1) }).strict();

/** An attached file: a picture the model sees, text it reads, or a file it only knows by name. */
export interface AttachmentView {
  id: string;
  name: string;
  type: string;
  size: number;
  kind: "image" | "text" | "none";
}

/** Connects a folder to a chat, or disconnects it with null. */
export const chatFolderSchema = z.object({ folder: z.string().trim().min(1).max(1000).nullable() }).strict();

export type ChatCreate = z.infer<typeof chatCreateSchema>;
export type ChatUpdate = z.infer<typeof chatUpdateSchema>;

export interface ChatView {
  id: string;
  /** Null until the first message names the chat. */
  title: string | null;
  providerId: string | null;
  model: string | null;
  kind: ChatKind;
  /** The folder the model works in; null for a chat without one. */
  folder: string | null;
  /** A task of a project's list worked on in this conversation (docs/specs/project-work.md); null for a plain chat. */
  projectId: string | null;
  itemId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type MessageStatus = "done" | "streaming" | "stopped" | "error";

export interface MessageView {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning: string | null;
  providerId: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** USD; null when the price of the model is unknown. */
  costUsd: number | null;
  status: MessageStatus;
  error: ProviderError | null;
  /** Pictures and clips of the answer. A clip still being made keeps the answer "streaming". */
  media: MediaItem[];
  /** The answer changed the chat's folder and can be undone. */
  canUndo: boolean;
  /** Files the user attached to this message. */
  attachments: AttachmentView[];
  createdAt: number;
}

export interface ChatWithMessages extends ChatView {
  messages: MessageView[];
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Messages whose price was unknown, so costUsd undercounts them. */
  unpricedMessages: number;
}

/** Server-sent events of POST /api/chats/:id/messages. */
export type StreamEvent =
  | { type: "start"; userMessage: MessageView; assistantMessageId: string }
  | { type: "reasoning"; text: string }
  | { type: "text"; text: string }
  /** The model searched or opened a page with Artel's internet tools, or called an MCP tool ("server/tool"). */
  | { type: "tool"; name: string; input: string }
  /** An MCP tool waits for the user's permission; answered with POST /api/chats/:id/approvals/:id. */
  /** A tool asks first: an MCP server's tool, or (with reason) a command in the chat's folder. */
  | { type: "approval"; id: string; server: string; tool: string; input: unknown; reason?: string; purpose?: string }
  | { type: "approved"; id: string; allowed: boolean }
  | { type: "done"; message: MessageView };
