import { z } from "zod";
import type { ProviderError } from "./providers";

export const chatCreateSchema = z
  .object({
    providerId: z.string().min(1),
    model: z.string().min(1).max(200),
  })
  .strict();

export const chatUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    providerId: z.string().min(1).optional(),
    model: z.string().min(1).max(200).optional(),
  })
  .strict();

export const messageSendSchema = z
  .object({
    content: z.string().trim().min(1).max(200_000),
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
  | { type: "done"; message: MessageView };
