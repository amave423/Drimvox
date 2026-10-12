import { z } from "zod";
import { mediaOptionsSchema, type MediaItem } from "./media";
import type { ProviderError } from "./providers";

/** What the chat's model makes: text answers, pictures or clips. */
export const chatKinds = ["text", "image", "video"] as const;
export type ChatKind = (typeof chatKinds)[number];

export const webModes = ["off", "free", "provider"] as const;
export type WebMode = (typeof webModes)[number];

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
  })
  .strict();

export type ChatCreate = z.infer<typeof chatCreateSchema>;
export type ChatUpdate = z.infer<typeof chatUpdateSchema>;

export interface ChatView {
  id: string;
  /** Null until the first message names the chat. */
  title: string | null;
  providerId: string | null;
  model: string | null;
  kind: ChatKind;
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
  /** The model searched or opened a page with Artel's internet tools. */
  | { type: "tool"; name: "web_search" | "open_page"; input: string }
  | { type: "done"; message: MessageView };
