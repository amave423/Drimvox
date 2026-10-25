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
    /** Internet for this answer: none, Drimvox's free search tools, or the provider's paid web search. */
    web: z.enum(webModes).default("off"),
    thinking: z.enum(thinkingLevels).default("auto"),
    /** Files uploaded to the chat for this message (docs/specs/chat-attachments.md). */
    attachments: z.array(z.string().min(1)).max(10).default([]),
    /** Pictures and clips through a director: a text model that sees pictures writes the prompts and checks the results. */
    director: z
      .object({ providerId: z.string().min(1), model: z.string().min(1).max(200), attempts: z.number().int().min(1).max(5), sketches: z.boolean().default(false) })
      .optional(),
    /** The user's message this one replaces: the answer goes on a branch of its own, the old one stays (docs/specs/chats.md). */
    editOf: z.string().min(1).optional(),
  })
  .strict();

/** Which version of an edited message to show: the chat goes on from the end of its branch. */
export const messageBranchSchema = z.object({ messageId: z.string().min(1) }).strict();

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
  /** An answer is being written: the list shows a spinner on the chat. */
  answering: boolean;
  /** An answer came while the chat was not open: the list shows a dot until it is. */
  unread: boolean;
}

export type MessageStatus = "done" | "streaming" | "stopped" | "error";

/**
 * A tool the model called while answering: its name, what it was called on, and where in the answer's text it happened,
 * so the answer reads in order (text, the actions, text again) instead of the actions on top (seen: the text jumped down
 * with every new action). A screenshot of a project's page is an entry too, with its id as the input.
 */
export interface ActivityEntry {
  name: string;
  input: string;
  /** How long the answer's text was when the tool was called; absent in answers saved before it was kept. */
  at?: number;
}

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
  /** The tools the model called while answering, in order: the name and what it was called on. */
  activity: ActivityEntry[];
  /** A message the user edited: which of its versions this is, of how many, and their ids to switch to. */
  versions: { index: number; count: number; ids: string[] } | null;
  createdAt: number;
}

export interface ChatWithMessages extends ChatView {
  messages: MessageView[];
  /** Requests the answer being written waits on: a window that comes back to the chat shows them to answer. */
  approvals: ChatApprovalView[];
}

/** A tool that asks first: an MCP server's tool, or (with reason) a command in the chat's folder. */
export interface ChatApprovalView {
  id: string;
  server: string;
  tool: string;
  input: unknown;
  reason?: string;
  purpose?: string;
}

/** One model's spending over a time, and cheaper models of the same maker with what the same answers would have cost. */
export interface ModelSpending {
  providerId: string;
  providerName: string;
  model: string;
  answers: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  cheaper: { model: string; name: string; priceIn: number; priceOut: number; wouldCostUsd: number }[];
}

/** This month's spending against the app's monthly budget. */
export interface MonthUsage {
  spentUsd: number;
  budgetUsd: number | null;
  /** The budget is used up: new answers, pictures and runs wait until it is raised or the month ends. */
  over: boolean;
  since: number;
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
  /** The model searched or opened a page with Drimvox's internet tools, or called an MCP tool ("server/tool"). */
  | { type: "tool"; name: string; input: string }
  /** An MCP tool waits for the user's permission; answered with POST /api/chats/:id/approvals/:id. */
  /** A tool asks first: an MCP server's tool, or (with reason) a command in the chat's folder. */
  | { type: "approval"; id: string; server: string; tool: string; input: unknown; reason?: string; purpose?: string }
  | { type: "approved"; id: string; allowed: boolean }
  | { type: "done"; message: MessageView };

/**
 * GET /api/chats/:id/follow: a window that comes back to a chat follows the answer being written, from what it has so
 * far (the snapshot) to the end, as it comes. Ends at once when nothing is being written.
 */
export type FollowEvent =
  | { type: "snapshot"; assistantMessageId: string; content: string; reasoning: string; activity: ActivityEntry[] }
  | StreamEvent;
