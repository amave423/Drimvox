import { z } from "zod";

const text = z.string().trim().min(1);

/**
 * How much a server the user switched on is trusted (asked for: no questions about what only reads): "ask" asks about
 * every tool, "changes" only about what changes or sends something, "trusted" about nothing.
 */
export const mcpTrusts = ["ask", "changes", "trusted"] as const;
export type McpTrust = (typeof mcpTrusts)[number];

/** An MCP server: a command Drimvox starts (stdio) or an address it connects to (Streamable HTTP). */
export const mcpServerCreateSchema = z
  .object({
    name: text.max(60),
    command: text.max(1000).optional(),
    args: z.array(z.string().max(2000)).max(50).default([]),
    /** Kept encrypted, like provider keys; the API returns only the names. */
    env: z.record(z.string().max(200), z.string().max(5000)).default({}),
    url: z.string().trim().url().max(2000).optional(),
    headers: z.record(z.string().max(200), z.string().max(5000)).default({}),
    trust: z.enum(mcpTrusts).default("changes"),
  })
  .strict()
  .refine((s) => !!s.command !== !!s.url, "Either a command or an address");

export const mcpServerUpdateSchema = z.object({ name: text.max(60).optional(), enabled: z.boolean().optional(), trust: z.enum(mcpTrusts).optional() }).strict();

export interface McpServerView {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command: string | null;
  args: string[];
  envKeys: string[];
  url: string | null;
  headerKeys: string[];
  enabled: boolean;
  trust: McpTrust;
  /** Tools the user allowed for good with "Always allow"; "*" is the whole server. */
  allowed: string[];
  createdAt: number;
}

export type McpStatus = { ok: true; tools: { name: string; description: string }[] } | { ok: false; error: string };

/** The user's answer to a permission request; `always` remembers it for this tool of this server. */
/** `server`: allow every tool of the call's MCP server from now on (seen: a browser server asked for each of its twenty tools). */
export const approvalDecisionSchema = z.object({ allow: z.boolean(), always: z.boolean().default(false), server: z.boolean().default(false) }).strict();
