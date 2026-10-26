import type { McpStatus } from "@drimvox/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { jsonSchema, tool, type ToolSet } from "ai";
import type { McpRepo, McpServerConfig } from "./repo";

interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  /** The server's own word on what a tool does (MCP tool annotations). */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

/** Words in a tool's name that say it changes or sends something, when the server gives no hints. */
const CHANGES = /(^|[_\-.])(add|append|apply|approve|archive|assign|buy|cancel|clear|close|commit|create|delete|deploy|drop|edit|exec|execute|fork|insert|install|merge|modify|move|order|pay|post|publish|purchase|push|put|remove|rename|reply|reset|restore|revert|run|save|send|set|share|submit|transfer|update|upload|upsert|write)([_\-.]|$)/i;

/**
 * Whether a call needs the user's word (asked for: a server one switched on should not ask about what only reads):
 * "changes" asks about tools that change or send something — by the server's hints, else by the tool's name.
 */
export function needsAsking(trust: McpServerConfig["trust"], t: Pick<McpTool, "name" | "annotations">): boolean {
  if (trust === "trusted") return false;
  if (trust === "ask") return true;
  if (t.annotations?.destructiveHint === true) return true;
  if (t.annotations?.readOnlyHint === true) return false;
  return CHANGES.test(t.name);
}

interface Connection {
  version: number;
  client: Promise<Client>;
  tools: Promise<McpTool[]>;
}

/** Asks the user; true allows once, "always" also remembers the tool, "server" every tool of the server, false refuses. */
export type McpAsk = (call: { server: string; tool: string; input: unknown; signal?: AbortSignal }) => Promise<boolean | "always" | "server">;

export interface McpHooks {
  onCall(call: { callId: string; name: string; input: unknown }): void;
  onResult(result: { callId: string; name: string; ok: boolean; output: string }): void;
}

/** Kept as an allowed tool's name: every tool of the server is allowed. */
export const ALL_TOOLS = "*";
const CONNECT_MS = 20_000;
const CALL_MS = 120_000;
const MAX_OUTPUT = 20_000;

/** Connections to the user's MCP servers, opened when first needed and kept until the server changes. */
export class McpHub {
  private readonly connections = new Map<string, Connection>();

  constructor(private readonly repo: McpRepo) {}

  async status(id: string): Promise<McpStatus> {
    try {
      const tools = await this.connect(this.repo.config(id)).tools;
      return { ok: true, tools: tools.map((t) => ({ name: t.name, description: t.description ?? "" })) };
    } catch (err) {
      this.drop(id);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * The tools of every enabled server for a model. The first call of each tool asks the user unless they
   * allowed it for good; a server that cannot be reached simply adds nothing.
   */
  async toolsFor(ask: McpAsk, hooks: McpHooks): Promise<ToolSet> {
    const tools: ToolSet = {};
    for (const server of this.repo.enabled()) {
      let list: McpTool[];
      try {
        list = await this.connect(server).tools;
      } catch {
        this.drop(server.id);
        continue;
      }
      for (const t of list) {
        const name = toolName(server.name, t.name);
        const label = `${server.name}/${t.name}`;
        tools[name] = tool({
          description: `${t.description ?? t.name} (MCP server ${server.name})`,
          inputSchema: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
          execute: async (input: unknown, o: { toolCallId: string; abortSignal?: AbortSignal }) => {
            hooks.onCall({ callId: o.toolCallId, name: label, input });
            const done = (ok: boolean, output: string) => {
              hooks.onResult({ callId: o.toolCallId, name: label, ok, output: output.slice(0, 4000) });
              return output;
            };
            if (needsAsking(server.trust, t) && !this.repo.isAllowed(server.id, t.name)) {
              const answer = await ask({ server: server.name, tool: t.name, input, signal: o.abortSignal });
              if (!answer) return done(false, "The user did not allow this tool call. Do not retry it; do without it.");
              if (answer === "always") this.repo.allow(server.id, t.name);
              if (answer === "server") this.repo.allow(server.id, ALL_TOOLS);
            }
            try {
              const client = await this.connect(server).client;
              const result = (await client.callTool({ name: t.name, arguments: (input ?? {}) as Record<string, unknown> }, undefined, {
                timeout: CALL_MS,
                signal: o.abortSignal,
              })) as { content?: { type: string; text?: string; mimeType?: string }[]; isError?: boolean };
              const text = (result.content ?? [])
                .map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}${c.mimeType ? ` ${c.mimeType}` : ""}]`))
                .join("\n")
                .slice(0, MAX_OUTPUT);
              return done(!result.isError, text || "(empty result)");
            } catch (err) {
              return done(false, `Error: ${err instanceof Error ? err.message : String(err)}`);
            }
          },
        });
      }
    }
    return tools;
  }

  /** Closes every connection; stdio servers are stopped. */
  async shutdown(): Promise<void> {
    const all = [...this.connections.keys()];
    await Promise.all(all.map((id) => this.drop(id)));
  }

  private connect(server: McpServerConfig): Connection {
    const known = this.connections.get(server.id);
    if (known && known.version === server.version) return known;
    if (known) void this.drop(server.id);

    const client = (async () => {
      const c = new Client({ name: "Drimvox", version: "1.0.0" });
      const transport =
        server.transport === "stdio"
          ? new StdioClientTransport({
              command: server.command!,
              args: server.args,
              // The server gets the usual system variables plus its own; nothing else of Drimvox's environment.
              env: { ...getDefaultEnvironment(), ...server.env },
              stderr: "ignore",
            })
          : new StreamableHTTPClientTransport(new URL(server.url!), { requestInit: { headers: server.headers } });
      await withTimeout(c.connect(transport), CONNECT_MS, "The server did not answer in time");
      return c;
    })();
    const tools = client.then(async (c) => ((await c.listTools(undefined, { timeout: CONNECT_MS })).tools ?? []) as McpTool[]);
    // A failure is reported where it is awaited; this keeps it from counting as unhandled meanwhile.
    tools.catch(() => {});
    const connection = { version: server.version, client, tools };
    this.connections.set(server.id, connection);
    return connection;
  }

  private async drop(id: string): Promise<void> {
    const known = this.connections.get(id);
    this.connections.delete(id);
    if (!known) return;
    try {
      await (await known.client).close();
    } catch {
      // Already gone.
    }
  }
}

/** Tool names models accept: letters, digits, _ and -, at most 64. */
export function toolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return `mcp_${clean(server) || "server"}_${clean(tool) || "tool"}`.slice(0, 64);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
