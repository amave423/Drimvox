// A real MCP server over stdio for the tests: tools that read, ones that change something (told by their names or
// by the server's own hints), and one that reports what it was started with.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "demo", version: "1.0.0" });

server.registerTool("echo", { description: "Repeats the text", inputSchema: { text: z.string() } }, async ({ text }) => ({
  content: [{ type: "text", text: `echo: ${text}` }],
}));

server.registerTool("add", { description: "Adds two numbers", inputSchema: { a: z.number(), b: z.number() } }, async ({ a, b }) => ({
  content: [{ type: "text", text: String(a + b) }],
}));

server.registerTool("secret", { description: "Tells whether DEMO_TOKEN was given", inputSchema: {} }, async () => ({
  content: [{ type: "text", text: process.env.DEMO_TOKEN ? `token length ${process.env.DEMO_TOKEN.length}` : "no token" }],
}));

server.registerTool("list_notes", { description: "Lists the notes", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({
  content: [{ type: "text", text: "notes: none" }],
}));

server.registerTool("save_note", { description: "Saves a note", inputSchema: { text: z.string() } }, async ({ text }) => ({
  content: [{ type: "text", text: `saved: ${text}` }],
}));

// Named like a reader, but the server says it destroys.
server.registerTool("tidy", { description: "Tidies the notes away", inputSchema: {}, annotations: { destructiveHint: true } }, async () => ({
  content: [{ type: "text", text: "tidied" }],
}));

await server.connect(new StdioServerTransport());
